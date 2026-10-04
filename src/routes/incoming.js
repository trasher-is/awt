const express = require('express');
const systemsRepo = require('../repositories/systems');
const playersRepo = require('../repositories/players');
const incomingRepo = require('../repositories/incoming');
const usersRepo = require('../repositories/users');
const { requireAuth } = require('./_middleware');
const { postIncomingOnce, replyToIncoming, replyIncomingCover } = require('../discord_bot');
const { formatTime } = require('../utils/travel-calc');
const { ONTIME_LIMIT, LATE_LIMIT, SOURCE_TAG, computeInterceptors } = require('../utils/interceptors');
const { resolveStats } = require('../utils/battle');
const incomingDefenceRepo = require('../repositories/incomingDefence');
const { HOLDS, allySide, planetFight, ppAfter, sbUpgrade, counterFight, ownerReinforce, pct } = require('../utils/incoming-battle');
const { toggleCovering, getCovering, renderCoverLine } = require('../utils/covering');
const { baseKeyFor, arrivalOf, fleetSigOf, pickAlertKey } = require('../utils/incoming-identity');
const router = express.Router();

// Build the compact attacker stat line shown both inline on the News page and in the
// Discord alert, e.g. "+4/+4/-4 p15 m12 e20 pl7".
//   race speed / attack / defence   physics  math  energy   player-level
// Race + science values are only meaningful when we hold an intel report on the player;
// player level is public, so we always show it.
function statLine(s) {
    if (!s) return '';
    const sign = (n) => (n > 0 ? '+' : '') + (n || 0);
    const lvl = s.level ? ` pl${s.level}` : '';
    if (!s.has_intel) return `(no intel)${lvl}`;
    return `${sign(s.race_speed)}/${sign(s.race_attack)}/${sign(s.race_defense)} p${s.physics || 0} m${s.mathematics || 0} e${s.energy || 0}${lvl}`;
}

