// Decides who earns population credit for one battle-bombarded News entry. Population is
// always credited to the attacker: if the scraping player's own row says "You killed N
// population" they were the attacker (credit themselves); if it says "You lost N
// population" they were the defender (credit the other player named in the row).
//
// The "killed" wording's News row carries no player-profile link at all (confirmed
// against a real example — the game only names the target planet/system, not an
// opponent), so other_player_id is legitimately null in that case. Crediting the
// scraping player doesn't need it — only the battle_reports cross-reference lookup
// does, and the caller already treats a null otherPlayerId as "can't cross-reference,
// so count the population" rather than skipping credit outright. The "lost" wording
// DOES need other_player_id (it names who to credit), so that case still requires it.
function resolveBombardmentCredit(entry, scrapingPlayerId) {
    if (entry.direction === 'killed') {
        return { credited_player_id: scrapingPlayerId, otherPlayerId: entry.other_player_id || null };
    }
    if (!entry.other_player_id) return null;
    return { credited_player_id: entry.other_player_id, otherPlayerId: scrapingPlayerId };
}

module.exports = { resolveBombardmentCredit };
