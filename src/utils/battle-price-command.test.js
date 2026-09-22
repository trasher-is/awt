// !price / /calc price — the Discord surface over src/utils/battle-ledger.js.
//
// The arithmetic is covered by battle-ledger.test.js. What is checked here is what a
// member actually receives: that the table reaches Discord, that a ratio nobody has fought
// at is refused rather than answered, and that `!price check` reports on the stored
// win_chance column instead of quietly agreeing with a comment.
//
// Run with: node src/utils/battle-price-command.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
// Before database.js is required — see the note in discord.test.js about a test run that
// fired a migration against production.
process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-battle-price-test-')), 'test.db');
delete process.env.DISCORD_TOKEN;

const db = require(path.join(__dirname, '..', 'database.js'));
const bot = require(path.join(__dirname, '..', 'discord_bot.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('battle-price-command.test.js');

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
    if (!last) return '';
    return typeof last === 'string' ? last : (last.content || '');
};

const insert = db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_combat_value, def_combat_value, att_has_won,
        att_pct_cv_lost, def_pct_cv_lost, att_lost_cv, def_lost_cv, win_chance, random_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

(async () => {
    // An empty archive must say so rather than print a table of dashes.
    {
        const c = capture('!price');
        await bot.handleMessage(c.message);
        ok('an empty archive is stated, not tabulated', /nothing to price/.test(lastText(c.replies)), lastText(c.replies));
    }

    // Synthetic archive, same shape as the live one: hopeless below parity, certain and
    // progressively cheaper above it. Every row is invented — no captured report is copied
    // into this repository.
    let id = 1;
    const add = (att, def, won, attPct, roll) => insert.run(
        id++, '2026-09-01T12:00:00+02:00', att, def, won ? 1 : 0, attPct, won ? 100 : 20,
        Math.round(att * attPct / 100), won ? def : Math.round(def * 0.2), roll, roll);
    for (let i = 0; i < 20; i++) add(50, 100, false, 100, (i * 37) % 100);
    for (let i = 0; i < 10; i++) add(200, 100, true, 40, (i * 53) % 100);
    for (let i = 0; i < 10; i++) add(2000, 100, true, 3, (i * 17) % 100);

    {
        const c = capture('!price');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        ok('the table comes back as an embed', !!embed, lastText(c.replies));
        ok('every band is a row', embed && (embed.description.match(/\n(under|\d)/g) || []).length >= 7, embed && embed.description);
        ok('the price column is there, not just the win rate', embed && /40\.0%/.test(embed.description), embed && embed.description);
        ok('the footer states how many battles the answer rests on', embed && /40 recorded battles/.test(embed.footer.text), embed && embed.footer);
        ok('the summary names the ratio above which nobody has lost', embed && /1\.6x/.test(embed.description), embed && embed.description);
    }

    {
        const c = capture('!price 400 100');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        ok('two combat values are read as an attack', embed && /4\.00x/.test(embed.description), embed && embed.description);
        ok('a ratio with no recorded battle is refused, not interpolated',
            embed && /cannot answer/.test(embed.description), embed && embed.description);
    }

    {
        const c = capture('!price 2');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        ok('a single number is read as a ratio', embed && /2\.00x/.test(embed.description), embed && embed.description);
        ok('a well-populated ratio quotes the price', embed && /lose about 40%/.test(embed.description), embed && embed.description);
    }

    {
        const c = capture('!price check');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        ok('the check answers with its own embed', !!embed && /win_chance/.test(embed.title), embed && embed.title);
        ok('the check reports both Brier scores so the comparison is visible',
            embed && /Brier score of the stored column/.test(embed.description) && /base rate/.test(embed.description),
            embed && embed.description);
        ok('a column that is really the dice roll is reported as not a probability',
            embed && /Behaves like a probability: \*\*no\*\*/.test(embed.description), embed && embed.description);
        ok('the check says how often the column equals random_number',
            embed && /identical in \*\*100%\*\*/.test(embed.description), embed && embed.description);
    }

    // The slash twin must land on the same handler, and a half-filled form must not be
    // read as a ratio the member did not ask about.
    const fake = (sub, opts = {}) => ({
        commandName: 'calc',
        options: {
            getSubcommand: () => sub,
            getString: (k) => (opts[k] === undefined ? null : String(opts[k])),
            getInteger: (k) => (opts[k] === undefined ? null : Number(opts[k])),
            getNumber: (k) => (opts[k] === undefined ? null : Number(opts[k])),
        },
    });
    ok('/calc price with both values maps onto !price', bot.slashToPrefix(fake('price', { your_cv: 4200, their_cv: 1800 })) === '!price 4200 1800',
        bot.slashToPrefix(fake('price', { your_cv: 4200, their_cv: 1800 })));
    ok('/calc price with one value asks for the table rather than guessing a ratio',
        bot.slashToPrefix(fake('price', { your_cv: 4200 })) === '!price', bot.slashToPrefix(fake('price', { your_cv: 4200 })));
    ok('/calc price with nothing asks for the table', bot.slashToPrefix(fake('price')) === '!price');
    ok('a fractional combat value survives the slash round trip',
        bot.slashToPrefix(fake('price', { your_cv: 1.5, their_cv: 1 })) === '!price 1.5 1');

    // The help text is the only place a member finds out this exists.
    {
        const c = capture('!help');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        ok('!price is listed in !help', embed && embed.fields.some(f => f.name.includes('!price')), embed && embed.fields.map(f => f.name));
    }

    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
