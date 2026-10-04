// !help — the short index and `!help <command>`.
//
// The index replaced a 25-field embed that had every description inline. What is asserted
// here is what kept it from drifting before: every command the bot answers to is listed
// (eggs excepted), the index stays short enough to read on a phone, and the full text is
// still one `!help <command>` away.
//
// Run with: node src/utils/discord-help.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
// Before database.js is required — see the note in discord.test.js.
process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-help-test-')), 'test.db');
delete process.env.DISCORD_TOKEN;

require(path.join(__dirname, '..', 'database.js'));
const bot = require(path.join(__dirname, '..', 'discord_bot.js'));
const { buildHelp, helpEntries } = require(path.join(__dirname, '..', 'discord-help.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('discord-help.test.js');

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
const embedChars = (e) => (e.title || '').length + (e.description || '').length
    + (e.footer ? e.footer.text.length : 0)
    + (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);

const margins = { bioConfirmed: 2, bioSuspected: 3 };
const allNames = helpEntries(margins).flatMap(g => g.items).flatMap(e => e.names);

(async () => {
    // --- Nothing the bot answers to goes missing from help ------------------
    {
        const src = fs.readFileSync(path.join(__dirname, '..', 'discord_bot.js'), 'utf8');
        const handled = new Set([...src.matchAll(/command === '([a-z0-9]+)'/g)].map(m => m[1]));
        const raw = src.match(/RAW_LEADERBOARD_COMMANDS = \[([^\]]+)\]/);
        if (raw) for (const m of raw[1].matchAll(/'([a-z0-9]+)'/g)) handled.add(m[1]);
        const EGGS = new Set(['42', 'answer', 'hail', 'warp']);
        const missing = [...handled].filter(c => c !== 'help' && !EGGS.has(c) && !allNames.includes(c));
        ok('every handled command is reachable through !help', missing.length === 0, missing);
        ok('the source scan found the commands it should', handled.has('battle') && handled.has('cvkillsweek'), [...handled]);
        ok('!price is no longer a command', !handled.has('price'));
        ok('no egg is in the help data', !allNames.some(n => EGGS.has(n)));
        ok('no name is claimed by two entries', new Set(allNames).size === allNames.length);
    }

    // --- The index is short --------------------------------------------------
    {
        const c = capture('!help');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        const lines = embed.fields.flatMap(f => f.value.split('\n'));
        ok('the index is a handful of groups, not a field per command', embed.fields.length <= 8, embed.fields.length);
        ok('the index is under 1,600 characters (the old one was ~5,000)', embedChars(embed) < 1600, embedChars(embed));
        const long = lines.filter(l => l.length > 55);
        ok('every index line fits a phone-width embed', long.length === 0, long);
        ok('the index says !help <command> gives deeper help', /!help <command>` shows deeper help/.test(embed.description), embed.description);
        ok('the egg hint footer survives', /not everything/.test(embed.footer.text));
        const index = embed.fields.map(f => f.value).join(' ');
        ok('!glory (RAID-only) and !bio (partial) are not in the index', !/`!glory`|`!bio`/.test(index), index);
        ok('!price is gone', !/!price/.test(index));
        ok('the index still has the commands around them', /`!battle`/.test(index) && /`!mortal`/.test(index) && /`!research`/.test(index));
    }
    {
        const c = capture('!help glory');
        await bot.handleMessage(c.message);
        ok('a hidden command still has its !help page', /!glory/.test(lastEmbed(c.replies).title));
    }
    {
        const c = capture('!price 4200 1800');
        await bot.handleMessage(c.message);
        ok('!price no longer answers', c.replies.length === 0, c.replies);
    }

    // --- !help <command> ------------------------------------------------------
    {
        const c = capture('!help battle');
        await bot.handleMessage(c.message);
        const embed = lastEmbed(c.replies);
        ok('!help battle shows the syntax', /!battle <D> <C> <B> vs/.test(embed.title), embed.title);
        ok('!help battle keeps the full flag list', /--sb N/.test(embed.description) && /--def Name/.test(embed.description), embed.description);
        ok('!help battle has an example', embed.fields.some(f => f.name === 'Example' && /!battle 50 10 0/.test(f.value)), embed.fields);
    }
    {
        const h = buildHelp('!mortalweek', margins);
        ok('a variant name with its ! finds the family entry', /!mortal/.test(h.title), h.title);
        ok('the variants are listed under Also', h.fields.some(f => f.name === 'Also' && /!mortalday/.test(f.value)), h.fields);
        ok('lookup ignores case', buildHelp('BIO', margins).title.includes('!bio'));
        ok('the bio margins reach the text', /\+2 confirmed/.test(buildHelp('bio', margins).description) && /\+3 science/.test(buildHelp('bio', margins).description));
    }
    {
        const h = buildHelp('nosuch', margins);
        ok('an unknown command says so and points back at !help', /No command called `!nosuch`/.test(h.description), h.description);
    }

    // --- Discord embed limits, for every page ---------------------------------
    {
        const pages = [buildHelp('', margins), ...allNames.map(n => buildHelp(n, margins))];
        const bad = pages.filter(p => p.title.length > 256 || p.description.length > 4096
            || p.fields.length > 25 || p.fields.some(f => f.name.length > 256 || f.value.length > 1024)
            || embedChars(p) > 6000);
        ok('every help page is within Discord\'s embed limits', bad.length === 0, bad.map(p => p.title));
    }

    // --- /help ---------------------------------------------------------------
    {
        const fake = (opts = {}) => ({
            commandName: 'help',
            options: {
                getSubcommand: () => null,
                getString: (k) => (opts[k] === undefined ? null : opts[k]),
                getInteger: () => null,
                getNumber: () => null,
            },
        });
        ok('/help maps onto !help', bot.slashToPrefix(fake()) === '!help');
        ok('/help command:battle maps onto !help battle', bot.slashToPrefix(fake({ command: 'battle' })) === '!help battle');
    }

    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
