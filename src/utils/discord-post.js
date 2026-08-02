// Minimal "post one embed to a channel" helper.
//
// src/discord_bot.js has a logged-in client and its own sendSystemEmbed(), but it does
// not export a general-purpose sender. Rather than widen that module's surface — it is
// 1600 lines and under active change elsewhere — this uses discord.js's REST client
// directly. The bot token is all it needs; no gateway connection, no shared state.
//
// Every function here is best-effort: a missing token or an unconfigured channel is a
// no-op with a reason, never a thrown error into a request handler.

const { REST, Routes } = require('discord.js');
const db = require('../database');

let rest = null;
function client() {
    if (rest) return rest;
    const token = process.env.DISCORD_TOKEN;
    if (!token) return null;
    rest = new REST({ version: '10' }).setToken(token);
    return rest;
}

function settingValue(key) {
    try {
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
        const v = row && row.value ? String(row.value).trim() : '';
        return v || null;
    } catch (err) {
        return null;
    }
}

// Names and free text reach Discord here, so "@everyone" in a route title would ping the
// server. Same defusing the incoming webhook applies: a zero-width space after the @.
function defuseMentions(value) {
    return String(value == null ? '' : value)
        .replace(/@(everyone|here)/gi, '@​$1')
        .replace(/<@([!&]?\d+)>/g, '<@​$1>');
}

/**
 * Post an embed to a channel taken from app_settings.
 * @param {string} settingKey  app_settings key holding the channel id
 * @param {object} embed       a plain Discord embed object
 * @returns {Promise<{ok: boolean, reason?: string, messageId?: string}>}
 */
async function postEmbed(settingKey, embed) {
    const api = client();
    if (!api) return { ok: false, reason: 'DISCORD_TOKEN is not set' };

    const channelId = settingValue(settingKey);
    if (!channelId) return { ok: false, reason: `no channel configured for ${settingKey}` };

    try {
        const msg = await api.post(Routes.channelMessages(channelId), { body: { embeds: [embed] } });
        return { ok: true, messageId: msg && msg.id };
    } catch (err) {
        console.error(`[Discord] Failed to post to ${settingKey}:`, err.message);
        return { ok: false, reason: err.message };
    }
}

module.exports = { postEmbed, defuseMentions, settingValue };
