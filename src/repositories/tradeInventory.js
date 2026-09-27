// A member's /Game/Trade inventory, item by item, and what they are willing to sell of it
// (trade_inventory_items / savings_sell_picks in database.js). Picks are scoped by user_id,
// so a member only ever changes their own; the A$ value they add up to is shared, because
// the Trade Agreement Schedule plans every member's side.
const db = require('../database');

const deleteItemsStmt = db.prepare(`DELETE FROM trade_inventory_items WHERE player_id = ?`);
const insertItemStmt = db.prepare(`
    INSERT INTO trade_inventory_items (player_id, name, held, unit_price) VALUES (?, ?, ?, ?)
`);
// Replaced whole: an item sold since the last sync must disappear, not linger at its old count.
const replaceItemsTx = db.transaction((playerId, items) => {
    deleteItemsStmt.run(playerId);
    for (const it of items) insertItemStmt.run(playerId, it.name, it.held, it.unit_price);
});
function replaceItems(playerId, items) { replaceItemsTx(playerId, items); }

// Every held item, with this account's pick on it (picked = a row exists; qty null = all).
const listForUserStmt = db.prepare(`
    SELECT ti.name, ti.held, ti.unit_price, ti.synced_at,
           sp.name IS NOT NULL AS picked, sp.qty
    FROM trade_inventory_items ti
    LEFT JOIN savings_sell_picks sp ON sp.user_id = ? AND sp.name = ti.name
    WHERE ti.player_id = ?
    ORDER BY ti.held * ti.unit_price DESC, ti.name
`);
function listItemsForUser(userId, playerId) {
    return listForUserStmt.all(userId, playerId).map(r => ({ ...r, picked: !!r.picked }));
}

const upsertPickStmt = db.prepare(`
    INSERT INTO savings_sell_picks (user_id, name, qty) VALUES (?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET qty = excluded.qty
`);
const deletePickStmt = db.prepare(`DELETE FROM savings_sell_picks WHERE user_id = ? AND name = ?`);
function setPick(userId, name, qty) { upsertPickStmt.run(userId, name, qty); }
function clearPick(userId, name) { deletePickStmt.run(userId, name); }

// A$ each player would raise by selling what they picked: min(pick, held) × market price,
// with a NULL pick meaning everything held. Keyed by lower-cased player name, which is how
// the Schedule matches members; the account→player bridge is the one users.js uses.
const sellableStmt = db.prepare(`
    SELECT LOWER(p.name) AS name,
           SUM(MIN(COALESCE(sp.qty, ti.held), ti.held) * ti.unit_price) AS au
    FROM savings_sell_picks sp
    JOIN app_users u ON u.id = sp.user_id
    JOIN players p ON LOWER(p.name) = LOWER(u.game_name)
    JOIN trade_inventory_items ti ON ti.player_id = p.id AND ti.name = sp.name
    GROUP BY p.id
`);
function sellableByPlayerName() {
    const out = new Map();
    for (const r of sellableStmt.all()) out.set(r.name, Math.round(r.au || 0));
    return out;
}

module.exports = { replaceItems, listItemsForUser, setPick, clearPick, sellableByPlayerName };
