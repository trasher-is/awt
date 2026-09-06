// The three player-stats tables, as data: one column definition drives the header cell,
// the body cell, the sort rule and the entry in the column picker.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// "Add all stats for players in Alliance stats, in War room, in Players table" (issue #113)
// turns three hand-written <thead>/<tr> template pairs into three pairs of thirty-plus
// columns each — and a header and a row template that have to agree cell for cell. They
// did not always: the war room's colspan placeholders said 16 in one place and 17 in
// another. With the columns as an array there is nothing to keep in step: the header, the
// row and the picker all iterate the same list, and a column that exists in one exists in
// all three.
//
// The rule for what a cell may show is the repository's: a deep-scan value (race picks,
// sciences, trade, artefact, CV, buildings) is shown only when the hub actually captured it
// (has_intel / stats_scraped_at), and reads "?" otherwise — never a zero dressed up as a
// fact. Public-profile values (level, points, ranking, planets, joined...) are always shown.
//
// This module is DOM-free on purpose: it returns HTML strings and sorted arrays, so the
// definitions can be exercised in Node (src/utils/column-prefs.test.js). archives.js does
// the document work.

import { esc } from '../utils/escape.js';
import '../utils/parse-number.js';   // side-effect import: AWNumber.compareNumeric, one locale parser
const { compareNumeric } = globalThis.AWNumber;

// ─── FORMATTING HELPERS (shared by archives.js) ───────────────────────────────

// SQLite CURRENT_TIMESTAMP returns 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker.
// new Date() would read that as local time, so we explicitly tag it as UTC before parsing.
export function parseSqliteUtc(ts) {
    if (!ts) return null;
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
}

export function parseIdleStringToSeconds(idleStr) {
    if (!idleStr || idleStr === 'Unknown') return -1;
    if (/active|online/i.test(idleStr)) return 0;
    let secs = 0;
    const d = idleStr.match(/(\d+)\s*d/);
    const h = idleStr.match(/(\d+)\s*h/);
    const m = idleStr.match(/(\d+)\s*m/);
    const s = idleStr.match(/(\d+)\s*s/);
    if (!d && !h && !m && !s) return -1;
    if (d) secs += parseInt(d[1], 10) * 86400;
    if (h) secs += parseInt(h[1], 10) * 3600;
    if (m) secs += parseInt(m[1], 10) * 60;
    if (s) secs += parseInt(s[1], 10);
    return secs;
}

