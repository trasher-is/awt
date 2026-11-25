// Reads a player's past names off the game's own History page (/Game/Players/History/{id}).
// The game's API has no name history at all: every Player schema carries only the current
// name. The History page is a timeline, and each "Joined Round" entry says which name the
// player started that round with:
//
//     .timeline > .timeline-item
//         .timeline-icon  i.bi-rocket-takeoff          <- what kind of entry this is
//         small.text-muted  "2026-08-31 10:37" span "· Beta 6: Echoes of War"
//         .mt-2 strong      "Shaka"
//
// Entries are told apart by their icon, not their wording, so this does not depend on the
// page language. The "Resigned" entry also has a <strong> (a count), which is why the icon
// matters.
//
// A player who resigns and rejoins gets another entry, so one round can appear several times.
//
// DOM-only (no globals), so src/utils/player-history-parser.test.js can run it in Node.
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AWPlayerHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {

    const text = el => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

    /**
     * Every "Joined Round" entry, in page order (newest first), or null when the document is
     * not a History page at all — a login page or an error must not read as "no old names".
     */
    function parseStarts(doc) {
        if (!doc.querySelector('.timeline')) return null;
        const starts = [];
        for (const item of doc.querySelectorAll('.timeline-item')) {
            if (!item.querySelector('.bi-rocket-takeoff')) continue;
            const name = text(item.querySelector('.mt-2 strong'));
            if (!name) continue;
            const date = text(item.querySelector('small.text-muted')).match(/\d{4}-\d{2}-\d{2}/);
            // "· Beta 6: Echoes of War" — the part before the colon is enough to tell rounds apart.
            const round = text(item.querySelector('small.text-muted span')).replace(/^·\s*/, '').split(':')[0].trim();
            starts.push({ name, round, date: date ? date[0] : '' });
        }
        return starts;
    }

    /**
     * The names that are not the current one, newest first, each with the rounds it was used
     * in. Names compare case-insensitively, as the hub's own player table does. A name used
     * for several starts in one round is listed once for it, with the earliest date.
     */
    function oldNames(starts, currentName) {
        const key = name => String(name || '').trim().toLowerCase();
        const current = key(currentName);
        const byName = new Map();
        for (const start of starts) {
            const k = key(start.name);
            if (k === current) continue;
            if (!byName.has(k)) byName.set(k, { name: start.name, uses: [] });
            const uses = byName.get(k).uses;
            const same = uses.find(u => u.round === start.round);
            if (!same) uses.push({ round: start.round, date: start.date });
            else if (start.date && (!same.date || start.date < same.date)) same.date = start.date;
        }
        return [...byName.values()];
    }

    return { parseStarts, oldNames };
});
