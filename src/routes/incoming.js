const express = require('express');
const systemsRepo = require('../repositories/systems');
const playersRepo = require('../repositories/players');
const incomingRepo = require('../repositories/incoming');
const usersRepo = require('../repositories/users');
const { requireAuth } = require('./_middleware');
const { postIncomingOnce, replyToIncoming, replyIncomingCover } = require('../discord_bot');
const { SOURCE_TAG, computeInterceptors } = require('../utils/interceptors');
const { resolveStats } = require('../utils/battle');
const incomingDefenceRepo = require('../repositories/incomingDefence');
const { HOLDS, allySide, planetFight, ppAfter, sbUpgrade, sbLevels, counterFight, landBefore, ownerReinforce, pct, fleetText } = require('../utils/incoming-battle');
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

    // The battle lines assume the worst about what we do not know; say so where it applies.
    const sline = statLine(stats);
    if (!stats) L.push('🧬 `never scanned` — worst case assumed (+4 attack, +4 defence)');
    else if (!stats.has_intel) L.push(`🧬 \`${sline}\` — race unknown, worst case assumed (+4/+4)`);
    else if (sline) L.push(`🧬 \`${sline}\``);

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

    appendDefenders(L, result, data.target, alertKey);

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
        result.window = cycleWindow(arrivalUnix);
        rankOptions(result, arrivalUnix);
        if (result.planet && result.planet.holds >= HOLDS) {
            // The starbase holds on its own: nobody needs to fly, so nobody is listed or
            // pinged. The alert says so instead.
            result.onTime = [];
            result.late = [];
        } else {
            // Only surface defenders with a real shot (≥25%) — anything less is a gamble.
            // Keep entries whose win couldn't be computed (null) so they aren't silently lost.
            const worthIt = d => d.win == null || d.bestWin >= 0.25;
            // The owner first: his own fleet joining his starbase is the plain answer.
            result.onTime = result.onTime.filter(worthIt)
                .sort((a, b) => (b.mode === 'reinforce') - (a.mode === 'reinforce'));
            if (result.late) result.late = result.late.filter(worthIt);
        }
    }
    return result;
}

// The 2-minute fleet cycle the attack lands in (docs/game-rules.md): an attacker landing at
// 00:02:30 sits in 00:02:00-00:03:59 and can leave from 00:04:00, so a counter-attack has
// to land between his arrival and the cycle's last second. Cycles are aligned to the even
// minute.
const CYCLE_SEC = 120;
function cycleWindow(arrivalUnix) {
    if (!arrivalUnix) return null;
    const start = Math.floor(arrivalUnix / CYCLE_SEC) * CYCLE_SEC;
    return { arrival: arrivalUnix, cycleStart: start, cycleEnd: start + CYCLE_SEC - 1 };
}

const KEEP_RETAKE_LIMIT = 3;
const REAL_CHANCE = 0.25;

