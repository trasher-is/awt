// Complete alliance radar rosters with missing origins, science and coordinates.
// The real handlers and repositories run against a fresh synthetic SQLite database;
// replies are plain captures and no Discord client is connected.
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-vision-roster-'));
process.env.AWT_DB_PATH = path.join(testDir, 'test.db');
const db = require('../database');
const players = require('../repositories/players');
const bot = require('../discord_bot');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
function capture(content) {
    const replies = [];
    return {
        replies, message: {
            content, author: { bot: false, username: 'SyntheticUser' }, channel: { id: 'synthetic-channel' },
            reply: async payload => { replies.push(payload); }
        }
    };
}
const data = replies => replies.flatMap(reply => reply.embeds || []).map(embed => embed.toJSON());
const fieldText = (embeds, prefix) => embeds.flatMap(embed => embed.fields || [])
    .filter(field => field.name.startsWith(prefix)).map(field => field.value).join('\n');
const totalText = embeds => embeds.flatMap(embed => embed.fields || []).map(field => field.value).join('\n');

async function main() {
    console.log('discord-vision-roster.test.js');
    try {
        db.exec(`
            INSERT INTO alliances (id, tag, name) VALUES (1, 'SYN', 'Synthetic Alliance'), (2, 'UNK', 'Unknowns'), (3, 'OUT', 'Far Away'), (4, 'BIG', 'Large Synthetic Roster');
            INSERT INTO systems (id, name, x, y) VALUES
                (101, 'Origin', 0, 0), (102, 'Distant', 100, 100), (103, 'Missing X', NULL, 0),
                (104, 'Target', 3, 4), (105, 'Invalid X', 'not-a-coordinate', 0), (106, 'Blank X', ' ', 0);
        `);
        const addPlayer = db.prepare('INSERT INTO players (id, name, alliance_id, origin_system, biology, science_level, energy, race_speed) VALUES (?, ?, ?, ?, ?, ?, 5, 0)');
        const fixtures = [
            [1, 'Member001', 1, 101, 5, 9],
            [2, 'Member002', 1, 102, 1, 9],
            [3, 'Member003', 1, null, 7, 7],
            [4, 'Member004', 1, 0, 7, 7],
            [5, 'Member005', 1, -2, 7, 7],
            [6, 'Member006', 1, 999, 7, 7],
            [7, 'Member007', 1, 103, 7, 7],
            [8, 'Member008', 1, 101, null, 9],
            [9, 'Member009', 1, 101, null, null],
            [10, 'Member010', 1, 101, 0, 4],
            [11, 'Member011', 1, 105, 7, 7],
            [12, 'Member012', 1, 106, 7, 7],
            [13, 'Member013', 1, 101, 'invalid', 0]
        ];
        fixtures.forEach(row => addPlayer.run(...row));
        addPlayer.run(21, 'UnknownOrigin', 2, null, 8, 8);
        addPlayer.run(22, 'UnknownCoords', 2, 103, 8, 8);
        addPlayer.run(31, 'KnownOut', 3, 102, 1, 1);

        const brief = players.getAllianceOriginPlayersBrief('SYN');
        const detailed = players.getAllianceOriginPlayersDetailed('SYN');
        ok('brief roster includes every known alliance member regardless of origin', brief.length === fixtures.length && fixtures.every(row => brief.some(player => player.id === row[0])));
        ok('detailed roster retains the same members for the ghost forecast', detailed.length === fixtures.length && fixtures.every(row => detailed.some(player => player.id === row[0])));
        ok('an unmapped origin keeps its original ID with missing joined coordinates', brief.find(player => player.id === 6).origin_system === 999 && brief.find(player => player.id === 6).mapped_origin_system === null && brief.find(player => player.id === 6).x === null);
        ok('nullable biology remains null rather than a SQL zero', brief.find(player => player.id === 8).biology === null);
        const observers = players.getVisionObservers(fixtures.map(row => row[0]));
        ok('the map observer query still excludes missing coordinates and preserves valid zero coordinates', !observers.some(player => player.playerId === 7) && observers.some(player => player.playerId === 1 && player.x === 0 && player.y === 0));

        let c = capture('!vision 104 SYN');
        await bot.handleMessage(c.message);
        let embeds = data(c.replies);
        const inVision = fieldText(embeds, '✅ In Vision');
        const outOfRange = fieldText(embeds, '❌ Out of Range');
        const unknown = fieldText(embeds, '❓ Unknown');
        ok('known origin at (0,0) retains the exact distance-five boundary', inVision.includes('Member001 (Has: **5** / Needs: **5**)'));
        ok('valid biology determines out-of-range status even with higher science', outOfRange.includes('Member002 (Has: **1**'));
        ok('positive science fallback remains available and is explicitly estimated', inVision.includes('Member008 (Has: **9**') && inVision.includes('estimated from science level') && outOfRange.includes('Member010 (Has: **4**'));
        ok('missing, zero and negative origins are explicitly Unknown', [3, 4, 5].every(id => unknown.includes(`Member${String(id).padStart(3, '0')} — no valid origin system scanned`)));
        ok('unmapped and missing/invalid-coordinate origins are Unknown rather than treated as (0,0)', unknown.includes('Member006 — origin system #999 not mapped') && [7, 11, 12].every(id => unknown.includes(`Member${String(id).padStart(3, '0')} — origin coordinates not recorded`)));
        ok('missing or invalid biology with no science ceiling is Unknown rather than radius one', unknown.includes('Member009 — biology and science level not scanned') && unknown.includes('Member013 — biology and science level not scanned'));
        ok('each member appears in exactly one bucket with reconciled totals', (totalText(embeds).match(/Member\d{3}/g) || []).length === fixtures.length && embeds[0].description.includes('Members: **13**') && embeds[0].description.includes('In Vision: **2**') && embeds[0].description.includes('Out of Range: **2**') && embeds[0].description.includes('Unknown: **9**'));

        c = capture('!vision 103 SYN');
        await bot.handleMessage(c.message);
        embeds = data(c.replies);
        ok('a target without coordinates explicitly leaves the entire roster unassessed', embeds[0].description.includes('radar cannot be assessed') && embeds[0].description.includes('Unknown: **13**') && fixtures.every(row => fieldText(embeds, '❓ Unknown').includes(`${row[1]} — target coordinates not recorded`)));
        c = capture('!vision 104 UNK');
        await bot.handleMessage(c.message);
        embeds = data(c.replies);
        ok('an alliance with no usable origin still receives a roster, not a no-players error', fieldText(embeds, '❓ Unknown').includes('UnknownOrigin') && fieldText(embeds, '❓ Unknown').includes('UnknownCoords'));

        c = capture('!ghosts 104 1 UNK');
        await bot.handleMessage(c.message);
        ok('unknown origins cannot produce a false safe-sector ghost forecast', typeof c.replies[0] === 'string' && c.replies[0].includes('Incomplete ghost forecast') && c.replies[0].includes('2 of 2') && !c.replies[0].includes('No ghosts possible'));
        c = capture('!ghosts 104 1 SYN');
        await bot.handleMessage(c.message);
        embeds = data(c.replies);
        ok('a mixed ghost forecast reports its unknown radar coverage alongside known arrivals', fieldText(embeds, '👻 Possible arrivals').includes('Member001') && fieldText(embeds, '👻 Possible arrivals').includes('Member008') && embeds[0].description.includes('Radar unknown for 9 of 13') && fieldText(embeds, '❓ Unknown radar').includes('Member003'));
        c = capture('!ghosts 104 1 OUT');
        await bot.handleMessage(c.message);
        ok('fully known out-of-range rosters retain the safe-sector response', c.replies[0].includes('No ghosts possible'));
        c = capture('!ghosts 103 1 SYN');
        await bot.handleMessage(c.message);
        ok('ghost forecasts reject an unlocated target instead of coercing it to zero', c.replies[0].includes('Cannot assess ghost arrivals') && c.replies[0].includes('target coordinates'));

        const roster = [];
        for (let i = 0; i < 210; i++) {
            const name = `SyntheticRoster${String(i).padStart(3, '0')}`;
            roster.push(name);
            addPlayer.run(1000 + i, name, 4, i % 3 === 0 ? null : i % 3 === 1 ? 101 : 102, 7, 7);
        }
        c = capture('!vision 104 BIG');
        await bot.handleMessage(c.message);
        embeds = data(c.replies);
        const visible = totalText(embeds);
        ok('a large roster is paginated instead of truncated', c.replies.length > 1 && roster.every(name => visible.includes(name)) && (visible.match(/SyntheticRoster\d{3}/g) || []).length === roster.length);
        ok('each radar page respects Discord field, title, count and message character limits', embeds.every(embed => embed.title.length <= 256 && embed.fields.length <= 25 && embed.fields.every(field => field.name.length <= 256 && field.value.length <= 1024) && embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) <= 6000));
        ok('every page repeats the complete reconciled roster totals', embeds.every(embed => embed.description.includes('Members: **210**') && embed.description.includes('In Vision: **70**') && embed.description.includes('Out of Range: **70**') && embed.description.includes('Unknown: **70**')));
        ok('pagination avoids repeated reply pings', c.replies.every(reply => reply.allowedMentions.repliedUser === false));

        const slashReplies = [], followUps = [];
        const interaction = {
            user: { bot: false, username: 'SyntheticUser' }, channel: { id: 'synthetic-channel' }, deferred: true,
            editReply: async payload => slashReplies.push(payload),
            followUp: async payload => followUps.push(payload)
        };
        await bot.handleMessage(bot.interactionAsMessage(interaction, '!vision 104 BIG'));
        ok('slash pagination edits its deferred reply once and sends remaining pages as follow-ups', slashReplies.length === 1 && followUps.length === c.replies.length - 1 && roster.every(name => totalText(data([...slashReplies, ...followUps])).includes(name)));

        c = capture('!ghosts 104 1 BIG');
        await bot.handleMessage(c.message);
        embeds = data(c.replies);
        ok('large ghost forecasts paginate known arrivals and unknown members without embed overflow', embeds.length > 1 && embeds.every(embed => embed.description.length <= 4096 && embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) <= 6000));
        ok('ghost pagination retains every eligible arrival and every unknown radar member', roster.filter((name, index) => index % 3 === 1).every(name => fieldText(embeds, '👻 Possible arrivals').includes(name)) && roster.filter((name, index) => index % 3 === 0).every(name => fieldText(embeds, '❓ Unknown radar').includes(name)) && embeds.every(embed => embed.description.includes('Radar unknown for 70 of 210')));

        console.log(`\n${pass} passed, ${fail} failed`);
        if (fail) process.exitCode = 1;
    } finally {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
