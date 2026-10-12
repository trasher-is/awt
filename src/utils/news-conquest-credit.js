// Fills a 'battle-conquer' News row ("We conquered ...") from the scan's own log. The News
// text names neither the population destroyed nor the previous owner, so both come from
// the OWNER_CHANGE + POP_DROP the scan logged when it saw the planet change hands (see
// systemsRepo.findLoggedConquest). The conquering player is always the member whose News
// it is.
//
// These rows are for display (!lastseen); !glory/!popkills credit non-battle conquests
// straight from the scan log (battlePoints.js loggedConquestBranch) so a conquest counts
// whether or not the member ever opens their News page.
const db = require('../database');
const systemsRepo = require('../repositories/systems');
const playersRepo = require('../repositories/players');

// Returns { population_delta, credited_player_id, other_player_id }, all null when the scan
// hasn't seen the conquest (yet). other_player_id is only set to a player the hub knows
// (news_events.other_player_id has a FOREIGN KEY to players).
function resolveConquestCredit(gamePlanetId, scrapingPlayerId, occurredIso) {
    const none = { population_delta: null, credited_player_id: null, other_player_id: null };
    if (!gamePlanetId || !scrapingPlayerId) return none;
    const loc = systemsRepo.getPlanetLocationByGameId(gamePlanetId);
    if (!loc) return none;
    const conquest = systemsRepo.findLoggedConquest(loc.system_id, loc.planet_index, scrapingPlayerId, occurredIso);
    if (!conquest) return none;
    const previous = conquest.previous_owner_id;
    const other_player_id = previous != null && playersRepo.playerExistsById(previous) ? previous : null;
    const killed = conquest.population_killed;
    if (killed == null || killed <= 0) return { ...none, other_player_id };
    return { population_delta: killed, credited_player_id: scrapingPlayerId, other_player_id };
}

// Re-resolves every stored 'battle-conquer' row. Rows stored before this lookup looked
// forward in time were left uncredited (or matched an older, unrelated drop), and a row
// stored before any scan saw the conquest can be filled in later. Idempotent and cheap
// (a handful of rows), so it simply runs on every start. Returns how many rows changed.
function recreditConquestRows() {
    const rows = db.prepare(`
        SELECT id, player_id, game_planet_id, occurred_at, population_delta, credited_player_id, other_player_id
        FROM news_events WHERE message_type = 'battle-conquer'
    `).all();
    const update = db.prepare(`
        UPDATE news_events SET population_delta = ?, credited_player_id = ?, other_player_id = ? WHERE id = ?
    `);
    let changed = 0;
    db.transaction(() => {
        for (const r of rows) {
            const c = resolveConquestCredit(r.game_planet_id > 0 ? r.game_planet_id : null, r.player_id, r.occurred_at);
            const other = r.other_player_id ?? c.other_player_id;
            if (c.population_delta === r.population_delta && c.credited_player_id === r.credited_player_id
                && other === r.other_player_id) continue;
            update.run(c.population_delta, c.credited_player_id, other, r.id);
            changed++;
        }
    })();
    return changed;
}

module.exports = { resolveConquestCredit, recreditConquestRows };