// The two lists the alert shows (top 3 each, one line per member) and the panel heads with.
//   keep   — land BEFORE the attacker and hold the planet: the owner's fleet joining his
//            starbase, or an ally killing the starbase first. Must land strictly before
//            him (same second: he launched first, so he lands first).
//   retake — land AFTER him, inside his cycle, against what the starbase left.
// Ranked by chance, then by ships kept. Each option gets launchFrom/launchBy for its role.
function rankOptions(result, arrivalUnix) {
    const w = cycleWindow(arrivalUnix);
    const opts = result.options || [];
    const timed = w != null;
    const keepVal = o => (o.mode === 'reinforce'
        ? { win: o.win, keepCv: o.keepCv }
        : o.before ? { win: o.before.win, keepCv: o.before.keepCv } : null);
    const keep = [], retake = [];
    for (const o of opts) {
        const k = keepVal(o);
        if (k && k.win != null && k.win >= REAL_CHANCE && (!timed || o.eta < w.arrival - result.nowUnix)) {
            keep.push({ opt: o, win: k.win, keepCv: k.keepCv, launchBy: timed ? w.arrival - 1 - o.eta : null });
        }
        if (o.mode === 'counter' && o.win != null && o.win >= REAL_CHANCE && (!timed || o.eta <= w.cycleEnd - result.nowUnix)) {
            retake.push({ opt: o, win: o.win, keepCv: o.keepCv,
                launchFrom: timed ? Math.max(result.nowUnix, w.arrival - o.eta) : null,
                launchBy: timed ? w.cycleEnd - o.eta : null });
        }
    }
    const best = list => {
        const byName = new Map();
        for (const e of list.sort((a, b) => b.win - a.win || (b.keepCv || 0) - (a.keepCv || 0))) {
            const k = e.opt.name.toLowerCase();
            if (!byName.has(k)) byName.set(k, e);
        }
        return [...byName.values()];
    };
    result.keepAll = best(keep);
    result.retakeAll = best(retake);
    result.keep = result.keepAll.slice(0, KEEP_RETAKE_LIMIT);
    result.retake = result.retakeAll.slice(0, KEEP_RETAKE_LIMIT);
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
        const enemy = {
            ...resolveStats(enemyRow),
            totalXp: incomingDefenceRepo.getTotalXp({
                id: data.attacker && data.attacker.id,
                nameLower: data.attacker && data.attacker.name ? data.attacker.name.toLowerCase() : null,
            }),
        };

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
                    // Every affordable level, for the Defence panel.
                    result.sbBudget = { budgetPp, fromHome: !!planet.is_home };
                    result.sbOptions = budgetPp > 0 ? sbLevels({ ...ctx, budgetPp }) : [];
                    // Worth saying even when it still falls: it leaves less for the counter.
                    if (up && (up.holds > fight.holds || up.enemyLeftCv < fight.enemyLeftCv)) {
                        result.sbUpgrade = { ...up, budgetPp, fromHome: !!planet.is_home };
                    }
                }
                ctx.garrisonFleet = garrison;
            }
            result.ctx = ctx;
        }

        result.nowUnix = nowUnix;
        const all = result.options || [...result.onTime, ...(result.late || [])];
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
                // After the starbase fight the attacker may have levelled up (enemyAfter).
                r = counterFight({ allyFleet, ally, enemyLeft: fight ? fight.enemyLeft : enemyFleet, enemy: fight ? fight.enemyAfter : enemy });
                // Or land BEFORE them: kill the starbase, keep the planet (2026-10-04).
                if (fight) {
                    const b = landBefore({ allyFleet, ally, owner: result.ctx.owner, sbLevel: result.ctx.sbLevel, enemyFleet, enemy });
                    if (b) d.before = { win: b.win, winBand: pct(b.win), keepCv: b.keepCv, sbCostCv: b.sbCostCv };
                }
            }
            d.win = r ? r.win : null;
            d.keepCv = r ? r.keepCv : null;
            // Listed when either way gives a real chance; filtered on this.
            d.bestWin = Math.max(d.win == null ? 0 : d.win, d.before ? d.before.win : 0);
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

// How long ago a planet was last seen, when that is old enough to doubt its starbase.
function seenAgo(sqliteTs) {
    const ms = sqliteTs ? Date.parse(String(sqliteTs).replace(' ', 'T') + 'Z') : NaN;
    if (!Number.isFinite(ms)) return ' *(starbase level unconfirmed)*';
    const h = (Date.now() - ms) / 3600000;
    if (h < 24) return '';
    return ` *(seen ${Math.floor(h / 24)}d ago)*`;
}

// "13.7 BS, 1 CR (820 CV)"
function enemyLeftText(fleet, cv) {
    return `${fleetText(fleet)} (${Math.round(cv).toLocaleString()} CV)`;
}

// "holds 3% · if it falls, the enemy keeps 13.7 BS (820 CV) and reaches PL 6 (+515 XP)"
function planetOutcome(p) {
    const head = p.holds > 0 ? `holds ${pct(p.holds)} · if it falls, the enemy keeps ` : 'falls · the enemy keeps ';
    const lvl = p.enemyLvlAfter > p.enemyLvlBefore
        ? ` and reaches PL ${p.enemyLvlAfter} (+${p.enemyXp.toLocaleString()} XP)`
        : '';
    return `${head}${enemyLeftText(p.enemyLeft, p.enemyLeftCv)}${lvl}`;
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
    L.push(`\n🏰 **Planet alone** — ${sb}${garrison}: ${planetOutcome(p)}${seenAgo(p.seenAt)}`);
    const up = result.sbUpgrade;
    if (up) {
        const from = up.fromHome ? 'all his planets\' PP (home)' : 'the PP saved there';
        const effect = up.holds >= HOLDS || up.holds > 0.5
            ? `holds ${pct(up.holds)}`
            : `still falls${up.holds > 0 ? ` (holds ${pct(up.holds)})` : ''}, but the enemy keeps only ${enemyLeftText(up.enemyLeft, up.enemyLeftCv)}`;
        L.push(`🏗️ **${p.ownerName}**: ${from} reaches **SB ${up.level}** by then (${up.cost.toLocaleString()} PP) → ${effect}`);
    }
}

