// !help content. `!help` is a short grouped index — one line per command, sized to read on
// a phone — and `!help <command>` gives the full description and an example. It used to be
// one embed field per command with the whole description inline, which grew into a wall.
//
// Each entry: `names` are every word that should find it via `!help <word>` (the first is
// the one shown), `usage` is the syntax line, `short` the index blurb, `detail` the full text.
// `hidden` keeps an entry out of the index but still answers `!help <name>`: !glory is
// RAID's own scoring, and !bio is a partial view next to the Hub's /game/sciences page.

function helpEntries({ bioConfirmed, bioSuspected }) {
    return [
        {
            group: '🔗 Setup',
            items: [
                {
                    names: ['link'], usage: '!link <code>', short: 'link Discord to your Hub account',
                    detail: 'Links your Discord account to your Hub account so you get @pinged on incoming alerts you can defend. Get the one-time code from **Link Discord** in the Hub sidebar first (`!link` with no code explains how). Codes expire after 10 minutes.',
                    example: '!link A1B2C3',
                },
                {
                    names: ['timer'], usage: '!timer <duration>', short: 'ping yourself later',
                    detail: 'Sets a personal reminder that pings you back here. Survives a bot restart; checked once a minute.',
                    example: '!timer 1 hour 8 mins',
                },
                {
                    names: ['getid'], usage: '!getid', short: 'this channel\'s ID',
                    detail: 'Shows the ID of the current channel — useful for config that asks for a channel ID.',
                },
            ],
        },
        {
            group: '🛰️ Intel',
            items: [
                {
                    names: ['intel'], usage: '!intel <player>', short: 'one player\'s intel and stats',
                    detail: 'Displays detailed intelligence and stats for a specific player.',
                    example: '!intel PlayerOne',
                },
                {
                    names: ['sys'], usage: '!sys <system>', short: 'planets, fleets, plans in a system',
                    detail: 'Displays intel for a specific solar system (Planets, Fleets, Plans).',
                    example: '!sys 123',
                },
                {
                    names: ['intels'], usage: '!intels', short: 'browse tracked profiles',
                    detail: 'Opens an interactive text menu to browse tracked intelligence profiles.',
                },
                {
                    names: ['research'], usage: '!research [player]', short: 'who is researching what',
                    detail: 'What each member is researching, how long until the level lands, and what is queued after it — read from their own Science page. With a name: that member\'s whole queue.',
                    example: '!research Harpyie',
                },
                {
                    names: ['bio'], hidden: true, usage: '!bio', short: 'who can see your origin',
                    detail: `Players who can SEE your origin and hold a +${bioConfirmed} confirmed biology, or a +${bioSuspected} science advantage if never scanned.`,
                },
                {
                    names: ['lastseen'], usage: '!lastseen <player>', short: 'where a player last fought',
                    detail: 'Shows up to 5 recent system/planet locations a player was involved in a battle report or News-page bombardment at, on either side, newest first.',
                    example: '!lastseen Hkiller89',
                },
            ],
        },
        {
            group: '🗺️ Map & plans',
            items: [
                {
                    names: ['plan'], usage: '!plan <sys> <planet> <text>', short: 'note on a planet',
                    detail: 'Adds a tactical plan/note to a specific planet. (Requires your Discord ID to be linked in the Hub.)\n`!plan del <sys> <planet>` removes one. You can only remove your own — an admin account can remove anyone\'s.',
                    example: '!plan 123 4 Send colony ship',
                },
                {
                    names: ['splan'], usage: '!splan <sys> [text]', short: 'note on a whole system',
                    detail: 'One standing note for a whole system — not per-planet. No text: reads it back. With text: writes/overwrites it (admins only). Admins also get ✏️ Edit / 🗑️ Delete buttons on the reply — Edit opens a pre-filled box so you never retype the whole thing.\n`!splan del <sys>` removes it (admins only).',
                    example: '!splan 123 Hold this system, colony ships incoming',
                },
                {
                    names: ['holes'], usage: '!holes [tag]', short: 'free / planned / hostile in our space',
                    detail: 'Scans your alliance\'s territory for a per-system breakdown: your own holdings, free unplanned, 🟧 planned (!plan), 🟨 neutral, 🟩 ally, and 🟥 war-list presence, per the Alliance Relations tags set in Admin.',
                    example: '!holes RAID',
                },
                {
                    names: ['vision'], usage: '!vision <sys> [tag]', short: 'who has radar on a system',
                    detail: 'Performs a radar scan to see which alliance members have vision over a target system.',
                    example: '!vision 123 RAID',
                },
                {
                    names: ['ghosts'], usage: '!ghosts <sys> <planet> <tag>', short: 'hidden-fleet arrival window',
                    detail: 'Calculates the shortest/longest hidden fleet arrival window from hostile members with radar vision over a system.',
                    example: '!ghosts 1 10 AO',
                },
                {
                    names: ['dist'], usage: '!dist <sys1> <sys2>', short: 'distance and bio needed',
                    detail: 'Calculates the distance and required biology level between two systems.',
                    example: '!dist 100 200',
                },
            ],
        },
        {
            group: '⚔️ Combat',
            items: [
                {
                    names: ['battle'], usage: '!battle <D> <C> <B> vs <D> <C> <B>', short: 'simulate a fight',
                    detail: 'Simulates a battle. Flags: `--sb N` starbase (0-50), `--dp/--ap N` physics, `--dm/--am N` math, `--dra/--ara N` race atk, `--drd/--ard N` race def, `--dl/--al N` player level. Or `--def Name --atk Name` to auto-fill all stats from DB.',
                    example: '!battle 50 10 0 vs 40 8 2 --dp 5 --ap 3 --dl 12 --al 8',
                },
                {
                    names: ['tt'], usage: '!tt <sysA> <plA> <sysB> <plB> <speed> <nrg>', short: 'fleet travel time',
                    detail: 'Calculates fleet travel time between two coordinates. You can also swap speed/energy for a player name: `!tt 100 1 200 4 PlayerOne`.',
                    example: '!tt 100 1 200 4 10 5',
                },
            ],
        },
        {
            group: '🏆 Leaderboards',
            note: 'add `day` / `week` to any of them, e.g. `!mortalweek`',
            items: [
                {
                    names: ['mortal', 'mortalday', 'mortalweek'], usage: '!mortal [all|tag]', short: 'CV + pop killed, with points',
                    detail: 'Shows the CV/population-killed battle leaderboards, each with a simple points column. `!mortal` all-time, `!mortalday` last 24 hours, `!mortalweek` last 7 days. Defaults to Hub tool users only; `all` lifts that; any alliance tag filters to that alliance (any alliance, not just your own).',
                    example: '!mortalweek nsa',
                },
                {
                    names: ['cvkills', 'cvkillsday', 'cvkillsweek'], usage: '!cvkills [all|tag]', short: 'raw CV killed',
                    detail: 'Pure CV-killed ranking — the raw number only, no points. `day` / `week` variants and scope rules as `!mortal`.',
                    example: '!cvkillsweek nsa',
                },
                {
                    names: ['popkills', 'popkillsday', 'popkillsweek'], usage: '!popkills [all|tag]', short: 'raw population killed',
                    detail: 'Pure population-killed ranking — the raw number only, no points. `day` / `week` variants and scope rules as `!mortal`.',
                    example: '!popkillsweek nsa',
                },
                {
                    names: ['glory', 'gloryday', 'gloryweek'], hidden: true, usage: '!glory', short: 'combined points (alliance only)',
                    detail: 'Combined CV + population points leaderboard (plus any bonus-goal points), weighted so a bigger single kill is worth disproportionately more per unit. Alliance-only — no `[all|<alliance_tag>]` option, unlike `!mortal`. `!gloryday` / `!gloryweek` for the last 24 hours / 7 days.',
                },
            ],
        },
        {
            group: '🎱 Fun',
            items: [
                {
                    names: ['8ball'], usage: '!8ball <question>', short: 'ask the magic 8-ball',
                    detail: 'Ask the magic 8-ball a question.',
                    example: '!8ball will we win this round?',
                },
            ],
        },
    ];
}

