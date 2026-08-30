// Decides who earns population credit for one battle-bombarded News entry. Population is
// always credited to the attacker: if the scraping player's own row says "You killed N
// population" they were the attacker (credit themselves); if it says "You lost N
// population" they were the defender (credit the other player named in the row).
function resolveBombardmentCredit(entry, scrapingPlayerId) {
    if (!entry.other_player_id) return null;
    const credited_player_id = entry.direction === 'killed' ? scrapingPlayerId : entry.other_player_id;
    const otherPlayerId = credited_player_id === scrapingPlayerId ? entry.other_player_id : scrapingPlayerId;
    return { credited_player_id, otherPlayerId };
}

module.exports = { resolveBombardmentCredit };