// The Defence panel for this attack, on the hub (login-gated). null without PROXY_DOMAIN.
function panelUrl(alertKey) {
    if (!process.env.PROXY_DOMAIN || alertKey == null) return null;
    return `https://${process.env.PROXY_DOMAIN}/dashboard?defence=${encodeURIComponent(alertKey)}`;
}

// One ranked line: "1. 🏗️ Moardin25 @ [1,230 CV] · holds 47%, keeps 453 CV · launch by 14:02:10 (build …)"
function rankedLine(i, e, role, target) {
    const a = e.opt;
    const kept = e.keepCv != null && e.win > 0 ? `, keeps ${Math.round(e.keepCv).toLocaleString()} CV` : '';
    const verb = role === 'keep' ? 'holds' : 'retakes';
    let when = '';
    if (role === 'keep' && e.launchBy != null) when = ` · ${a.eta === 0 ? 'build' : 'launch'} by <t:${e.launchBy}:T>`;
    if (role === 'retake' && e.launchBy != null) when = ` · launch <t:${e.launchFrom}:T>–<t:${e.launchBy}:T>`;
    const how = role === 'keep'
        ? (a.mode === 'reinforce' ? 'own fleet + SB' : 'kills the SB first')
        : '';
    const notes = [how, a.note].filter(Boolean).join(', ');
    let s = `${i + 1}. ${SOURCE_TAG[a.source] || ''} **${a.name}**${a.mention ? ' ' + a.mention : ''} \`[${a.cv.toLocaleString()} CV]\` · ${verb} ${pct(e.win)}${kept}${when}${notes ? ` *(${notes})*` : ''}`;
    const url = launchUrl(a, target);
    if (url) s += ` · 🚀 <${url}>`;
    return s;
}

// The defence section: the planet's own fight, then the top 3 ways to KEEP it and the top
// 3 ways to RETAKE it, and a link to the Defence panel with every option, live. The
// alert is a snapshot (never edited); the panel is not.
function appendDefenders(L, result, target, alertKey) {
    if (!result) {
        L.push('\n⚠️ *Target system not mapped — cannot compute defenders.*');
        return;
    }
    appendPlanet(L, result);
    const url = panelUrl(alertKey);
    const link = () => { if (url) L.push(`\n📋 **All options, live:** <${url}>`); };
    if (result.planet && result.planet.holds >= HOLDS) { link(); return; }

    const w = result.window;
    L.push(w ? `\n🛡️ **Keep it** — land before <t:${w.arrival}:T>:` : '\n🛡️ **Keep it** — land before them *(arrival time unknown)*:');
    if (result.keep && result.keep.length) result.keep.forEach((e, i) => L.push(rankedLine(i, e, 'keep', target)));
    else L.push('❌ Nobody can keep it with a real chance (25%+).');

    L.push(w ? `\n⚔️ **Retake it** — land <t:${w.arrival}:T>–<t:${w.cycleEnd}:T>, same cycle, before they can leave:`
        : '\n⚔️ **Retake it** — land right after them, same cycle:');
    if (result.retake && result.retake.length) result.retake.forEach((e, i) => L.push(rankedLine(i, e, 'retake', target)));
    else L.push('❌ Nobody can retake it in time with a real chance (25%+).');

    const more = (result.keepAll || []).length + (result.retakeAll || []).length - (result.keep || []).length - (result.retake || []).length;
    L.push(`\n_🛰️ orbit · ✈️ in flight · 🏗️ build${more > 0 ? ` · ${more} more option${more === 1 ? '' : 's'} in the panel` : ''}_`);
    link();
}

// The names on the alert's two lists right now (for change detection: a reply pings
// whoever newly makes a list).
function onTimeNames(result) {
    if (!result) return [];
    const names = [...(result.keep || []), ...(result.retake || [])].map(e => e.opt.name.toLowerCase());
    return [...new Set(names)].sort();
}

