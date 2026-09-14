// Renders the "target dossier" panel injected into the fleet-launch form
// (/Game/Fleets/Launch/{id}) once a destination system + planet are both selected —
// everything the hub knows about that one planet: owner, population, Starbase, siege
// status, Best Guarded flag, who has a fleet there (ours flagged separately), and any
// recent battle at that planet or nearby in the same system.
//
// Pure and import-free on purpose — same reasoning as siege-indicator-parser.js's own
// header comment: a Node test can exercise this directly with no DOM, and a temp-file
// dynamic-import test doesn't have to untangle relative imports across a copied file. The
// two things duplicated here as a result — HTML escaping, ship combat values — are small,
// stable, and already duplicated at least once elsewhere in this codebase for the exact
// same reason (escape.js's own esc(), interceptors.js's SHIPS table).
//
// LOADING: same dual Node/browser pattern as capture-freshness.js/daily-reset.js.
//   • Node:    require('../../public/js/utils/fleet-launch-target-dossier.js')
//   • Browser: import '../utils/fleet-launch-target-dossier.js'; then read
//              globalThis.AWTargetDossier
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWTargetDossier = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, ch => HTML_ENTITIES[ch]);
    }

    // Destroyer/Cruiser/Battleship combat values — stable game constants (matches
    // src/utils/interceptors.js's SHIPS table). Transports and Colony Ships carry 0 CV.
    const SHIP_CV = { destroyers: 3, cruisers: 24, battleships: 60 };
    function fleetCv(f) {
        if (!f) return 0;
        return (Number(f.destroyers) || 0) * SHIP_CV.destroyers
             + (Number(f.cruisers) || 0) * SHIP_CV.cruisers
             + (Number(f.battleships) || 0) * SHIP_CV.battleships;
    }

    function relativeAge(ms) {
        if (!Number.isFinite(ms) || ms < 0) return null;
        const mins = Math.round(ms / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.round(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.round(hours / 24)}d ago`;
    }

    // Hub timestamps without a zone are UTC but carry no marker (see sqlite-time.js) —
    // this module stays import-free, so it normalizes the one shape it actually receives
    // ("YYYY-MM-DD HH:MM:SS", CURRENT_TIMESTAMP's format) the same way, rather than
    // pulling in the shared parser. An already-offset ISO string passes through untouched.
    function toMs(ts) {
        if (!ts) return NaN;
        const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts;
        const d = new Date(iso);
        return Number.isFinite(d.getTime()) ? d.getTime() : NaN;
    }

    function fleetLine(f) {
        const cv = fleetCv(f);
        const tag = f.alliance_tag ? `[${esc(f.alliance_tag)}] ` : '';
        const color = f.is_own_alliance ? '#4ade80' : '#f87171';
        const eta = f.arrival_at || f.arrival_time
            ? ` — ETA ${esc(f.arrival_time || '')}`
            : '';
        const label = f.is_own_alliance ? ' (ally)' : '';
        return `<div style="color:${color}">🚀 ${tag}${esc(f.owner_name || 'Unknown')} — ${cv.toLocaleString()} CV${eta}${label}</div>`;
    }

    function battleLine(b, now) {
        const age = relativeAge(now - toMs(b.started_at));
        const winner = String(b.winner || '').toLowerCase();
        const outcome = winner === 'attacker' ? 'attacker won' : winner === 'defender' ? 'defender won' : 'outcome unknown';
        const conquered = b.conquered_planet ? ', planet conquered' : '';
        const attTag = b.att_alliance_tag ? ` [${esc(b.att_alliance_tag)}]` : '';
        const defTag = b.def_alliance_tag ? ` [${esc(b.def_alliance_tag)}]` : '';
        return `<div style="color:#aaa">⚔️ ${age ? esc(age) : 'recently'} — `
            + `${esc(b.att_player_name || '?')}${attTag} vs ${esc(b.def_player_name || '?')}${defTag} — ${outcome}${conquered}</div>`;
    }

    // data: the /hub-api/intel/target-dossier response body (system, planet, fleets,
    // recentBattles). now: injectable for tests, defaults to the real clock.
    function buildTargetDossierHtml(data, { now = Date.now() } = {}) {
        if (!data) return '';
        const { system, planet, fleets, recentBattles } = data;
        const safeFleets = Array.isArray(fleets) ? fleets : [];
        const safeBattles = Array.isArray(recentBattles) ? recentBattles : [];

        if (!planet) {
            const why = system ? 'no intel on file for this planet yet' : 'this system has never been observed';
            return `<div style="color:#888">🎯 ${esc(why)}.</div>`;
        }

        const lines = [];

        const tag = planet.alliance_tag ? `[${esc(planet.alliance_tag)}] ` : '';
        const owner = planet.owner_name ? `${tag}${esc(planet.owner_name)}` : 'Free / unclaimed';
        const freshness = system && system.observed_at ? relativeAge(now - toMs(system.observed_at)) : null;
        lines.push(`<div>🎯 <strong>${owner}</strong>`
            + (freshness ? ` <span style="color:#888">(last observed ${esc(freshness)})</span>` : '') + `</div>`);

        const stats = [];
        if (Number.isFinite(planet.population)) stats.push(`Pop ${planet.population}`);
        if (Number.isFinite(planet.starbase)) stats.push(`SB ${planet.starbase}`);
        if (planet.guard_cv) stats.push(`🛡 Best Guarded (${esc(planet.guard_cv)} CV)`);
        if (stats.length) lines.push(`<div style="color:#ccc">${stats.join(' · ')}</div>`);

        if (planet.is_sieged) {
            const friendly = planet.siege_is_friendly === 1;
            const hostile = planet.siege_is_friendly === 0;
            const label = friendly ? 'Under siege (friendly)' : hostile ? 'Under siege (hostile)' : 'Under siege (allegiance unknown)';
            lines.push(`<div style="color:${friendly ? '#4ade80' : '#f87171'}">${friendly ? '🛡️' : '⚔️'} ${label}</div>`);
        }

        if (safeFleets.length) {
            lines.push(...safeFleets.map(fleetLine));
        } else {
            lines.push('<div style="color:#888">No fleets detected here.</div>');
        }

        if (safeBattles.length) {
            lines.push(...safeBattles.map(b => battleLine(b, now)));
        }

        return lines.join('');
    }

    return { buildTargetDossierHtml, relativeAge, fleetCv, esc };
});