export function formatIdleSeconds(secs) {
    if (secs < 60) return 'active';
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// Idle display, preferring a real timestamp (last_activity_at, from the API's background
// detail sweep — near-total roster coverage) over the DOM-scrape-only idle_time string
// (about half the roster, and frozen at whatever moment it was last scraped, so it only
// gets MORE wrong the longer it's been since). last_activity_at is raw ISO8601 with its own
// offset (e.g. "...T...+02:00"), NOT SQLite's space-separated format — parseSqliteUtc above
// assumes the latter and would silently fail on it, so this reads it directly instead.
export function computeIdleDisplay(p, { activityField = 'last_activity_at', now = Date.now() } = {}) {
    if (p[activityField]) {
        const d = new Date(p[activityField]);
        if (!isNaN(d.getTime())) {
            const secs = Math.max(0, Math.floor((now - d.getTime()) / 1000));
            return { secs, text: formatIdleSeconds(secs) };
        }
    }
    if (p.idle_time) return { secs: parseIdleStringToSeconds(p.idle_time), text: p.idle_time };
    return { secs: -1, text: 'Unknown' };
}

export function formatRaceModifier(val, isMasked) {
    if (isMasked) return '<span class="text-zinc-600">?</span>';
    if (val === null || val === undefined) return '<span class="text-zinc-500">-</span>';
    return val > 0 ? `<span class="text-emerald-500 font-bold">+${val}</span>` : val < 0 ? `<span class="text-rose-500 font-bold">${val}</span>` : `<span class="text-zinc-400">${val}</span>`;
}

// Parse a DB timestamp that may be ISO ("2026-06-22T10:00:00.000Z") or a sqlite
// "YYYY-MM-DD HH:MM:SS" (UTC, no zone) into a localized short string.
export function fmtIntelDate(val) {
    if (!val) return '-';
    let d = new Date(val);
    if (isNaN(d) && typeof val === 'string') d = new Date(val.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '-';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// True if the intel timestamp is parseable and older than 24h (used to grey stale sciences).
export function isIntelStale(val, now = Date.now()) {
    if (!val) return false;
    let d = new Date(val);
    if (isNaN(d) && typeof val === 'string') d = new Date(val.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return false;
    return (now - d.getTime()) > 24 * 3600 * 1000;
}

export function formatCultureCountdown(isoStr, now = Date.now()) {
    if (!isoStr) return '-';
    const msLeft = new Date(isoStr) - now;
    if (isNaN(msLeft)) return '-';
    if (msLeft <= 0) return 'Ready';
    const totalSecs = Math.floor(msLeft / 1000);
    return `${Math.floor(totalSecs / 3600)}h ${Math.floor((totalSecs % 3600) / 60)}m ${totalSecs % 60}s`;
}

// Production bonus from a player's artifact. Only Cathedral (CD), Major (MJ) and
// Horizon (HOR) artifacts at levels 1-3 boost production: +10% / +20% / +30%.
// Anything else (incl. "N/A" or empty) is neutral (1x).
export function artifactProdMultiplier(artefact) {
    if (!artefact) return 1;
    const m = String(artefact).toUpperCase().match(/(CD|MJ|HOR)\s*([123])/);
    if (!m) return 1;
    return 1 + parseInt(m[2], 10) * 0.10;
}

// The War Room's derived numbers, as loadWarRoomMatrixData has always computed them.
export function enrichWarRoomRow(p, now = Date.now()) {
    const factories = p.total_factories || 0;
    const pop = p.total_population || 0;
    const eco = p.economy || 0;
    const social = p.social || 0;

    // ~Prod/h = (factories + population) base, scaled by race production trait,
    // trade revenue %, and a qualifying production artifact.
    //   race_production: -4..+4, each step = 4%  ->  1 + race_production*0.04
    //   trade_revenue:   stored as % (e.g. 49 = +49%)  ->  1 + tr/100
    //   artifact:        CD/MJ/HOR lvl 1/2/3 = +10/20/30%
    const base = factories + pop;
    const raceMult = 1 + (p.race_production || 0) * 0.04;
    const trMult = 1 + (p.trade_revenue || 0) / 100;
    const estimatedProd = base * raceMult * trMult * artifactProdMultiplier(p.artefact);
    const dailyPP = estimatedProd * 24;
    // A destroyer is 3 CV. The game's economy table (docs/game-rules.md) ends at
    // economy 97 = 1 PP and levels 98-100 stay there, so clamp at 1: the bare
    // subtraction hit zero at economy 100 and the guard below then reported 0 CV/day
    // for the strongest economies in the game.
    const costFor3CV = Math.max(1, 30 - Math.floor(eco * 0.3));
    const cvDay = Math.floor((dailyPP / costFor3CV) * 3);
    // MaxCombatValue = Σpopulation × (social + 3) × 11. The factor is 11, not 10.
    const maxCv = pop * (social + 3) * 11;
    const idle = computeIdleDisplay(p, { now });

    // ~Science/h = (labs + population) base, scaled by the race science trait
    // and trade revenue %, mirroring the production formula.
    //   race_science: -4..+4, each step = 8%  ->  1 + race_science*0.08
    //   trade_revenue: stored as % (e.g. 49 = +49%)  ->  1 + tr/100
    // The science trait is 8% per point, NOT the 4% that production uses — this
    // column copied production's rate for months and understated a +4 science race
    // by 16%. Confirmed against the build-order simulator's mechanics 2026-08-07.
    const labs = p.total_labs || 0;
    const sciBase = labs + pop;
    const sciMult = 1 + (p.race_science || 0) * 0.08;
    const estimatedScience = sciBase * sciMult * trMult;

    return { ...p, calculated_prod: estimatedProd, calculated_science: estimatedScience, cv_day: cvDay, max_cv: maxCv, idle_seconds: idle.secs, idle_display: idle.text };
}

// ─── CELL HELPERS ─────────────────────────────────────────────────────────────

const Q = '<span class="text-zinc-600 font-bold">?</span>';   // captured never
const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const fmtInt = v => num(v).toLocaleString();
const text = v => (v == null || v === '' ? '-' : esc(String(v)));
const pct = v => `${num(v)}%`;
const luck = v => (v == null ? '-' : Number(v).toFixed(2));

// Deep-scan intel (race, sciences, trade, artefact, CV) is present when has_intel is set.
// Building totals come from the Statistics-page fetch of the same deep scrape and are
// stamped separately; rows scraped before that stamp existed still carry has_intel.
const hasIntel = field => row => !!row[field];
const hasStats = (statsField, intelField) => row => !!(row[statsField] || row[intelField]);

function idleBadge(row, activityField) {
    const idle = computeIdleDisplay(row, { activityField });
    let style = 'color: #a1a1aa;';
    if (idle.secs >= 0) {
        const cappedMins = Math.min(idle.secs / 60, 360);
        const hue = 120 - (cappedMins / 360) * 120;
        style = `background-color: hsla(${hue}, 75%, 12%, 0.45); color: hsl(${hue}, 90%, 65%); border: 1px solid hsla(${hue}, 75%, 25%, 0.3);`;
    }
    return `<span class="px-1.5 py-0.5 rounded text-[11px] md:text-xs font-mono tracking-wide whitespace-nowrap" style="${style}">${esc(idle.text)}</span>`;
}

function profileLink(row, hoverCls) {
    return `<a href="/Game/Players/Profile/${num(row.id)}" target="_blank" class="hover:underline ${hoverCls}">${esc(row.name || 'Unknown')}</a>`;
}

/**
 * A column. Only key/label/render are required.
 *   key      unique, also the data-col attribute and the sort key
 *   label    header text
 *   group    picker section
 *   default  false = hidden until the member turns it on
 *   locked   always visible (the name column)
 *   sort     'number' | 'string' | 'numtext' (localised number text) — default 'number'
 *   sortKey  row field to sort on when it differs from key
 *   sortValue(row)  computed sort value
 *   align    'right' | 'left' | 'center' — default right for numbers, left for strings
 *   head     extra header classes; cell: extra cell classes, or a function of the row
 *   title    header tooltip
 *   render(row) -> inner HTML
 */
function col(key, label, o) {
    const sort = o.sort || 'number';
    return Object.assign({ key, label, group: 'Other', default: true, locked: false, sort, align: sort === 'number' || sort === 'numtext' ? 'right' : 'left' }, o);
}

const raceCol = (key, label, group, intelField, o = {}) => col(key, label, Object.assign({
    group, render: r => formatRaceModifier(r[key], !hasIntel(intelField)(r)),
}, o));

const traderCol = (key, label, group, intelField, o = {}) => col(key, label, Object.assign({
    group, align: 'center',
    render: r => hasIntel(intelField)(r) ? (num(r[key]) > 0 ? '<i class="fa-solid fa-check text-emerald-400"></i>' : '') : Q,
}, o));

const gatedNum = (key, label, group, gate, o = {}) => col(key, label, Object.assign({
    group, render: r => (gate(r) ? fmtInt(r[key]) : Q),
}, o));

// Sciences go grey once the captured intel is older than 24h.
const scienceCol = (key, label, group, intelField, intelDateField, color, o = {}) => col(key, label, Object.assign({
    group,
    cell: r => (isIntelStale(r[intelDateField]) ? 'text-zinc-500' : color),
    head: color,
    render: r => (hasIntel(intelField)(r) ? fmtInt(r[key]) : Q),
}, o));

const buildingCols = (prefix, group, gate, first) => [
    gatedNum(`${prefix}total_farms`, 'Farms', group, gate, { default: false, head: first || '', cell: first || '', title: 'Hydroponic farms, all planets (Statistics page, up to 4 days old)' }),
    gatedNum(`${prefix}total_factories`, 'Fact', group, gate, { default: false, title: 'Robotic factories, all planets' }),
    gatedNum(`${prefix}total_labs`, 'Labs', group, gate, { default: false, title: 'Research labs, all planets' }),
    gatedNum(`${prefix}total_cybernetics`, 'Cyber', group, gate, { default: false, title: 'Galactic cybernets, all planets' }),
];

// ─── PLAYERS TABLE (Player Archive) ───────────────────────────────────────────
// Base cell class p-3; header base in archives.js. Defaults reproduce the table as it was.

const P_INTEL = hasIntel('has_intel');
const P_STATS = hasStats('stats_scraped_at', 'has_intel');

export const PLAYER_COLUMNS = [
    col('name', 'Name', { group: 'Player', locked: true, sort: 'string', head: 'sticky left-0 z-20 bg-secondary', cell: 'font-medium text-foreground sticky left-0 z-10 bg-card', render: r => profileLink(r, 'hover:text-primary') }),
    col('alliance_tag', 'Ally', { group: 'Player', sort: 'string', cell: 'text-aw-warning', render: r => (r.alliance_tag ? `[${esc(r.alliance_tag)}]` : '-') }),
    col('id', 'ID', { group: 'Player', default: false, cell: 'text-muted-foreground font-mono', render: r => num(r.id) }),
    col('country', 'Country', { group: 'Player', default: false, sort: 'string', render: r => text(r.country) }),
    col('joined', 'Joined', { group: 'Player', default: false, sort: 'string', cell: 'text-muted-foreground', render: r => text(r.joined), title: 'Join date as the game reports it' }),
    col('active', 'Active', { group: 'Player', default: false, sortValue: r => computeIdleDisplay(r).secs, render: r => idleBadge(r, 'last_activity_at'), title: 'Time since last activity (API), or the scraped idle string' }),
    col('logins', 'Logins', { group: 'Player', default: false, render: r => fmtInt(r.logins) }),

    col('ranking', 'Rank', { group: 'Progress', default: false, render: r => (r.ranking == null ? '-' : fmtInt(r.ranking)) }),
    col('level', 'PL', { group: 'Progress', render: r => num(r.level) }),
    col('science_level', 'SciLvl', { group: 'Progress', head: 'text-blue-300', cell: 'text-blue-300', render: r => num(r.science_level) }),
    col('culture_level', 'CulLvl', { group: 'Progress', head: 'text-purple-300', cell: 'text-purple-300', render: r => num(r.culture_level) }),
    col('points', 'Points', { group: 'Progress', cell: 'text-primary font-medium', render: r => fmtInt(r.points) }),
    col('eco_bonus', 'Eco bonus', { group: 'Progress', default: false, render: r => pct(r.eco_bonus), title: 'Economy bonus % (join cohort)' }),
    col('number_of_battles', 'Battles', { group: 'Progress', default: false, render: r => fmtInt(r.number_of_battles) }),
    col('battle_luckiness', 'Luck', { group: 'Progress', default: false, render: r => luck(r.battle_luckiness) }),

    col('planet_count', 'Planets', { group: 'Empire', head: 'border-l border-border', cell: 'border-l border-border', render: r => num(r.planet_count), title: 'Planets the hub has scanned for this player' }),
    col('total_planets', 'Planets*', { group: 'Empire', default: false, render: r => num(r.total_planets), title: 'Planet count from the profile page' }),
    col('total_population', 'Pop', { group: 'Empire', head: 'text-primary', cell: 'text-primary', render: r => fmtInt(r.total_population) }),
    col('cv', 'CV', { group: 'Empire', sortKey: 'cv_used', cell: 'whitespace-nowrap', render: r => (P_INTEL(r) ? `${fmtInt(r.cv_used)}/${fmtInt(r.cv_limit)}` : Q), title: 'CV used / CV limit' }),
    ...buildingCols('', 'Empire', P_STATS),

    raceCol('race_growth', 'Gro', 'Race', 'has_intel', { head: 'text-emerald-300 border-l border-border', cell: 'border-l border-border' }),
    raceCol('race_science', 'Sci', 'Race', 'has_intel', { head: 'text-emerald-300' }),
    raceCol('race_culture', 'Cult', 'Race', 'has_intel', { head: 'text-emerald-300' }),
    raceCol('race_production', 'Prod', 'Race', 'has_intel', { head: 'text-emerald-300' }),
    raceCol('race_speed', 'Spd', 'Race', 'has_intel', { head: 'text-rose-400' }),
    raceCol('race_attack', 'Att', 'Race', 'has_intel', { head: 'text-rose-400' }),
    raceCol('race_defense', 'Def', 'Race', 'has_intel', { head: 'text-rose-400' }),
    traderCol('race_trader', 'Trad', 'Race', 'has_intel', { head: 'text-amber-400' }),
    raceCol('race_sul', 'SUL', 'Race', 'has_intel', { default: false, head: 'text-amber-400', title: 'Start Up Lab race pick' }),

    col('trade_revenue', 'Trade', { group: 'Economy', head: 'text-primary border-l border-border', cell: 'text-primary border-l border-border', render: r => (P_INTEL(r) ? pct(r.trade_revenue) : Q) }),
    gatedNum('science_rate', 'Sci/h', 'Economy', P_INTEL, { default: false, title: 'Science rate as scraped from the profile' }),
    gatedNum('culture_rate', 'Cul/h', 'Economy', P_INTEL, { default: false }),
    gatedNum('production_rate', 'Prd/h', 'Economy', P_INTEL, { default: false }),
    gatedNum('astro_dollars', 'A$', 'Economy', P_INTEL, { default: false }),
    gatedNum('production_points', 'PP', 'Economy', P_INTEL, { default: false }),

    scienceCol('biology', 'Bio', 'Sciences', 'has_intel', 'intel_updated_at', 'text-green-400', { head: 'text-green-400 border-l border-border', cell: r => `${isIntelStale(r.intel_updated_at) ? 'text-zinc-500' : 'text-green-400'} border-l border-border` }),
    scienceCol('economy', 'Eco', 'Sciences', 'has_intel', 'intel_updated_at', 'text-yellow-400'),
    scienceCol('energy', 'Nrg', 'Sciences', 'has_intel', 'intel_updated_at', 'text-purple-400'),
    scienceCol('mathematics', 'Math', 'Sciences', 'has_intel', 'intel_updated_at', 'text-orange-400'),
    scienceCol('physics', 'Phy', 'Sciences', 'has_intel', 'intel_updated_at', 'text-blue-400'),
    scienceCol('social', 'Soc', 'Sciences', 'has_intel', 'intel_updated_at', 'text-pink-400'),

    col('artefact', 'Artefact', { group: 'Intel', sort: 'string', head: 'border-l border-border', cell: 'border-l border-border', render: r => (P_INTEL(r) ? text(r.artefact) : Q) }),
    col('intel_updated_at', 'Last Intel', { group: 'Intel', sort: 'string', head: 'border-l border-border', cell: 'text-muted-foreground border-l border-border', render: r => fmtIntelDate(r.intel_updated_at) }),
    col('stats_scraped_at', 'Stats age', { group: 'Intel', default: false, sort: 'string', cell: 'text-muted-foreground', render: r => fmtIntelDate(r.stats_scraped_at), title: 'When the hub last read this player\'s Statistics page' }),
];

// ─── WAR ROOM (Enemy Intel) ───────────────────────────────────────────────────

const W_INTEL = hasIntel('has_intel');
const W_STATS = hasStats('stats_scraped_at', 'has_intel');
const WAR_NAME_HEAD = 'sticky left-0 z-20 bg-zinc-900 w-[110px]';
const WAR_NAME_CELL = 'sticky left-0 z-10 bg-black font-bold text-foreground break-words leading-tight w-[110px] border-r border-zinc-800';

export const WAR_ROOM_COLUMNS = [
    col('name', 'Player', { group: 'Player', locked: true, sort: 'string', head: WAR_NAME_HEAD, cell: WAR_NAME_CELL, render: r => profileLink(r, 'hover:text-red-400') }),
    col('idle', 'Idle', { group: 'Player', sortKey: 'idle_seconds', align: 'left', render: r => idleBadge(r, 'last_activity_at') }),
    // Planets vs culture level. culture_level is parsed/stored for every player regardless
    // of intel, so it's always shown (not masked). Planets below the culture level means
    // the player can build more planets -> flag it red.
    col('total_planets', 'Planets', {
        group: 'Empire',
        cell: r => ((r.culture_level || 0) > 0 && (r.total_planets || 0) < (r.culture_level || 0) ? 'text-rose-500 font-bold' : 'text-zinc-400 font-bold'),
        render: r => `<span title="Culture level: ${num(r.culture_level)}">${num(r.total_planets)} / ${r.culture_level || '?'}</span>`,
        title: 'Planets / culture level — red when they can still colonise',
    }),
    col('calculated_prod', '~Prod/h', { group: 'Estimates', cell: 'text-emerald-400 font-bold', render: r => fmtInt(Math.round(r.calculated_prod || 0)), title: '(factories + population) × race × trade × artefact' }),
    col('trade_revenue', 'TR%', { group: 'Economy', cell: 'text-teal-300', render: r => (W_INTEL(r) ? pct(r.trade_revenue) : Q) }),
    col('cv_day', '~CV/Day', { group: 'Estimates', cell: 'text-amber-400 font-bold', render: r => (W_INTEL(r) ? fmtInt(r.cv_day) : Q) }),
    col('max_cv', 'Max CV', { group: 'Estimates', cell: 'text-cyan-400', render: r => (W_INTEL(r) ? fmtInt(r.max_cv) : Q), title: 'Σpopulation × (social + 3) × 11' }),
    raceCol('race_speed', 'Spd', 'Race', 'has_intel'),
    raceCol('race_attack', 'Att', 'Race', 'has_intel'),
    raceCol('race_defense', 'Def', 'Race', 'has_intel'),
    gatedNum('physics', 'Phy', 'Sciences', W_INTEL, { cell: 'text-zinc-300' }),
    gatedNum('mathematics', 'Math', 'Sciences', W_INTEL, { cell: 'text-zinc-300' }),
    gatedNum('energy', 'Enrg', 'Sciences', W_INTEL, { cell: 'text-zinc-300' }),
    gatedNum('biology', 'Bio', 'Sciences', W_INTEL, { cell: 'text-zinc-300' }),
    gatedNum('social', 'Soc', 'Sciences', W_INTEL, { cell: 'text-zinc-300' }),
    col('calculated_science', '~Sci/h', { group: 'Estimates', cell: 'text-violet-400 font-bold', render: r => fmtInt(Math.round(r.calculated_science || 0)), title: '(labs + population) × race science × trade' }),
    col('intel_updated_at', 'Last Intel', {
        group: 'Intel', sort: 'string', cell: 'text-zinc-400',
        render: r => { const d = parseSqliteUtc(r.intel_updated_at); return d ? `<span title="${d.toLocaleString()}">${d.toLocaleDateString()}</span>` : '<span class="text-zinc-600">never</span>'; },
    }),

    // Everything else the hub knows — off until asked for (issue #113).
    col('level', 'Lvl', { group: 'Progress', default: false, render: r => num(r.level) }),
    col('science_level', 'SciLvl', { group: 'Progress', default: false, render: r => num(r.science_level) }),
    col('culture_level', 'CulLvl', { group: 'Progress', default: false, render: r => num(r.culture_level) }),
    col('points', 'Pts', { group: 'Progress', default: false, render: r => fmtInt(r.points) }),
    col('ranking', 'Rank', { group: 'Progress', default: false, render: r => (r.ranking == null ? '-' : fmtInt(r.ranking)) }),
    col('eco_bonus', 'Eco%', { group: 'Progress', default: false, render: r => pct(r.eco_bonus), title: 'Economy bonus % (join cohort)' }),
    col('number_of_battles', 'Battles', { group: 'Progress', default: false, render: r => fmtInt(r.number_of_battles) }),
    col('battle_luckiness', 'Luck', { group: 'Progress', default: false, render: r => luck(r.battle_luckiness) }),
    col('total_population', 'Pop', { group: 'Empire', default: false, render: r => fmtInt(r.total_population) }),
    col('cv', 'CV', { group: 'Empire', default: false, sortKey: 'cv_used', cell: 'whitespace-nowrap', render: r => (W_INTEL(r) ? `${fmtInt(r.cv_used)}/${fmtInt(r.cv_limit)}` : Q), title: 'CV used / CV limit' }),
    ...buildingCols('', 'Empire', W_STATS),
    gatedNum('economy', 'Eco', 'Sciences', W_INTEL, { default: false, cell: 'text-zinc-300' }),
    raceCol('race_growth', 'Gro', 'Race', 'has_intel', { default: false }),
    raceCol('race_science', 'Sci±', 'Race', 'has_intel', { default: false, title: 'Race science pick' }),
    raceCol('race_culture', 'Cul±', 'Race', 'has_intel', { default: false, title: 'Race culture pick' }),
    raceCol('race_production', 'Prd±', 'Race', 'has_intel', { default: false, title: 'Race production pick' }),
    traderCol('race_trader', 'Trd', 'Race', 'has_intel', { default: false }),
    raceCol('race_sul', 'SUL', 'Race', 'has_intel', { default: false, title: 'Start Up Lab race pick' }),
    col('artefact', 'Artefact', { group: 'Economy', default: false, sort: 'string', cell: 'text-pink-400', render: r => (W_INTEL(r) ? text(r.artefact) : Q) }),
    gatedNum('science_rate', 'Sci/h', 'Economy', W_INTEL, { default: false, title: 'Science rate as scraped (vs. the ~Sci/h estimate)' }),
    gatedNum('culture_rate', 'Cul/h', 'Economy', W_INTEL, { default: false }),
    gatedNum('production_rate', 'Prd/h', 'Economy', W_INTEL, { default: false, title: 'Production rate as scraped (vs. the ~Prod/h estimate)' }),
    gatedNum('astro_dollars', 'A$', 'Economy', W_INTEL, { default: false }),
    gatedNum('production_points', 'PP', 'Economy', W_INTEL, { default: false }),
    col('country', 'Country', { group: 'Player', default: false, sort: 'string', render: r => text(r.country) }),
    col('joined', 'Joined', { group: 'Player', default: false, sort: 'string', render: r => text(r.joined) }),
    col('logins', 'Logins', { group: 'Player', default: false, render: r => fmtInt(r.logins) }),
    col('last_login_at', 'Last login', { group: 'Player', default: false, sort: 'string', cell: 'text-zinc-400', render: r => fmtIntelDate(r.last_login_at) }),
    col('stats_scraped_at', 'Stats age', { group: 'Intel', default: false, sort: 'string', cell: 'text-zinc-400', render: r => fmtIntelDate(r.stats_scraped_at) }),
];

// ─── ALLIANCE STATS ───────────────────────────────────────────────────────────
// s.* is the member page sheet; pl_* is the same member's players row (see alliances.js).

const A_INTEL = hasIntel('pl_has_intel');
const A_STATS = hasStats('pl_stats_scraped_at', 'pl_has_intel');

export const ALLY_STATS_COLUMNS = [
    col('player_name', 'Member', { group: 'Member', locked: true, sort: 'string', head: WAR_NAME_HEAD, cell: 'sticky left-0 z-10 bg-black font-medium text-foreground break-words leading-tight w-[110px] border-r border-zinc-800', render: r => esc(r.player_name || 'Unknown') }),
    col('player_id', 'ID', { group: 'Member', cell: 'text-muted-foreground', render: r => num(r.player_id) }),
    col('planets_text', 'Planets', { group: 'Sheet', sort: 'string', cell: 'text-aw-ally font-semibold', render: r => text(r.planets_text) }),
    col('next_culture_at', 'Next Cult', { group: 'Sheet', sort: 'string', cell: 'font-semibold text-yellow-500 whitespace-nowrap', render: r => formatCultureCountdown(r.next_culture_at) }),
    col('science_rate', 'Sci', { group: 'Sheet', sort: 'numtext', cell: 'text-blue-400 font-semibold', render: r => text(r.science_rate) }),
    col('culture_rate', 'Cul', { group: 'Sheet', sort: 'numtext', cell: 'text-purple-400 font-semibold', render: r => text(r.culture_rate) }),
    col('production_rate', 'Prd', { group: 'Sheet', sort: 'numtext', cell: 'text-orange-400 font-semibold', render: r => text(r.production_rate) }),
    col('astro_dollars', 'Astro$', { group: 'Sheet', sort: 'numtext', cell: 'text-emerald-400', render: r => text(r.astro_dollars) }),
    col('production_points', 'PP', { group: 'Sheet', sort: 'numtext', cell: 'text-slate-300', render: r => text(r.production_points) }),
    col('artefact', 'Artefact', { group: 'Sheet', sort: 'string', cell: 'text-pink-400 font-semibold', render: r => esc(r.artefact || 'None') }),
    col('level_text', 'Level', { group: 'Sheet', sort: 'string', cell: 'text-sky-400', render: r => text(r.level_text) }),
    col('cv_limit_text', 'CV Limit', { group: 'Sheet', sort: 'string', cell: 'text-red-400', render: r => text(r.cv_limit_text) }),
    col('economy', 'Eco', { group: 'Sheet', cell: 'text-amber-500 font-bold', render: r => num(r.economy) }),
    col('energy', 'Ene', { group: 'Sheet', cell: 'text-cyan-400 font-bold', render: r => num(r.energy) }),
    col('mathematics', 'Math', { group: 'Sheet', cell: 'text-indigo-400 font-bold', render: r => num(r.mathematics) }),
    col('physics', 'Phy', { group: 'Sheet', cell: 'text-violet-400 font-bold', render: r => num(r.physics) }),
    col('population', 'Pop', { group: 'Sheet', cell: 'text-foreground font-bold bg-white/5', render: r => num(r.population) }),

    // Off by default: the rest of the sheet, and the member's players row (issue #113).
    col('hoarded_au', 'Hoard A$', { group: 'Sheet', default: false, render: r => fmtInt(r.hoarded_au), title: 'A$ value of artifacts + supply units held (Trade inventory scrape)' }),
    col('updated_at', 'Sheet updated', { group: 'Sheet', default: false, sort: 'string', cell: 'text-zinc-400', render: r => fmtIntelDate(r.updated_at) }),
    col('pl_points', 'Points', { group: 'Progress', default: false, render: r => fmtInt(r.pl_points) }),
    col('pl_ranking', 'Rank', { group: 'Progress', default: false, render: r => (r.pl_ranking == null ? '-' : fmtInt(r.pl_ranking)) }),
    col('pl_level', 'PL', { group: 'Progress', default: false, render: r => num(r.pl_level) }),
    col('pl_science_level', 'SciLvl', { group: 'Progress', default: false, render: r => num(r.pl_science_level) }),
    col('pl_culture_level', 'CulLvl', { group: 'Progress', default: false, render: r => num(r.pl_culture_level) }),
    col('pl_eco_bonus', 'Eco%', { group: 'Progress', default: false, render: r => pct(r.pl_eco_bonus) }),
    col('pl_number_of_battles', 'Battles', { group: 'Progress', default: false, render: r => fmtInt(r.pl_number_of_battles) }),
    col('pl_battle_luckiness', 'Luck', { group: 'Progress', default: false, render: r => luck(r.pl_battle_luckiness) }),
    col('pl_total_planets', 'Planets*', { group: 'Empire', default: false, render: r => num(r.pl_total_planets), title: 'Planet count from the profile page' }),
    col('pl_planet_count', 'Planets (hub)', { group: 'Empire', default: false, render: r => num(r.pl_planet_count), title: 'Planets the hub has scanned' }),
    col('pl_total_population', 'Pop*', { group: 'Empire', default: false, render: r => fmtInt(r.pl_total_population), title: 'Population from the profile scrape' }),
    col('pl_cv', 'CV', { group: 'Empire', default: false, sortKey: 'pl_cv_used', cell: 'whitespace-nowrap', render: r => (A_INTEL(r) ? `${fmtInt(r.pl_cv_used)}/${fmtInt(r.pl_cv_limit)}` : Q), title: 'CV used / CV limit' }),
    ...buildingCols('pl_', 'Empire', A_STATS),
    gatedNum('pl_biology', 'Bio', 'Sciences', A_INTEL, { default: false, cell: 'text-green-400' }),
    gatedNum('pl_social', 'Soc', 'Sciences', A_INTEL, { default: false, cell: 'text-pink-400' }),
    col('pl_trade_revenue', 'TR%', { group: 'Economy', default: false, cell: 'text-teal-300', render: r => (A_INTEL(r) ? pct(r.pl_trade_revenue) : Q) }),
    raceCol('pl_race_growth', 'Gro', 'Race', 'pl_has_intel', { default: false }),
    raceCol('pl_race_science', 'Sci±', 'Race', 'pl_has_intel', { default: false }),
    raceCol('pl_race_culture', 'Cul±', 'Race', 'pl_has_intel', { default: false }),
    raceCol('pl_race_production', 'Prd±', 'Race', 'pl_has_intel', { default: false }),
    raceCol('pl_race_speed', 'Spd', 'Race', 'pl_has_intel', { default: false }),
    raceCol('pl_race_attack', 'Att', 'Race', 'pl_has_intel', { default: false }),
    raceCol('pl_race_defense', 'Def', 'Race', 'pl_has_intel', { default: false }),
    traderCol('pl_race_trader', 'Trd', 'Race', 'pl_has_intel', { default: false }),
    raceCol('pl_race_sul', 'SUL', 'Race', 'pl_has_intel', { default: false }),
    col('pl_active', 'Active', { group: 'Member', default: false, sortValue: r => computeIdleDisplay(r, { activityField: 'pl_last_activity_at' }).secs, align: 'left', render: r => idleBadge(r, 'pl_last_activity_at') }),
    col('pl_intel_updated_at', 'Last Intel', { group: 'Member', default: false, sort: 'string', cell: 'text-zinc-400', render: r => fmtIntelDate(r.pl_intel_updated_at) }),
];

// ─── RENDERING (strings only) ─────────────────────────────────────────────────

const alignCls = c => (c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : '');

export function renderHeaderCells(columns, { sortCol = null, sortAsc = true, headBase = '' } = {}) {
    return columns.map(c => {
        const icon = c.key !== sortCol ? 'fa-sort opacity-50' : (sortAsc ? 'fa-sort-up' : 'fa-sort-down');
        const title = c.title ? ` title="${esc(c.title)}"` : '';
        return `<th data-col="${c.key}" class="${[headBase, alignCls(c), c.head || ''].filter(Boolean).join(' ')}"${title}>${esc(c.label)} <i class="fa-solid ${icon} ml-1"></i></th>`;
    }).join('');
}

export function renderRowCells(columns, row, cellBase = '') {
    return columns.map(c => {
        const extra = typeof c.cell === 'function' ? c.cell(row) : (c.cell || '');
        return `<td data-col="${c.key}" class="${[cellBase, alignCls(c), extra].filter(Boolean).join(' ')}">${c.render(row)}</td>`;
    }).join('');
}

function sortValueOf(c, row) {
    if (typeof c.sortValue === 'function') return c.sortValue(row);
    return row[c.sortKey || c.key];
}

/** Sorted copy. Nulls sort last in either direction; strings compare case-insensitively. */
export function sortRows(rows, columns, sortKey, asc) {
    const c = columns.find(x => x.key === sortKey);
    if (!c) return rows.slice();
    const dir = asc ? 1 : -1;
    return rows.slice().sort((a, b) => {
        let va = sortValueOf(c, a), vb = sortValueOf(c, b);
        const na = va === null || va === undefined || va === '', nb = vb === null || vb === undefined || vb === '';
        if (na && nb) return 0;
        if (na) return 1;
        if (nb) return -1;
        if (c.sort === 'numtext') return dir * compareNumeric(va, vb);
        if (c.sort === 'string') {
            va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
            return va < vb ? -dir : va > vb ? dir : 0;
        }
        va = Number(va); vb = Number(vb);
        if (Number.isNaN(va) && Number.isNaN(vb)) return 0;
        if (Number.isNaN(va)) return 1;
        if (Number.isNaN(vb)) return -1;
        return dir * (va - vb);
    });
}

export const STAT_TABLES = {
    players: { columns: PLAYER_COLUMNS, cellBase: 'p-3', headBase: 'p-3 cursor-pointer hover:bg-secondary/80 select-none' },
    warRoom: { columns: WAR_ROOM_COLUMNS, cellBase: 'px-2 py-1 md:px-3 md:py-1.5', headBase: 'px-2 py-1.5 md:px-3 md:py-2 cursor-pointer hover:bg-accent/40 select-none' },
    allyStats: { columns: ALLY_STATS_COLUMNS, cellBase: 'px-2 py-1 md:px-3 md:py-1.5', headBase: 'px-2 py-1.5 md:px-3 md:py-2 cursor-pointer hover:bg-accent/40 select-none' },
};