// Reply body when someone newly makes one of the lists: the two lists again, with
// @mentions so they get pinged. null if both are empty.
function buildReply(result, planetLabel, target) {
    if (!result || (!(result.keep || []).length && !(result.retake || []).length)) return null;
    const L = [`🟢 **New defence options** for ${planetLabel}:`];
    if ((result.keep || []).length) { L.push('🛡️ Keep it:'); result.keep.forEach((e, i) => L.push(rankedLine(i, e, 'keep', target))); }
    if ((result.retake || []).length) { L.push('⚔️ Retake it:'); result.retake.forEach((e, i) => L.push(rankedLine(i, e, 'retake', target))); }
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
    // The report itself, for the Defence panel to recompute live (the alert never changes).
    try {
        incomingRepo.savePayload(alertKey, {
            attacker: { id: data.attacker.id || null, name: data.attacker.name, tag: data.attacker.tag || null },
            target: data.target, cv: data.cv || 0, ships: data.ships || {}, arrivalUnix: arrival || 0,
            fleetId: data.fleetId || null,
        });
    } catch (e) {
        console.error('[Incoming] could not store the report:', e.message);
    }

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
            win: a.win, winBand: a.winBand, winUnknown: a.winUnknown, keepCv: a.keepCv, mode: a.mode, before: a.before || null
        });
        const alertKey = resolveAlertKey(data, { persist: false });
        const pl = result.planet;
        res.json({
            success: true,
            mapped: true,
            unknownTiming: !!result.unknownTiming,
            // The planet's own fight (starbase + garrison), so the panel reads like the alert.
            planet: pl ? { holds: pl.holds, holdsText: pct(pl.holds), sbLevel: pl.sbLevel, garrisonCv: pl.garrisonCv,
                enemyLeftCv: Math.round(pl.enemyLeftCv), outcomeText: planetOutcome(pl),
                ownerName: pl.ownerName, holdsAlone: pl.holds >= HOLDS } : null,
            sbUpgrade: result.sbUpgrade ? { level: result.sbUpgrade.level, cost: result.sbUpgrade.cost,
                holds: result.sbUpgrade.holds, holdsText: pct(result.sbUpgrade.holds),
                enemyLeftCv: Math.round(result.sbUpgrade.enemyLeftCv),
                enemyLeftText: enemyLeftText(result.sbUpgrade.enemyLeft, result.sbUpgrade.enemyLeftCv),
                fromHome: result.sbUpgrade.fromHome } : null,
            onTime: result.onTime.map(slim),
            late: (result.late || []).map(slim),
            covering: alertKey === null ? [] : getCovering(alertKey)
        });
    } catch (err) {
        console.error('[Incoming] defenders lookup failed:', err.message);
        res.status(500).json({ success: false, error: 'Defender lookup failed' });
    }
});

// --- DEFENCE PANEL ---
// Every live attack, light: for the sidebar warning and the panel's list. No battle maths,
// so the whole alliance can poll it every minute.
// GET /hub-api/defence/live
router.get('/defence/live', requireAuth, (req, res) => {
    try {
        const nowSec = Math.floor(Date.now() / 1000);
        const attacks = incomingRepo.getLiveIncomings(nowSec).map(r => {
            const p = r.payload;
            const owner = resolveTargetOwner(p.target);
            return {
                key: r.alert_key, arrivalUnix: r.arrival_unix,
                attacker: { name: p.attacker.name, tag: p.attacker.tag },
                target: p.target, cv: p.cv, ships: p.ships,
                ownerName: owner ? owner.name : null,
                covering: r.covering ? r.covering.split('\n').filter(Boolean) : [],
            };
        });
        res.json({ success: true, nowUnix: nowSec, attacks });
    } catch (err) {
        console.error('[Defence] live list failed:', err.message);
        res.status(500).json({ success: false, error: 'Live list failed' });
    }
});