const COLOR = '#10b981';
// The eggs (!42, !hail, !warp) are deliberately not listed. This is the hint.
const FOOTER = 'AWT Intelligence Hub · not everything it answers to is on this list';

// Returns plain embed data ({ title, description, color, fields, footer }) for `!help` or
// `!help <topic>`. The caller wraps it in an EmbedBuilder.
function buildHelp(topic, margins) {
    const groups = helpEntries(margins);
    const word = String(topic || '').trim().toLowerCase().replace(/^[!/]/, '');

    if (word) {
        const entry = groups.flatMap(g => g.items).find(e => e.names.includes(word));
        if (!entry) {
            return {
                title: '🛠️ Help',
                description: `No command called \`!${word}\`. Type \`!help\` for the list.`,
                color: COLOR,
                fields: [],
                footer: { text: FOOTER },
            };
        }
        const fields = [];
        if (entry.example) fields.push({ name: 'Example', value: `\`${entry.example}\`` });
        if (entry.names.length > 1) fields.push({ name: 'Also', value: entry.names.slice(1).map(n => `\`!${n}\``).join(' · ') });
        return {
            title: `🛠️ \`${entry.usage}\``,
            description: entry.detail,
            color: COLOR,
            fields,
            footer: { text: FOOTER },
        };
    }

    return {
        title: '🛠️ Command Center Help',
        description: '💡 **`!help <command>` shows deeper help** — full options and an example, e.g. `!help battle`.',
        color: COLOR,
        fields: groups.map(g => ({
            name: g.group,
            value: [
                ...g.items.filter(e => !e.hidden).map(e => `\`!${e.names[0]}\` — ${e.short}`),
                ...(g.note ? [`*${g.note}*`] : []),
            ].join('\n'),
        })),
        footer: { text: FOOTER },
    };
}

module.exports = { buildHelp, helpEntries };
