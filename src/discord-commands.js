// Slash-command definitions and autocomplete data.
//
// Kept out of discord_bot.js so the 1600-line handler does not grow another 300, and so
// the shape of the command tree can be read in one screen.
//
// ─── WHY SUBCOMMAND GROUPS ────────────────────────────────────────────────────
// A flat list of fourteen slash commands is genuinely bad on a phone — the picker
// becomes a scroll. Grouping drops the top level to five entries and puts everything
// else one step down, which is one tap rather than a hunt:
//
//   /intel  player · system · bio · alliance
//   /calc   travel · battle · distance
//   /plan   add · list
//   /scan   holes · vision · ghosts
//   /link, /timer, /help          (single-purpose, no group)
//
// ─── WHY THIS IS WORTH DOING AT ALL ───────────────────────────────────────────
// Not the look. Autocomplete. "!intel Trashe" fails silently on a typo; /intel player
// with autocomplete offers the real names straight out of the local database, so a
// lookup cannot miss because of a spelling difference. Same for system names.
//
// The ! commands keep working unchanged — this is a second entry point onto the same
// handlers, not a rewrite.

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('./database');

// Autocomplete is capped at 25 choices by Discord.
const MAX_CHOICES = 25;

/**
 * Player-name suggestions from the local database. Falls back to the most-recently-seen
 * players when the box is still empty, so the list is useful before typing.
 */
function suggestPlayers(query) {
    const q = String(query || '').trim();
    try {
        const rows = q
            ? db.prepare(`
                SELECT p.name, a.tag
                FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
                WHERE p.name LIKE ? ORDER BY LENGTH(p.name) ASC LIMIT ?
              `).all(`%${q}%`, MAX_CHOICES)
            : db.prepare(`
                SELECT p.name, a.tag
                FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
                ORDER BY p.points DESC LIMIT ?
              `).all(MAX_CHOICES);
        return rows.map(r => ({
            name: (r.tag ? `[${r.tag}] ${r.name}` : r.name).slice(0, 100),
            value: r.name.slice(0, 100),
        }));
    } catch (err) {
        console.error('[Discord] Player autocomplete failed:', err.message);
        return [];
    }
}

/** System suggestions, by name or by id. The value is the id, which is what commands want. */
function suggestSystems(query) {
    const q = String(query || '').trim();
    try {
        const rows = q
            ? db.prepare(`
                SELECT id, name, x, y FROM systems
                WHERE name LIKE ? OR CAST(id AS TEXT) LIKE ?
                ORDER BY LENGTH(COALESCE(name, '')) ASC LIMIT ?
              `).all(`%${q}%`, `${q}%`, MAX_CHOICES)
            : db.prepare(`SELECT id, name, x, y FROM systems WHERE x IS NOT NULL ORDER BY id LIMIT ?`).all(MAX_CHOICES);
        return rows.map(r => ({
            name: `${r.name || 'Unknown'} #${r.id}${r.x != null ? ` (${r.x}/${r.y})` : ''}`.slice(0, 100),
            value: String(r.id),
        }));
    } catch (err) {
        console.error('[Discord] System autocomplete failed:', err.message);
        return [];
    }
}

const playerOption = (o, name = 'player', desc = 'Player name') =>
    o.setName(name).setDescription(desc).setAutocomplete(true).setRequired(true);
const systemOption = (o, name = 'system', desc = 'Solar system') =>
    o.setName(name).setDescription(desc).setAutocomplete(true).setRequired(true);
// Planet indexes are 1-12 in game. Deliberately NOT autocompleted: twelve numbers in a
// dropdown is slower to use than typing one, and an autocompleted option would be routed
// by name in the interaction handler, where "to_planet" would have to be told apart from
// "to".
const planetOption = (o, name = 'planet', desc = 'Planet index (1-12)') =>
    o.setName(name).setDescription(desc).setRequired(true).setMinValue(1).setMaxValue(12);