// One option as the panel needs it (no Discord mention markup).
function panelOption(o) {
    return {
        name: o.name, source: o.source, cv: o.cv, ships: o.ships, eta: o.eta, delta: o.delta ?? null,
        note: o.note || '', mode: o.mode || null, fleetId: o.fleetId || null,
        originSys: o.originSys ?? null, originIdx: o.originIdx ?? null,
        after: o.mode === 'counter' && o.win != null ? { win: o.win, winText: pct(o.win), keepCv: o.keepCv } : null,
        before: o.mode === 'reinforce'
            ? (o.win != null ? { win: o.win, winText: pct(o.win), keepCv: o.keepCv, own: true } : null)
            : (o.before ? { win: o.before.win, winText: pct(o.before.win), keepCv: o.before.keepCv, sbCostCv: o.before.sbCostCv } : null),
    };
}
const panelRanked = e => ({ name: e.opt.name, source: e.opt.source, cv: e.opt.cv, note: e.opt.note || '', mode: e.opt.mode,
    win: e.win, winText: pct(e.win), keepCv: e.keepCv, launchFrom: e.launchFrom ?? null, launchBy: e.launchBy ?? null, eta: e.opt.eta });

// The full, live analysis of one attack: everything the alert shows and every option of
// every member, the viewer's own first.
// GET /hub-api/defence/attack?key=<alert key>
router.get('/defence/attack', requireAuth, (req, res) => {
    try {
        const row = incomingRepo.getIncoming(String(req.query.key || ''));
        if (!row) return res.status(404).json({ success: false, error: 'No such incoming' });
        const data = row.payload;
        const owner = resolveTargetOwner(data.target);
        const result = computeDefenders(data, owner);
        let stats = data.attacker.id ? getStatsByIds([data.attacker.id])[data.attacker.id] : null;
        if (!stats) {
            const r = playersRepo.getPlayerWithAllianceByNameLower(String(data.attacker.name).toLowerCase());
            if (r) stats = { ...r, statLine: statLine(r) };
        }
        const me = String(req.session.gameName || '').toLowerCase();
        const byMember = new Map();
        for (const o of (result && result.options) || []) {
            if (!byMember.has(o.name)) byMember.set(o.name, []);
            byMember.get(o.name).push(panelOption(o));
        }
        const bestOf = list => Math.max(0, ...list.map(o => Math.max(o.before ? o.before.win : 0, o.after ? o.after.win : 0)));
        const members = [...byMember].map(([name, options]) => ({
            name, me: name.toLowerCase() === me,
            options: options.sort((a, b) => a.eta - b.eta),
        })).sort((a, b) => (b.me - a.me) || (bestOf(b.options) - bestOf(a.options)));
        const pl = result && result.planet;
        res.json({
            success: true,
            key: row.alert_key, nowUnix: Math.floor(Date.now() / 1000),
            attacker: { name: data.attacker.name, tag: data.attacker.tag, statLine: stats ? stats.statLine : null,
                scanned: !!stats, raceKnown: !!(stats && stats.has_intel) },
            target: data.target, ownerName: owner ? owner.name : null,
            cv: data.cv, ships: data.ships, arrivalUnix: data.arrivalUnix || row.arrival_unix || null,
            window: result ? result.window : null,
            mapped: !!result,
            planet: pl ? {
                holds: pl.holds, holdsText: pct(pl.holds), holdsAlone: pl.holds >= HOLDS,
                sbLevel: pl.sbLevel, garrisonCv: pl.garrisonCv, seenAt: pl.seenAt,
                enemyLeft: pl.enemyLeft, enemyLeftText: enemyLeftText(pl.enemyLeft, pl.enemyLeftCv),
                enemyXp: pl.enemyXp, enemyLvlBefore: pl.enemyLvlBefore, enemyLvlAfter: pl.enemyLvlAfter,
                outcomeText: planetOutcome(pl),
            } : null,
            sbBudget: result && result.sbBudget ? result.sbBudget : null,
            sbOptions: ((result && result.sbOptions) || []).map(o => ({ level: o.level, cost: o.cost, holds: o.holds,
                holdsText: pct(o.holds), enemyLeftText: enemyLeftText(o.enemyLeft, o.enemyLeftCv) })),
            keep: ((result && result.keepAll) || []).map(panelRanked),
            retake: ((result && result.retakeAll) || []).map(panelRanked),
            members,
            covering: getCovering(row.alert_key),
        });
    } catch (err) {
        console.error('[Defence] attack analysis failed:', err.message);
        res.status(500).json({ success: false, error: 'Analysis failed' });
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
