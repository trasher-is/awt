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
const settingsRepo = require('../repositories/settings');

let rest = null;
function client() {
    if (rest) return rest;
    const token = process.env.DISCORD_TOKEN;
    if (!token) return null;
    rest = new REST({ version: '10' }).setToken(token);
    return rest;
}

// The battle/leaderboard bot is purely cosmetic (a distinct avatar for battle posts) and
// optional: unset, it silently falls back to the main bot's token, exactly like every
// other optional integration in this app (see .env.example's DISCORD_TOKEN convention).
let battleRest = null;
function battleClient() {
    if (battleRest) return battleRest;
    const token = process.env.BATTLE_DISCORD_TOKEN;
    if (!token) return null;
    battleRest = new REST({ version: '10' }).setToken(token);
    return battleRest;
}

function settingValue(key) {
    try {
        const row = settingsRepo.getSetting(key);
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

async function postEmbedVia(api, settingKey, embed) {
    if (!api) return { ok: false, reason: 'no Discord token configured' };

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

/**
 * Post an embed to a channel taken from app_settings, using the main bot's token.
 * @param {string} settingKey  app_settings key holding the channel id
 * @param {object} embed       a plain Discord embed object
 * @returns {Promise<{ok: boolean, reason?: string, messageId?: string}>}
 */
async function postEmbed(settingKey, embed) {
    return postEmbedVia(client(), settingKey, embed);
}

/**
 * Post an embed for battle/leaderboard content, preferring BATTLE_DISCORD_TOKEN's
 * identity when configured and falling back to the main bot's token otherwise.
 * Same signature and return shape as postEmbed.
 */
async function postBattleEmbed(settingKey, embed) {
    return postEmbedVia(battleClient() || client(), settingKey, embed);
}

module.exports = { postEmbed, postBattleEmbed, defuseMentions, settingValue };
