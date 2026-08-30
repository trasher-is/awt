const db = require('../database');

const insertNewsEventStmt = db.prepare(`
    INSERT OR IGNORE INTO news_events (
        player_id, message_type, occurred_at, game_planet_id, system_id,
        other_player_id, population_delta, credited_player_id, matched_battle_report_id
    ) VALUES (
        @player_id, @message_type, @occurred_at, @game_planet_id, @system_id,
        @other_player_id, @population_delta, @credited_player_id, @matched_battle_report_id
    )
`);
function insertNewsEvent(entry) {
    return insertNewsEventStmt.run({
        player_id: entry.player_id,
        message_type: entry.message_type,
        occurred_at: entry.occurred_at,
        game_planet_id: entry.game_planet_id ?? null,
        system_id: entry.system_id ?? null,
        other_player_id: entry.other_player_id ?? null,
        population_delta: entry.population_delta ?? null,
        credited_player_id: entry.credited_player_id ?? null,
        matched_battle_report_id: entry.matched_battle_report_id ?? null,
    }).changes > 0;
}

const getWatermarkStmt = db.prepare(`SELECT last_news_scraped_at FROM players WHERE id = ?`);
function getWatermark(playerId) {
    const row = getWatermarkStmt.get(playerId);
    return row ? row.last_news_scraped_at : null;
}

// Only ever moves forward — a page fetched out of order, or a duplicate visit, must
// never regress a player's watermark back in time.
const advanceWatermarkStmt = db.prepare(`
    UPDATE players
    SET last_news_scraped_at = CASE
        WHEN last_news_scraped_at IS NULL OR @ts > last_news_scraped_at THEN @ts
        ELSE last_news_scraped_at
    END
    WHERE id = @id
`);
function advanceWatermark(playerId, isoTimestamp) {
    advanceWatermarkStmt.run({ id: playerId, ts: isoTimestamp });
}

const deleteAllNewsEventsStmt = db.prepare(`DELETE FROM news_events`);
function deleteAllNewsEvents() {
    return deleteAllNewsEventsStmt.run().changes;
}

module.exports = { insertNewsEvent, getWatermark, advanceWatermark, deleteAllNewsEvents };