function getStatsByIds(ids) {
    const clean = [...new Set(ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (clean.length === 0) return {};
    const rows = playersRepo.getPlayerStatsByIds(clean);

    const out = {};
    for (const r of rows) {
        out[r.id] = { ...r, statLine: statLine(r) };
    }
    return out;
}

// --- CACHED ATTACKER STATS (for inline News-page display) ---
// GET /hub-api/incoming/stats?ids=67,170
router.get('/incoming/stats', requireAuth, (req, res) => {
    try {
        const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
        res.json({ success: true, stats: getStatsByIds(ids) });
    } catch (err) {
        console.error('[Incoming] stats lookup failed:', err.message);
        res.status(500).json({ success: false, error: 'Stats lookup failed' });
    }
});

// Who is being attacked. The game's incoming report names only the attacker and the
// planet, so the defender is resolved from our own planet data — blank for a planet we
// have never scanned, or one whose owner we don't know.
function resolveTargetOwner(target) {
    if (!target || target.systemId == null || target.planetIndex == null) return null;
    try {
        const row = systemsRepo.getPlanetOwnerName(target.systemId, target.planetIndex);
        if (!row || !row.name) return null;
        let mention = null;
        try {
            const u = usersRepo.getUserMentionByGameName(row.name.toLowerCase());
            mention = u && u.discord_id ? `<@${u.discord_id}>` : null;
        } catch (e) { /* no linked Discord account */ }
        return { name: row.name, allianceTag: row.alliance_tag || null, mention };
    } catch (e) {
        return null;
    }
}

function buildAnnounce(data, stats, result, alertKey, owner) {
    const L = [];
    const planet = data.target.planetName || 'Planet';
    L.push(`🚨 **Incoming Attack** — ${planet} \`[${data.target.systemId}] #${data.target.planetIndex}\``);

    // The attacked player, mentioned so they are pinged even when they have no fleet of
    // their own and so never appear in the defender roster below.
    if (owner) {
        L.push(`🎯 **${owner.name}**${owner.allianceTag ? ` [${owner.allianceTag}]` : ''}${owner.mention ? ' ' + owner.mention : ''}`);
    }

    let atk = `⚔️ **${data.attacker.name}**`;
    if (data.attacker.tag) atk += ` [${data.attacker.tag}]`;
    L.push(atk);

    const sline = statLine(stats);
    if (sline) L.push(`🧬 \`${sline}\``);

    const ships = [];
    const s = data.ships || {};
    if (s.transports) ships.push(`${s.transports} TR`);
    if (s.colony) ships.push(`${s.colony} CO`);
    if (s.destroyers) ships.push(`${s.destroyers} DS`);
    if (s.cruisers) ships.push(`${s.cruisers} CR`);
    if (s.battleships) ships.push(`${s.battleships} BS`);
    L.push(`🛰️ **${(data.cv || 0).toLocaleString()} CV**${ships.length ? ' — ' + ships.join(', ') : ''}`);

    const arr = parseInt(data.arrivalUnix, 10);
    if (Number.isInteger(arr) && arr > 0) L.push(`🕐 ~ <t:${arr}:f>`);

    appendDefenders(L, result, data.target);

    // "Covering:" roster — who has clicked "I cover this" (News panel or Discord button).
    // Only non-empty when a News-panel claim landed before the alert was first posted;
    // later claims are replies under the alert.
    const coverLine = renderCoverLine(alertKey != null ? getCovering(alertKey) : []);
    if (coverLine) L.push('\n' + coverLine);
    return L.join('\n');
}

// Run the interceptor analysis for an announce payload. Returns the computeInterceptors
// result (or null if the target system isn't mapped / has no coords).
function computeDefenders(data, owner) {
    if (!data.target || data.target.systemId == null || data.target.planetIndex == null) return null;

    // Defender = the targeted planet's current owner (an alliance member), so the
    // interceptor search is scoped to our alliance.
    const defenderName = (owner === undefined ? resolveTargetOwner(data.target) : owner)?.name || null;
    const planet = incomingDefenceRepo.getPlanetDefence(data.target.systemId, data.target.planetIndex) || null;

    const arr = parseInt(data.arrivalUnix, 10);
    const arrivalUnix = Number.isInteger(arr) && arr > 0 ? arr : 0;
    const nowUnix = Math.floor(Date.now() / 1000);
    const result = computeInterceptors({
        systemId: data.target.systemId,
        planetIndex: data.target.planetIndex,
        defenderName,
        arrivalUnix,
        ownerId: planet && planet.owner_id ? planet.owner_id : null
    }, nowUnix);

    if (result) {
        attachBattle(result, data, planet, arrivalUnix, nowUnix);
        if (result.planet && result.planet.holds >= HOLDS) {
            // The starbase holds on its own: nobody needs to fly, so nobody is listed or
            // pinged. The alert says so instead.
            result.onTime = [];
            result.late = [];
        } else {
            // Only surface defenders with a real shot (≥25%) — anything less is a gamble.
            // Keep entries whose win couldn't be computed (null) so they aren't silently lost.
            const worthIt = d => d.win == null || d.win >= 0.25;
            result.onTime = result.onTime.filter(worthIt);
            if (result.late) result.late = result.late.filter(worthIt);
        }
    }
    return result;
}

// The battle lines (src/utils/incoming-battle.js): the attacker against the planet first,
// then each defender. An ally lands right AFTER the attacker and fights what the starbase
// left of it; the planet's owner lands BEFORE it and stands with his own starbase.
// Attacker race/sciences fall back to worst-case assumptions when unknown/stale.
function attachBattle(result, data, planet, arrivalUnix, nowUnix) {
    try {
        const s = data.ships || {};
        const enemyFleet = [s.destroyers || 0, s.cruisers || 0, s.battleships || 0];
        let enemyRow = null;
        if (data.attacker && data.attacker.id) {
            enemyRow = playersRepo.getPlayerCombatStatsById(data.attacker.id);
        }
        if (!enemyRow && data.attacker && data.attacker.name) {
            enemyRow = playersRepo.getPlayerCombatStatsByName(data.attacker.name.toLowerCase());
        }
        const enemy = resolveStats(enemyRow);

        const ownerLower = planet && planet.owner_name ? planet.owner_name.toLowerCase() : null;
        const owner = ownerLower ? allySide(incomingDefenceRepo.getAllyCombatRow(ownerLower)) : null;
        let fight = null;
        if (planet && owner) {
            const beforeIso = arrivalUnix ? new Date(arrivalUnix * 1000).toISOString() : '9999';
            const garrison = incomingDefenceRepo.getGarrison(planet.owner_id, data.target.systemId, data.target.planetIndex, beforeIso);
            const ctx = { enemyFleet, enemy, sbLevel: planet.starbase || 0, garrison, owner };
            fight = planetFight(ctx);
            if (fight) {
                result.planet = { ...fight, ownerName: planet.owner_name, seenAt: planet.updated_at };
                if (fight.holds < HOLDS) {
                    // What the owner can put into the starbase by arrival: the planet's own
                    // saved PP, or every planet's PP if it is his home.
                    const hours = arrivalUnix ? (arrivalUnix - nowUnix) / 3600 : 0;
                    const mine = incomingDefenceRepo.getOwnerPlanets(planet.owner_id);
                    const here = mine.find(m => m.system_id === data.target.systemId && m.planet_index === data.target.planetIndex);
                    const budgetPp = planet.is_home
                        ? mine.reduce((sum, m) => sum + ppAfter(m, hours), 0)
                        : (here ? ppAfter(here, hours) : 0);
                    const up = budgetPp > 0 ? sbUpgrade({ ...ctx, budgetPp }) : null;
                    // Worth saying even when it still falls: it leaves less for the counter.
                    if (up && (up.holds > fight.holds || up.enemyLeftCv < fight.enemyLeftCv)) {
                        result.sbUpgrade = { ...up, budgetPp, fromHome: !!planet.is_home };
                    }
                }
                ctx.garrisonFleet = garrison;
            }
            result.ctx = ctx;
        }

        const all = [...result.onTime, ...(result.late || [])];
        for (const d of all) {
            const allyFleet = d.ships || [Math.floor(d.cv / 3), 0, 0];
            const ally = allySide(incomingDefenceRepo.getAllyCombatRow(d.name.toLowerCase()));
            let r;
            if (fight && d.name.toLowerCase() === ownerLower) {
                d.mode = 'reinforce';
                r = ownerReinforce({ ...result.ctx, allyFleet });
            } else {
                d.mode = 'counter';
                // Unscanned planet: no starbase fight to weaken them, so the whole fleet.
                r = counterFight({ allyFleet, ally, enemyLeft: fight ? fight.enemyLeft : enemyFleet, enemy });
            }
            d.win = r ? r.win : null;
            d.keepCv = r ? r.keepCv : null;
            d.winUnknown = enemy.unknown; // attacker race not scouted
            // Computed here, not in each renderer, so the Discord alert and the News panel
            // can never quote different numbers for the same fight.
            d.winBand = d.win == null ? null : pct(d.win);
        }
        delete result.ctx;
    } catch (e) {
        console.error('[Incoming] battle calc failed:', e.message);
    }
}

// Game launch deep-link for an existing fleet -> the attack target. Only works for the
// fleet's owner when logged in, and only when we know the fleet's id + the proxy domain.
function launchUrl(a, target) {
    if (!a.fleetId || !process.env.PROXY_DOMAIN || !target || target.systemId == null || target.planetIndex == null) return null;
    return `https://${process.env.PROXY_DOMAIN}/Game/Fleets/Launch/${a.fleetId}?systemId=${target.systemId}&planetIndex=${target.planetIndex}`;
}

// "wins 99% · keeps 210 CV" for an ally landing after the attacker, "holds 99% · keeps …"
// for the owner standing with his starbase. The model is exact to ±0.1pp; the uncertainty
// that matters is the inputs (an unscouted race), which is flagged.
function winTag(a) {
    if (a.win == null) return '';
    const verb = a.mode === 'reinforce' ? 'holds' : 'wins';
    const keep = a.keepCv != null && a.win > 0 ? ` · keeps ${Math.round(a.keepCv).toLocaleString()} CV` : '';
    // An unscouted race is already on the attacker's 🧬 line; once is enough.
    return ` · ${verb} ${a.winBand || pct(a.win)}${keep}`;
}

function defenderLine(a, extra, target) {
    let s = `${SOURCE_TAG[a.source] || ''} **${a.name}**${a.mention ? ' ' + a.mention : ''} \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)}${winTag(a)}${extra || ''}`;
    const url = launchUrl(a, target);
    // Masked links ([text](url)) only render in embeds; this is a plain message (needed
    // so @mentions ping), so use a bare <url> — clickable, with the preview suppressed.
    if (url) s += ` · 🚀 <${url}>`;
    return s;
}

// How long ago a planet was last seen, when that is old enough to doubt its starbase.
function seenAgo(sqliteTs) {
    const ms = sqliteTs ? Date.parse(String(sqliteTs).replace(' ', 'T') + 'Z') : NaN;
    if (!Number.isFinite(ms)) return ' *(starbase level unconfirmed)*';
    const h = (Date.now() - ms) / 3600000;
    if (h < 24) return '';
    return ` *(seen ${Math.floor(h / 24)}d ago)*`;
}

// The planet's own fight: starbase + the owner's ships on it, against the attacker.
function appendPlanet(L, result) {
    const p = result && result.planet;
    if (!p) {
        if (result) L.push('\n🏰 *Planet not scanned — its starbase is unknown; defenders below fight the full fleet.*');
        return;
    }
    const sb = p.sbLevel > 0 ? `SB ${p.sbLevel}` : 'no starbase';
    const garrison = p.garrisonCv > 0 ? ` + ${p.garrisonCv.toLocaleString()} CV fleet` : '';
    if (p.holds >= HOLDS) {
        L.push(`\n🏰 **Holds on its own** — ${sb}${garrison}: ${pct(p.holds)}${seenAgo(p.seenAt)}. No help needed.`);
        return;
    }
    const falls = p.holds > 0 ? `holds ${pct(p.holds)} · if it falls, ` : '';
    L.push(`\n🏰 **Planet alone** — ${sb}${garrison}: ${falls}${Math.round(p.enemyLeftCv).toLocaleString()} CV of theirs stays on it${seenAgo(p.seenAt)}`);
    const up = result.sbUpgrade;
    if (up) {
        const from = up.fromHome ? 'all his planets\' PP (home)' : 'the PP saved there';
        const effect = up.holds >= HOLDS || up.holds > 0.5
            ? `holds ${pct(up.holds)}`
            : `still falls${up.holds > 0 ? ` (holds ${pct(up.holds)})` : ''}, but leaves them ${Math.round(up.enemyLeftCv).toLocaleString()} CV instead of ${Math.round(p.enemyLeftCv).toLocaleString()}`;
        L.push(`🏗️ **${p.ownerName}**: ${from} reaches **SB ${up.level}** by then (${up.cost.toLocaleString()} PP) → ${effect}`);
    }
}

// Append the "who can defend in time" section to the main alert.
function appendDefenders(L, result, target) {
    if (!result) {
        L.push('\n⚠️ *Target system not mapped — cannot compute defenders.*');
        return;
    }
    appendPlanet(L, result);
    if (result.planet && result.planet.holds >= HOLDS) return;

    if (result.unknownTiming) {
        L.push('\n🛡️ **Closest defenders** *(arrival time unknown):*');
        if (!result.onTime.length) { L.push('❌ No allied defenders found.'); return; }
        result.onTime.forEach(a => L.push('• ' + defenderLine(a, a.note ? ` *(${a.note})*` : '', target)));
        return;
    }

    // Allies land right after the attacker; landing first means fighting the ally's own
    // starbase. The owner is the exception: his fleet joins it.
    L.push(result.planet
        ? '\n⚔️ **Land right AFTER them, same cycle** — never before, you\'d fight the starbase:'
        : '\n🛡️ **Can defend in time:**');
    if (!result.onTime.length) {
        L.push('❌ No allied defender can make it in time.');
    } else {
        result.onTime.slice(0, ONTIME_LIMIT).forEach(a => {
            const when = a.mode !== 'reinforce' ? '' : a.eta === 0 ? 'joins your SB, ' : 'land BEFORE them, joins your SB, ';
            L.push('🟢 ' + defenderLine(a, ` *(${when}spare ${formatTime(a.delta)}${a.note ? `, ${a.note}` : ''})*`, target));
        });
        if (result.onTime.length > ONTIME_LIMIT) L.push(`*...and ${result.onTime.length - ONTIME_LIMIT} more in time.*`);
    }

    if (result.late.length) {
        L.push('\n🟡 **Just missing it:**');
        result.late.slice(0, LATE_LIMIT).forEach(a =>
            L.push('🟡 ' + defenderLine(a, ` *(late by ${formatTime(Math.abs(a.delta))}${a.note ? `, ${a.note}` : ''})*`, target)));
    }

    L.push('\n_🛰️ orbit · ✈️ in flight · 🏗️ build & launch_');
}

// The names that count as "able to arrive in time" right now (for change detection).
function onTimeNames(result) {
    if (!result) return [];
    return result.onTime.map(a => a.name.toLowerCase()).sort();
}

// Reply body: only the defenders who can make it, with @mentions so they get pinged.
// Returns null if there's no one to notify.
function buildReply(result, planetLabel, target) {
    if (!result || !result.onTime.length) return null;
    const L = [`🟢 **Reinforcements available** for ${planetLabel} — can arrive in time:`];
    result.onTime.slice(0, ONTIME_LIMIT).forEach(a => {
        const spare = (!result.unknownTiming && a.delta != null) ? ` *(spare ${formatTime(a.delta)})*` : '';
        L.push(defenderLine(a, spare, target));
    });
    return L.join('\n');
}

// Stable identity for an incoming, shared by the webhook auto-post and the News announce
// so both edit the same Discord message: "system:planet:attacker" (attacker lowercased) —
// PLUS the arrival time since issue #143, because the same attacker sending a second wave
// at the same planet is a new incoming, not an update of the first. The rule lives in
// src/utils/incoming-identity.js; this looks up the rows sharing the base identity and,
// when `persist` is set, records what the chosen key stands for so the next report (from
// either reporter, seconds apart) resolves to the same key. Read-only callers (the News
// panel's defender box) pass persist:false so a page render never creates rows. An
// expired report with no recorded match returns null instead of claiming another wave.
function resolveAlertKey(data, { persist } = { persist: true }) {
    const base = baseKeyFor(data);
    const arrival = arrivalOf(data);
    const fleetSig = fleetSigOf(data);
    const picked = pickAlertKey(base, arrival, incomingRepo.findIncomingByBaseKey(base), { fleetSig });
    if (persist && picked.alertKey !== null && (picked.isNew || picked.stampArrival || fleetSig)) {
        // Arrival is only written when it is new information; the signature only fills a
        // row that has none (the repository keeps the first one it saw).
        incomingRepo.ensureIncomingIdentity(picked.alertKey, base, (picked.isNew || picked.stampArrival) ? arrival : 0, fleetSig);
    }
    return picked.alertKey;
}

// --- ANNOUNCE AN INCOMING ON DISCORD ---
// Body: { attacker:{id,name,tag}, target:{systemId,planetIndex,planetName}, cv, ships:{...}, arrivalUnix }
// Core announce logic, shared by the webhook auto-post, the News "announce" button, and the
// dev test harness. Posts the alert once per attack identity (never edits it), and on a
// later report posts a pinging reply when the on-time roster gains someone.
// Returns { ok, existed, replied }.
async function announceIncoming(data) {
    if (!data.attacker || !data.attacker.name || !data.target ||
        data.target.systemId == null || data.target.planetIndex == null) {
        return { ok: false, error: 'Missing attacker/target' };
    }
    // News buttons and delayed webhooks can outlive an incoming. Reject before resolving
    // or sending: even a known old key could create a fresh alert if its Discord message
    // is missing from the configured channel (postIncomingOnce posts it fresh).
    const arrival = arrivalOf(data);
    if (arrival > 0 && arrival <= Math.floor(Date.now() / 1000)) {
        return { ok: false, status: 410, error: 'Incoming has already arrived' };
    }
    const alertKey = resolveAlertKey(data);
    // The clock can cross arrival between the guard above and identity resolution.
    if (alertKey === null) return { ok: false, status: 410, error: 'Incoming has already arrived' };

    let stats = data.attacker.id ? getStatsByIds([data.attacker.id])[data.attacker.id] : null;
    if (!stats) {
        // Webhook only knows the attacker's name — resolve stats by name.
        const row = playersRepo.getPlayerWithAllianceByNameLower(data.attacker.name.toLowerCase());
        if (row) stats = { ...row, statLine: statLine(row) };
    }

    const owner = resolveTargetOwner(data.target);
    const defenders = computeDefenders(data, owner);
    const message = buildAnnounce(data, stats, defenders, alertKey, owner);

    // A known row remains resolvable after landing for Cover/history. If arrival passed
    // during resolution or defender analysis, it still must not reach the Discord sender.
    if (arrival > 0 && arrival <= Math.floor(Date.now() / 1000)) {
        return { ok: false, status: 410, error: 'Incoming has already arrived' };
    }
    const sent = await postIncomingOnce(alertKey, message);
    if (!sent.ok) return { ok: false, error: sent.error };

    // The alert is posted once and never edited, so when the on-time roster GAINS someone
    // (fleet built / TT recalc) we post a reply that mentions the full current list. On a
    // brand-new alert the main message already pinged, so just record state.
    let replied = false;
    const current = onTimeNames(defenders);
    try {
        const prevRow = incomingRepo.getLastOntimeRow(alertKey);
        const prev = prevRow && prevRow.last_ontime ? prevRow.last_ontime.split(',').filter(Boolean) : [];
        const prevSet = new Set(prev);
        const newcomers = current.filter(n => !prevSet.has(n));

        if (sent.existed && newcomers.length > 0) {
            const planetLabel = `${data.target.planetName || 'Planet'} [${data.target.systemId}] #${data.target.planetIndex}${owner ? ` (${owner.name})` : ''}`;
            const reply = buildReply(defenders, planetLabel, data.target);
            if (reply) replied = await replyToIncoming(sent.channelId, sent.messageId, reply);
        }
        incomingRepo.updateLastOntime(alertKey, current.join(','));
    } catch (e) {
        console.error('[Incoming] reply bookkeeping failed:', e.message);
    }

    return { ok: true, existed: !!sent.existed, replied };
}

// --- ANNOUNCE / UPDATE AN INCOMING ON DISCORD ---
// POST /hub-api/incoming/announce
// Body: { fleetId, attacker:{id,name,tag}, target:{planetId,systemId,planetIndex,planetName}, cv, ships:{...}, arrivalUnix }
router.post('/incoming/announce', requireAuth, async (req, res) => {
    try {
        const r = await announceIncoming(req.body || {});
        if (!r.ok) return res.status(r.status || (r.error && r.error.startsWith('Missing') ? 400 : 502)).json({ success: false, error: r.error });
        res.json({ success: true, existed: r.existed, replied: r.replied });
    } catch (err) {
        console.error('[Incoming] announce failed:', err.message);
        res.status(500).json({ success: false, error: 'Announce failed' });
    }
});

// --- DEFENDER ANALYSIS (for inline display on the News page) ---
// POST /hub-api/incoming/defenders  Body: { target:{systemId,planetIndex}, arrivalUnix, attacker, ships, cv }
// Returns the on-time / late interceptor lists (no Discord mentions — page display only).
router.post('/incoming/defenders', requireAuth, (req, res) => {
    try {
        const data = req.body || {};
        const result = computeDefenders(data);
        if (!result) return res.json({ success: true, mapped: false });
        const slim = (a) => ({
            name: a.name, cv: a.cv, eta: a.eta, delta: a.delta, source: a.source, note: a.note,
            ownerId: a.ownerId, originSys: a.originSys, originIdx: a.originIdx, fleetId: a.fleetId,
            win: a.win, winBand: a.winBand, winUnknown: a.winUnknown, keepCv: a.keepCv, mode: a.mode
        });
        const alertKey = resolveAlertKey(data, { persist: false });
        const pl = result.planet;
        res.json({
            success: true,
            mapped: true,
            unknownTiming: !!result.unknownTiming,
            // The planet's own fight (starbase + garrison), so the panel reads like the alert.
            planet: pl ? { holds: pl.holds, holdsText: pct(pl.holds), sbLevel: pl.sbLevel, garrisonCv: pl.garrisonCv,
                enemyLeftCv: Math.round(pl.enemyLeftCv), ownerName: pl.ownerName, holdsAlone: pl.holds >= HOLDS } : null,
            sbUpgrade: result.sbUpgrade ? { level: result.sbUpgrade.level, cost: result.sbUpgrade.cost,
                holds: result.sbUpgrade.holds, holdsText: pct(result.sbUpgrade.holds),
                enemyLeftCv: Math.round(result.sbUpgrade.enemyLeftCv), fromHome: result.sbUpgrade.fromHome } : null,
            onTime: result.onTime.map(slim),
            late: (result.late || []).map(slim),
            covering: alertKey === null ? [] : getCovering(alertKey)
        });
    } catch (err) {
        console.error('[Incoming] defenders lookup failed:', err.message);
        res.status(500).json({ success: false, error: 'Defender lookup failed' });
    }
});

// --- "I COVER THIS" — claim/retract defence of an incoming ---
// POST /hub-api/incoming/cover  Body: { attacker:{name}, target:{systemId,planetIndex}, arrivalUnix }
// Toggles the logged-in user into the covering roster and posts it as a reply under the
// Discord alert. Returns the updated roster so the News panel can reflect it.
router.post('/incoming/cover', requireAuth, async (req, res) => {
    try {
        const data = req.body || {};
        if (!data.attacker || !data.attacker.name || !data.target ||
            data.target.systemId == null || data.target.planetIndex == null) {
            return res.status(400).json({ success: false, error: 'Missing attacker/target' });
        }
        const name = req.session.gameName;
        if (!name) return res.status(401).json({ success: false, error: 'No session name' });

        const alertKey = resolveAlertKey(data);
        if (alertKey === null) {
            return res.status(410).json({ success: false, error: 'No recorded incoming for this expired arrival' });
        }
        const { covering, added } = toggleCovering(alertKey, name);
        // Best-effort: say so under the Discord alert (if one exists).
        await replyIncomingCover(alertKey, name, added);
        res.json({ success: true, covering, added });
    } catch (err) {
        console.error('[Incoming] cover toggle failed:', err.message);
        res.status(500).json({ success: false, error: 'Cover toggle failed' });
    }
});

module.exports = router;
module.exports.announceIncoming = announceIncoming;
// For tests and the replay script: the analysis and the text, without Discord.
module.exports.computeDefenders = computeDefenders;
module.exports.buildAnnounce = buildAnnounce;
