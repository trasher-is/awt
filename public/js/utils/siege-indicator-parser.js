// Reads the DOM's own friend/enemy siege classification for one planet row on a system
// page — the game marks a besieged planet's row `tr.siege` (hostile) or `tr.friendly-siege`
// (ours or an ally's), and names the besieger in the `.aw-hub-indicator`'s title attribute
// ("Enemy Siege by X" or "Allied Siege by X | Intel Note: ..."). This is strictly richer
// than the API-sourced hasSiege boolean (see aw-api.js), which carries no attacker identity
// or allegiance at all — extracted standalone (2026-09-12b) so system-parser.js's much
// bigger extraction function doesn't carry this one small, independently-testable piece of
// DOM shape knowledge inline, same reasoning as ranking-page-parser.js's own extraction.
export function parseSiegeIndicator(row) {
    const isEnemy = row.classList.contains('siege');
    const isFriendly = row.classList.contains('friendly-siege');
    if (!isEnemy && !isFriendly) return { is_sieged: 0, siege_is_friendly: null, siege_attacker_name: null };

    const indicator = row.querySelector('.aw-hub-indicator');
    const title = indicator ? indicator.getAttribute('title') : null;
    const match = title && title.match(/^(?:Enemy|Allied) Siege by (.+?)(?:\s*\|.*)?$/);
    return {
        is_sieged: 1,
        siege_is_friendly: isFriendly,
        siege_attacker_name: match ? match[1].trim() : null,
    };
}
