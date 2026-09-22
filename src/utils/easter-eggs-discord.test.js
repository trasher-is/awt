// !42, !hail and !warp — the Discord eggs.
//
// They are jokes, which is exactly why they are tested: the numbers inside them are real,
// and an egg that quietly made statistics up would be a small lie sitting in a tool whose
// whole value is that its numbers are checkable. The other thing asserted here is that
// they stay out of the way — nothing is listed in !help, nothing pings anyone, and a
// player name chosen by another player cannot smuggle an @everyone through.
//
// Run with: node src/utils/easter-eggs-discord.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-eggs-test-')), 'test.db');
delete process.env.DISCORD_TOKEN;

const db = require(path.join(__dirname, '..', 'database.js'));
const bot = require(path.join(__dirname, '..', 'discord_bot.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('easter-eggs-discord.test.js');

function capture(content) {
    const replies = [];
    return {
        replies,
        message: {
            content, author: { bot: false, username: 'SyntheticUser' },
            channel: { id: 'synthetic-channel' },
            react: async () => {},
            reply: async (payload) => { replies.push(payload); },
        },
    };
}
const lastEmbed = (replies) => {
    const last = replies[replies.length - 1];
    return last && last.embeds ? last.embeds[0].toJSON() : null;
};
const lastText = (replies) => {
    const last = replies[replies.length - 1];
    return !last ? '' : typeof last === 'string' ? last : (last.content || '');
};

const HOUR = 3600 * 1000;
const NOW = Date.now();
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// Three battles, two owner changes, two systems — small enough that the numbers in the
// reply can be checked by eye rather than recomputed by the test.
const report = db.prepare(`INSERT INTO battle_reports (id, started_at, att_combat_value, def_combat_value, att_has_won) VALUES (?, ?, 10, 5, 1)`);
report.run(1, new Date(NOW - 5 * 24 * HOUR).toISOString());
report.run(2, new Date(NOW - 2 * 24 * HOUR).toISOString());
report.run(3, new Date(NOW - HOUR).toISOString());
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (1, 'One', 0, 0)`).run();
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (2, 'Two', 1, 1)`).run();
const ownerChange = db.prepare(`SELECT id FROM event_types WHERE name = 'OWNER_CHANGE'`).get().id;
const popDrop = db.prepare(`SELECT id FROM event_types WHERE name = 'POP_DROP'`).get().id;
const event = db.prepare(`INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp) VALUES (?, ?, ?, ?, ?, ?)`);
event.run(1, 1, ownerChange, null, 5, sqlTime(NOW - HOUR));
event.run(1, 2, ownerChange, 5, 6, sqlTime(NOW - HOUR));
event.run(1, 3, popDrop, 900, 100, sqlTime(NOW - HOUR));   // not an owner change
db.prepare(`INSERT INTO players (id, name, last_activity_at) VALUES (7, 'Awake', ?)`).run(new Date(NOW - 5 * 60 * 1000).toISOString());
db.prepare(`INSERT INTO player_login_samples (player_id, total_logins, observed_at) VALUES (7, 3, ?)`).run(sqlTime(NOW - HOUR));
db.prepare(`INSERT INTO players (id, name, last_activity_at) VALUES (8, 'Dozing', ?)`).run(new Date(NOW - 6 * HOUR).toISOString());
db.prepare(`INSERT INTO players (id, name, last_activity_at) VALUES (9, 'Gone', ?)`).run(new Date(NOW - 9 * 24 * HOUR).toISOString());
db.prepare(`INSERT INTO players (id, name) VALUES (10, 'Never seen')`).run();
db.prepare(`INSERT INTO players (id, name) VALUES (11, '@everyone')`).run();

(async () => {
    // --- !42 ---------------------------------------------------------------
    {
        const c = capture('!42');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        ok('!42 answers', !!embed && embed.title === '42', embed && embed.title);
        ok('it counts the battles it actually has', /\*\*3\*\* battles/.test(embed.description), embed.description);
        ok('it counts owner changes and not other planet events',
            /\*\*2\*\* planets seen changing hands/.test(embed.description), embed.description);
        ok('it counts the systems on file', /\*\*2\*\* systems/.test(embed.description), embed.description);
        ok('it reports how long it has been watching, from the oldest battle',
            /watching for \*\*5\*\* days/.test(embed.description), embed.description);
        ok('the joke is still the point', /Ultimate Question/.test(embed.description));

        const alias = capture('!answer');
        await bot.handleMessage(alias.message);
        ok('!answer is the same egg', lastEmbed(alias.replies).title === '42');
    }

    // --- !hail -------------------------------------------------------------
    {
        const none = capture('!hail');
        await bot.handleMessage(none.message);
        ok('!hail with no name asks who', /To whom/.test(lastText(none.replies)), lastText(none.replies));

        const missing = capture('!hail NotAPlayer');
        await bot.handleMessage(missing.message);
        ok('an unknown name is answered in character, not with an error',
            /no such vessel/.test(lastText(missing.replies)), lastText(missing.replies));

        const awake = capture('!hail Awake');
        await bot.handleMessage(awake.message);
        ok('someone active right now gets a response', /Response received/.test(lastEmbed(awake.replies).description), lastEmbed(awake.replies).description);
        ok('and the real last-activity time rides along as a Discord timestamp',
            /<t:\d+:R>/.test(lastEmbed(awake.replies).description), lastEmbed(awake.replies).description);

        const dozing = capture('!hail Dozing');
        await bot.handleMessage(dozing.message);
        ok('six hours idle is a faint carrier signal', /Faint carrier/.test(lastEmbed(dozing.replies).description), lastEmbed(dozing.replies).description);

        const gone = capture('!hail Gone');
        await bot.handleMessage(gone.message);
        ok('nine days idle gets no response', /No response/.test(lastEmbed(gone.replies).description), lastEmbed(gone.replies).description);

        const never = capture('!hail Never seen');
        await bot.handleMessage(never.message);
        ok('a player never seen active says so rather than inventing a time',
            /never caught them/.test(lastEmbed(never.replies).description), lastEmbed(never.replies).description);

        // A player name is chosen by another player. The egg posts it, so it goes through
        // the same mention defuser every other posted name does.
        const nasty = capture('!hail @everyone');
        await bot.handleMessage(nasty.message);
        const posted = JSON.stringify(lastEmbed(nasty.replies));
        ok('a player called @everyone cannot ping the channel through this',
            !/[^\u200b]@everyone/.test(posted.replace(/\\u200b/g, '\u200b')), posted);
    }

    // --- !warp -------------------------------------------------------------
    {
        const good = capture('!warp 9');
        await bot.handleMessage(good.message);
        const embed = lastEmbed(good.replies);
        ok('!warp answers with the factor asked for', embed.title === '🚀 Warp 9', embed.title);
        // 9^(10/3) = 1516.4 on the original-series scale; the joke only works if the
        // number is the real one.
        ok('the speed is the original-series formula, not a made-up number',
            /\*\*1516\.4×\*\*/.test(embed.description), embed.description);
        ok('the real travel time comes from the shared model',
            /takes a standing fleet \*\*\d+:\d\d:\d\d\*\*/.test(embed.description), embed.description);

        for (const bad of ['!warp 10', '!warp 0', '!warp -3', '!warp banana', '!warp']) {
            const c = capture(bad);
            await bot.handleMessage(c.message);
            ok(`${bad} is refused with the usage line`, /warp 1 to 9\.9/.test(lastText(c.replies)), { bad, got: lastText(c.replies) });
        }
    }

    // --- They stay out of the way ------------------------------------------
    {
        const help = capture('!help');
        await bot.handleMessage(help.message);
        const embed = lastEmbed(help.replies);
        const names = embed.fields.map(f => f.name).join(' ');
        ok('no egg is listed in !help — they are eggs', !/!42|!hail|!warp/.test(names), names);
        ok('but !help hints that they exist, so they are findable',
            /not everything/.test(embed.footer.text), embed.footer && embed.footer.text);
    }

    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
