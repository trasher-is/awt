const db = require('../database');

const getSettingStmt = db.prepare(`SELECT value FROM app_settings WHERE key = ?`);
function getSetting(key) {
    return getSettingStmt.get(key);
}

const getPpPriceStmt = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`);
function getPpPrice() {
    return getPpPriceStmt.get();
}

const getAllSettingsStmt = db.prepare(`SELECT key, value FROM app_settings`);
function getAllSettings() {
    return getAllSettingsStmt.all();
}

const setSettingStmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
`);
function setSetting(key, value) {
    setSettingStmt.run(key, value);
}

// Shared parser for the comma-separated-alliance-tags setting convention already used by
// battle_points_excluded_alliance_tags, discord_battlereport_alliance_tags, and (2026-09-04)
// alliance_relations_allied/alliance_relations_war. One place for it since it's now read
// from both a route (client-facing) and discord_bot.js (!holes).
function getTagListSetting(key) {
    const row = getSettingStmt.get(key);
    if (!row || !row.value) return [];
    return [...new Set(row.value.split(',').map(t => t.trim().toUpperCase()).filter(Boolean))];
}

module.exports = { getSetting, getPpPrice, getAllSettings, setSetting, getTagListSetting };
