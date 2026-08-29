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

module.exports = { getSetting, getPpPrice, getAllSettings, setSetting };
