// Discord: persisted timers, verified account linking, and the slash-command surface.
//
// Run with:  node src/utils/discord.test.js
//
// No Discord connection is needed — everything with logic in it (storing a timer,
// deciding whether a link code may be spent, mapping a slash invocation onto its !
// equivalent) runs against the database and plain objects.

const path = require('path');
const db = require(path.join(__dirname, '..', 'database.js'));
const bot = require(path.join(__dirname, '..', 'discord_bot.js'));
const { buildCommands, isEphemeral } = require(path.join(__dirname, '..', 'discord-commands.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const capture = () => { const out = []; return { out, reply: (t) => { out.push(typeof t === 'string' ? t : JSON.stringify(t)); return Promise.resolve(); } }; };

(async () => {
    // Isolated fixtures. Ids are far above anything a real install would reach.
    db.exec(`DELETE FROM discord_timers WHERE discord_user_id LIKE 'test-%'`);
    db.exec(`DELETE FROM discord_link_codes WHERE code LIKE 'TEST%'`);
    db.exec(`DELETE FROM app_users WHERE game_name LIKE 'zz-test-%'`);
    const mk = db.prepare(`INSERT INTO app_users (game_name, password_hash, role, discord_id) VALUES (?, 'x', 'user', ?)`);
    const unlinkedId = mk.run('zz-test-unlinked', null).lastInsertRowid;
    const linkedId = mk.run('zz-test-linked', 'test-someone-else').lastInsertRowid;

    // ─── #17 TIMERS SURVIVE A RESTART ─────────────────────────────────────────
    console.log('── Timers are stored, not held in memory ' + '─'.repeat(35));

    let c = capture();
    await bot.handleTimer({ input: '10 mins', userId: 'test-user-1', channelId: 'test-chan', reply: c.reply });
    const stored = db.prepare(`SELECT * FROM discord_timers WHERE discord_user_id = 'test-user-1'`).get();
    ok('the timer is written to the database', !!stored, stored);
    ok('with the right channel', stored && stored.channel_id === 'test-chan');
    ok('with the label the user typed', stored && stored.label === '10 mins');
    ok('due roughly ten minutes out',
        stored && Math.abs(new Date(stored.due_at).getTime() - (Date.now() + 600000)) < 5000);
    ok('and it has not fired yet', stored && stored.fired_at === null);
    ok('the acknowledgement no longer claims timers are lost on restart',
        !/memory|restart clears/i.test(c.out.join(' ')), c.out);
    ok('and it states the real resolution instead of implying seconds',
        /within a minute/i.test(c.out.join(' ')), c.out);

    console.log('\n── A timer that came due while the bot was down still fires ' + '─'.repeat(16));
    // Exactly the restart case: the row exists and its due time has passed.
    db.prepare(`UPDATE discord_timers SET due_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 20 * 60000).toISOString(), stored.id);
    await bot.checkDueTimers();   // no client connection: the send fails, the row must still be settled
    const after = db.prepare(`SELECT fired_at FROM discord_timers WHERE id = ?`).get(stored.id);
    ok('an overdue timer is marked fired on the next tick', after.fired_at !== null, after);
    ok('so it cannot fire again in a loop',
        db.prepare(`SELECT COUNT(*) c FROM discord_timers WHERE fired_at IS NULL AND discord_user_id='test-user-1'`).get().c === 0);

    console.log('\n── Timer input rules ' + '─'.repeat(54));
    ok('"10mins" parses', bot.parseTimerInput('10mins') === 600000);
    ok('"1h 8m" parses', bot.parseTimerInput('1h 8m') === (60 + 8) * 60000);
    ok('garbage is rejected', bot.parseTimerInput('soonish') === null);
    c = capture();
    await bot.handleTimer({ input: '40000 mins', userId: 'test-user-2', channelId: 'test-chan', reply: c.reply });
    ok('the 14-day cap is still enforced', /14 days/.test(c.out.join(' ')), c.out);
    ok('and nothing is stored for a rejected timer',
        db.prepare(`SELECT COUNT(*) c FROM discord_timers WHERE discord_user_id='test-user-2'`).get().c === 0);
    c = capture();
    await bot.handleTimer({ input: '', userId: 'test-user-3', channelId: 'test-chan', reply: c.reply });
    ok('an empty timer explains the usage', /Usage/.test(c.out.join(' ')), c.out);

    // ─── #18 LINKING REQUIRES A CODE ──────────────────────────────────────────
    console.log('\n── Linking by name alone is gone ' + '─'.repeat(42));

    c = capture();
    await bot.handleLink({ code: 'zz-test-unlinked', userId: 'test-attacker', username: 'attacker', tag: 'attacker#1', reply: c.reply });
    ok('presenting an account NAME no longer links anything', /not valid/i.test(c.out.join(' ')), c.out);
    ok('and the account is still unlinked',
        db.prepare(`SELECT discord_id FROM app_users WHERE id = ?`).get(unlinkedId).discord_id === null);

    c = capture();
    await bot.handleLink({ code: '', userId: 'test-newcomer', username: 'newcomer', tag: 'newcomer#1', reply: c.reply });
    ok('with no code the bot explains where to get one', /Hub/.test(c.out.join(' ')) && /code/i.test(c.out.join(' ')), c.out);

    console.log('\n── A valid code links, once ' + '─'.repeat(47));
    const mint = (userId, code, ttlMs = 600000) => db.prepare(
        `INSERT INTO discord_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)`
    ).run(code, userId, new Date(Date.now() + ttlMs).toISOString());

    mint(unlinkedId, 'TESTGOOD');
    c = capture();
    await bot.handleLink({ code: 'testgood', userId: 'test-owner', username: 'owner', tag: 'owner#1', reply: c.reply });
    ok('a valid code links the account (and is case-insensitive)',
        db.prepare(`SELECT discord_id FROM app_users WHERE id = ?`).get(unlinkedId).discord_id === 'test-owner', c.out);
    ok('the code is marked spent',
        db.prepare(`SELECT used_at, used_by_discord_id FROM discord_link_codes WHERE code='TESTGOOD'`).get().used_at !== null);

    c = capture();
    await bot.handleLink({ code: 'TESTGOOD', userId: 'test-thief', username: 'thief', tag: 'thief#1', reply: c.reply });
    ok('the same code cannot be spent twice', /already been used/i.test(c.out.join(' ')), c.out);

    console.log('\n── Codes that must not work ' + '─'.repeat(47));
    db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('zz-test-expired-owner','x','user')`).run();
    const expiredOwner = db.prepare(`SELECT id FROM app_users WHERE game_name='zz-test-expired-owner'`).get().id;
    db.prepare(`INSERT INTO discord_link_codes (code, user_id, expires_at) VALUES ('TESTOLD', ?, ?)`)
        .run(expiredOwner, new Date(Date.now() - 60000).toISOString());
    c = capture();
    await bot.handleLink({ code: 'TESTOLD', userId: 'test-late', username: 'late', tag: 'late#1', reply: c.reply });
    ok('an expired code is refused', /not valid|expired/i.test(c.out.join(' ')), c.out);
    ok('and the account it belonged to stays unlinked',
        db.prepare(`SELECT discord_id FROM app_users WHERE id = ?`).get(expiredOwner).discord_id === null);

    mint(linkedId, 'TESTTAKEN');
    c = capture();
    await bot.handleLink({ code: 'TESTTAKEN', userId: 'test-hijacker', username: 'hijacker', tag: 'hijacker#1', reply: c.reply });
    ok('a code cannot take over an account already linked elsewhere', /already linked/i.test(c.out.join(' ')), c.out);
    ok('and that account keeps its original Discord id',
        db.prepare(`SELECT discord_id FROM app_users WHERE id = ?`).get(linkedId).discord_id === 'test-someone-else');

    c = capture();
    await bot.handleLink({ code: 'NOSUCHCODE', userId: 'test-guess', username: 'guess', tag: 'guess#1', reply: c.reply });
    ok('an invented code is refused', /not valid/i.test(c.out.join(' ')), c.out);

    console.log('\n── The passive auto-link is gone ' + '─'.repeat(42));
    // A backfill used to write the caller's Discord id onto any account whose stored
    // discord_name matched their username — an automatic link with no proof, which
    // silently defeated the code challenge.
    const fs = require('fs');
    const stripComments = (text) => text
        .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    // The discord_id write path moved out of discord_bot.js into repositories/users.js
    // (updateUserDiscordLink). Scan both files so this check still verifies the real
    // property: exactly one write path for discord_id, wherever it lives.
    const src = [
        stripComments(fs.readFileSync(path.join(__dirname, '..', 'discord_bot.js'), 'utf8')),
        stripComments(fs.readFileSync(path.join(__dirname, '..', 'repositories', 'users.js'), 'utf8')),
    ].join('\n');
    ok('no code writes discord_id from a username match',
        !/UPDATE app_users SET discord_id[\s\S]{0,200}LOWER\(discord_name\)/.test(src));
    // "= ?" (a real, parameterised value) excludes admin.js's unlink path
    // (clearUserDiscordFields, now also in users.js), which sets discord_id = NULL and
    // was never in scope here — clearing a link grants nothing, so it isn't the
    // vulnerability this check guards against.
    ok('discord_id is only ever written by the verified link path',
        (src.match(/UPDATE app_users SET discord_id = \?/g) || []).length === 1,
        (src.match(/UPDATE app_users SET discord_id/g) || []).length);

    // ─── #16 SLASH COMMANDS ───────────────────────────────────────────────────
    console.log('\n── Slash commands stay usable on a phone ' + '─'.repeat(34));
    const cmds = buildCommands().map(c2 => c2.toJSON());
    ok('the top level is 7 entries, not 14', cmds.length === 7, cmds.length);
    ok('the grouped ones carry subcommands',
        cmds.filter(c2 => (c2.options || []).some(o => o.type === 1)).length === 4,
        cmds.map(c2 => c2.name));
    const autocompletes = cmds.flatMap(c2 => (c2.options || []).flatMap(o => (o.options || []).filter(x => x.autocomplete)));
    ok('player and system arguments autocomplete', autocompletes.length >= 12, autocompletes.length);
    ok('a link code is never posted to the channel', isEphemeral('link') === true);
    ok('calculator output is ephemeral', isEphemeral('calc', 'battle') === true);
    ok('shared intel is not ephemeral', isEphemeral('scan', 'holes') === false);

    console.log('\n── Slash and ! reach the same code ' + '─'.repeat(41));
    const fake = (name, sub, opts = {}) => ({
        commandName: name,
        options: {
            getSubcommand: () => sub,
            getString: (k) => (opts[k] === undefined ? null : String(opts[k])),
            getInteger: (k) => (opts[k] === undefined ? null : Number(opts[k])),
        },
    });
    const cases = [
        [fake('intel', 'player', { player: 'Trasher' }), '!intel Trasher'],
        [fake('intel', 'system', { system: '137' }), '!sys 137'],
        [fake('intel', 'bio'), '!bio'],
        [fake('intel', 'alliance'), '!intels'],
        [fake('calc', 'distance', { from: '10', to: '20' }), '!dist 10 20'],
        // The assertion here used to be '!tt 10 20 9 2' — it encoded the bug rather than
        // catching it. !tt reads sysA planetA sysB planetB speed energy, so that string
        // put the destination system into planetA and the energy into sysB.
        [fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7, speed: 2, energy: 9 }), '!tt 10 1 20 7 2 9'],
        [fake('calc', 'battle', { defender: '1000 0 0', attacker: '0 125 0', starbase: 5 }), '!battle 1000 0 0 vs 0 125 0 --sb 5'],
        [fake('plan', 'add', { system: '137', planet: 4, note: 'hit this' }), '!plan 137 4 hit this'],
        [fake('scan', 'holes'), '!holes'],
        [fake('scan', 'vision', { system: '137' }), '!vision 137'],
        [fake('scan', 'ghosts', { system: '137', planet: 4, tag: 'RED' }), '!ghosts 137 4 RED'],
    ];
    for (const [interaction, want] of cases) {
        const got = bot.slashToPrefix(interaction);
        ok(`/${interaction.commandName} ${interaction.options.getSubcommand()} -> "${want}"`, got === want, got);
    }
    ok('an unmapped command returns null rather than guessing',
        bot.slashToPrefix(fake('nonsense', 'nope')) === null);

    console.log('\n── /calc travel asks for everything the answer depends on ' + '─'.repeat(18));
    // Travel time depends on the planet at each end — the formula adds
    // sqrt(|Δplanet| + 1) to every hop — so a subcommand that only took two systems could
    // not produce a correct answer even in principle.
    const travel = cmds.find(c2 => c2.name === 'calc').options.find(o => o.name === 'travel');
    const optNames = travel.options.map(o => o.name);
    for (const need of ['from', 'from_planet', 'to', 'to_planet']) {
        ok(`travel takes ${need}`, optNames.includes(need), optNames);
    }
    const required = travel.options.filter(o => o.required).map(o => o.name);
    ok('all four route arguments are required',
        ['from', 'from_planet', 'to', 'to_planet'].every(n => required.includes(n)), required);
    ok('the two systems are still ordered before their planets, matching !tt',
        optNames.indexOf('from') < optNames.indexOf('from_planet')
        && optNames.indexOf('from_planet') < optNames.indexOf('to')
        && optNames.indexOf('to') < optNames.indexOf('to_planet'), optNames);

    const planetOpts = travel.options.filter(o => o.name.endsWith('_planet'));
    ok('planet indexes are bounded to the 1-12 the game has',
        planetOpts.every(o => o.min_value === 1 && o.max_value === 12), planetOpts.map(o => [o.min_value, o.max_value]));
    ok('and they are not autocompleted — twelve numbers in a dropdown is slower than typing one',
        planetOpts.every(o => !o.autocomplete));

    const playerOpt = travel.options.find(o => o.name === 'player');
    ok('travel can take stats from a player, the way !tt always could', !!playerOpt);
    ok('that player field autocompletes', playerOpt && playerOpt.autocomplete === true);
    ok('and it is optional, because the manual form still exists', playerOpt && !playerOpt.required);

    console.log('\n── ...and hands !tt its arguments in the order it reads them ' + '─'.repeat(15));
    ok('semi-manual: a player name goes last, replacing the two numbers',
        bot.slashToPrefix(fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7, player: 'Elfenlied' }))
        === '!tt 10 1 20 7 Elfenlied');
    ok('a player name with spaces stays one argument — !tt joins from the fifth onwards',
        bot.slashToPrefix(fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7, player: 'Dark Star' }))
        === '!tt 10 1 20 7 Dark Star');
    ok('a player wins over speed and energy rather than producing seven arguments',
        bot.slashToPrefix(fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7, player: 'Chewie', speed: 3, energy: 4 }))
        === '!tt 10 1 20 7 Chewie');
    // !tt only takes its manual branch when BOTH the fifth and sixth arguments are
    // numbers. Emitting just one would be read as a player name called "2".
    ok('speed alone still emits both numbers',
        bot.slashToPrefix(fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7, speed: 2 }))
        === '!tt 10 1 20 7 2 0');
    ok('energy alone still emits both numbers',
        bot.slashToPrefix(fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7, energy: 9 }))
        === '!tt 10 1 20 7 0 9');
    ok('neither given falls back to zeros, which is what an unset profile means',
        bot.slashToPrefix(fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7 }))
        === '!tt 10 1 20 7 0 0');
    ok('a negative race speed survives, since -4..4 is the real range',
        bot.slashToPrefix(fake('calc', 'travel', { from: '10', from_planet: 1, to: '20', to_planet: 7, speed: -3, energy: 0 }))
        === '!tt 10 1 20 7 -3 0');

    // What !tt itself requires, asserted against its own usage rules rather than trusted.
    for (const [label, opts] of [
        ['manual', { from: '10', from_planet: 1, to: '20', to_planet: 7, speed: 2, energy: 9 }],
        ['semi-manual', { from: '10', from_planet: 1, to: '20', to_planet: 7, player: 'Chewie' }],
    ]) {
        const emitted = bot.slashToPrefix(fake('calc', 'travel', opts));
        const args = emitted.slice(1).trim().split(/ +/).slice(1);   // strip "!tt"
        ok(`${label}: passes !tt's own arity check (>= 5 arguments)`, args.length >= 5, args);
        ok(`${label}: the first four parse as numbers, as !tt requires`,
            args.slice(0, 4).every(a => Number.isInteger(parseInt(a, 10))), args.slice(0, 4));
    }

    console.log('\n── Autocomplete answers the right list ' + '─'.repeat(37));
    // The router used to match option names by substring: /system|from|to/ would have
    // claimed "to_planet" the moment one existed and offered solar systems for a planet
    // index.
    ok('system-valued option names are matched exactly, not by substring',
        bot.SYSTEM_OPTION_NAMES.has('to') && !bot.SYSTEM_OPTION_NAMES.has('to_planet'));
    const autocompletedNames = new Set(cmds.flatMap(c2 =>
        (c2.options || []).flatMap(o => (o.options || []).filter(x => x.autocomplete).map(x => x.name))));
    for (const name of bot.SYSTEM_OPTION_NAMES) {
        ok(`"${name}" is an option the command tree actually declares`, autocompletedNames.has(name), [...autocompletedNames]);
    }
    const playerish = [...autocompletedNames].filter(n => !bot.SYSTEM_OPTION_NAMES.has(n));
    ok('every other autocompleted option is a player field, so the fallback is correct',
        playerish.every(n => /player/.test(n)), playerish);

    // cleanup
    db.exec(`DELETE FROM discord_timers WHERE discord_user_id LIKE 'test-%'`);
    db.exec(`DELETE FROM discord_link_codes WHERE code LIKE 'TEST%' OR code = 'NOSUCHCODE'`);
    db.exec(`DELETE FROM app_users WHERE game_name LIKE 'zz-test-%'`);

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