// The command tree. Every leaf maps to the same code the ! prefix reaches.
function buildCommands() {
    return [
        new SlashCommandBuilder()
            .setName('intel')
            .setDescription('Look up what the Hub knows')
            .addSubcommand(s => s.setName('player').setDescription('Full intel on one player')
                .addStringOption(o => playerOption(o)))
            .addSubcommand(s => s.setName('system').setDescription('Planets and fleets in a system')
                .addStringOption(o => systemOption(o)))
            .addSubcommand(s => s.setName('bio').setDescription('Players with a biology advantage over you'))
            .addSubcommand(s => s.setName('alliance').setDescription('Members whose intel is going stale')),

        new SlashCommandBuilder()
            .setName('calc')
            .setDescription('Travel, battle and distance calculators')
            // Travel time depends on the PLANET at each end, not just the system: the
            // formula adds sqrt(|Δplanet| + 1) to every hop, so the same two systems give
            // different answers for planet 1 -> 1 and planet 1 -> 12. This subcommand used
            // to take only the two systems, which made every answer it gave wrong except
            // by accident. Both planet indexes are required for the same reason the prefix
            // command requires them.
            .addSubcommand(s => s.setName('travel').setDescription('Travel time between two planets')
                .addStringOption(o => systemOption(o, 'from', 'Origin system'))
                .addIntegerOption(o => planetOption(o, 'from_planet', 'Origin planet index (1-12)'))
                .addStringOption(o => systemOption(o, 'to', 'Destination system'))
                .addIntegerOption(o => planetOption(o, 'to_planet', 'Destination planet index (1-12)'))
                // Either name a player and take their stats from the archive, or give the
                // two numbers. `!tt` has offered both since it was written; the slash
                // command offered neither properly.
                .addStringOption(o => o.setName('player').setDescription('Take speed and energy from this player').setAutocomplete(true))
                .addIntegerOption(o => o.setName('speed').setDescription('Race speed (-4..4) — ignored if a player is given').setMinValue(-4).setMaxValue(4))
                .addIntegerOption(o => o.setName('energy').setDescription('Energy level — ignored if a player is given').setMinValue(0).setMaxValue(100)))
            .addSubcommand(s => s.setName('battle').setDescription('Battle estimate')
                .addStringOption(o => o.setName('defender').setDescription('Defender fleet as "D C B", e.g. "1000 0 0"').setRequired(true))
                .addStringOption(o => o.setName('attacker').setDescription('Attacker fleet as "D C B"').setRequired(true))
                .addIntegerOption(o => o.setName('starbase').setDescription('Defender starbase level').setMinValue(0).setMaxValue(50))
                .addStringOption(o => o.setName('defender_player').setDescription('Fill defender stats from a player').setAutocomplete(true))
                .addStringOption(o => o.setName('attacker_player').setDescription('Fill attacker stats from a player').setAutocomplete(true)))
            .addSubcommand(s => s.setName('distance').setDescription('Distance and biology needed between two systems')
                .addStringOption(o => systemOption(o, 'from', 'First system'))
                .addStringOption(o => systemOption(o, 'to', 'Second system'))),

        new SlashCommandBuilder()
            .setName('plan')
            .setDescription('Shared planet notes')
            .addSubcommand(s => s.setName('add').setDescription('Add a note to a planet')
                .addStringOption(o => systemOption(o))
                .addIntegerOption(o => o.setName('planet').setDescription('Planet index').setRequired(true).setMinValue(1).setMaxValue(12))
                .addStringOption(o => o.setName('note').setDescription('What to record').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('Notes recorded for a system')
                .addStringOption(o => systemOption(o))),

        new SlashCommandBuilder()
            .setName('scan')
            .setDescription('Coverage and reach analysis')
            .addSubcommand(s => s.setName('holes').setDescription('Systems nobody in the alliance can see'))
            .addSubcommand(s => s.setName('vision').setDescription('Who covers a given system')
                .addStringOption(o => systemOption(o)))
            .addSubcommand(s => s.setName('ghosts').setDescription('Possible pre-capture arrival windows on a planet')
                .addStringOption(o => systemOption(o))
                .addIntegerOption(o => o.setName('planet').setDescription('Planet index').setRequired(true).setMinValue(1).setMaxValue(12))
                .addStringOption(o => o.setName('tag').setDescription('Enemy alliance tag').setRequired(true))),

        new SlashCommandBuilder()
            .setName('link')
            .setDescription('Link this Discord account to your Hub account')
            .addStringOption(o => o.setName('code').setDescription('The one-time code from the Hub panel')),

        new SlashCommandBuilder()
            .setName('timer')
            .setDescription('Ping yourself later; survives a bot restart')
            .addStringOption(o => o.setName('when').setDescription('e.g. "10 mins", "1h 8m"').setRequired(true)),

        new SlashCommandBuilder()
            .setName('help')
            .setDescription('What this bot can do'),
    ];
}

// Which replies are only useful to the person who asked. Ephemeral keeps a busy channel
// readable — this replaces the old blanket channel blocklist for these.
const EPHEMERAL = new Set(['link', 'help', 'calc:travel', 'calc:battle', 'calc:distance', 'intel:bio']);

function isEphemeral(commandName, sub) {
    return EPHEMERAL.has(sub ? `${commandName}:${sub}` : commandName);
}

module.exports = { buildCommands, suggestPlayers, suggestSystems, isEphemeral, PermissionFlagsBits };
