// Generic parser for a /Ranking/... page shaped like "a table with a leading rank number
// per row and a /Game/Map/Planet/{id} link somewhere in that row" — no idea what any
// particular ranking page is FOR, only this shape. Shared between bonus-goals-sync.js
// (the secretly-configured ranking_match goal type) and the Various Changes Best Planets
// watcher (public, aggregate-only — see best-planets-watch.js), so the two don't carry two
// copies of the same DOM-parsing logic that could quietly drift apart (2026-09-12,
// extracted from bonus-goals-sync.js, which used to be the only place this lived).
export function parseRankingPage(doc) {
    const rows = [];
    doc.querySelectorAll('table tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (!cells.length) return;
        const rank = parseInt((cells[0].textContent || '').trim(), 10);
        if (!Number.isInteger(rank) || rank <= 0) return;
        const planetLink = tr.querySelector('a[href^="/Game/Map/Planet/"]');
        if (!planetLink) return;
        const gamePlanetId = parseInt((planetLink.getAttribute('href') || '').split('/').pop(), 10);
        if (!Number.isInteger(gamePlanetId)) return;
        const ownerLink = tr.querySelector('a[href*="/Game/Players/Profile/"]');
        const tagLink = tr.querySelector('a[href*="/Game/Alliance/Profile/"]');
        rows.push({
            rank,
            game_planet_id: gamePlanetId,
            owner_name: ownerLink ? ownerLink.textContent.trim() : null,
            owner_alliance_tag: tagLink ? tagLink.textContent.trim() : null,
        });
    });
    return rows;
}
