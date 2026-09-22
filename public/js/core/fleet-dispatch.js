// "You have this fleet. Here is what to do with it." — injected into /Game/Fleets.
//
// ─── WHAT THIS IS ─────────────────────────────────────────────────────────────
// The game's Fleets page is a table of what you own: a location, five ship counts, a combat
// value, four links. Everything you would want to know before using any of it lives on
// other screens — how long the flight is, whether the owner will be awake when it lands,
// what is known to be defending, what winning that fight has historically cost. This reads
// the rows, asks /hub-api/intel/fleet-dispatch once, and puts the answer under each fleet.
//
// ─── IT DOES NOT TOUCH THE GAME. AT ALL. ──────────────────────────────────────
// Automating play is forbidden, and a tool that fills the launch form in for you is
// automating play whatever it is called. So this is DISPLAY ONLY, and deliberately not
// almost-display-only:
//
//   • it never writes to an input, a select or a form on any page
//   • it never calls submit(), never dispatches a click, never follows a link on its own
//   • it never makes a request to the game — the one fetch it makes goes to the hub, over
//     data the hub already holds
//
// The Launch and Loop buttons stay exactly as the game drew them: the member clicks them,
// reads the suggestion, and types the destination in themselves. Those three rules are
// asserted by scanning this file's own source in fleet-dispatch-inject.test.js, because
// "must never" is not something a function call can demonstrate.
//
// ─── READING THE TABLE ────────────────────────────────────────────────────────
// Columns are found by their HEADER TEXT and the fleet's location by the shape of its
// system link, never by column position — an inserted column silently shifted every value
// the last time a parser here counted cells (see system-parser.js's own history). When the
// shape is not recognised the injection reports through AWScrape and renders nothing,
// rather than drawing a confident row from a misread number.
import '../utils/scrape-report.js';   // side-effect import: the shared failure reporter

const ROW_CLASS = 'awt-dispatch-row';
const MARK = 'data-awt-dispatch';

// Header labels this reads. Only phrasings confirmed from the live page — a guessed
// translation does not fail loudly, it matches the wrong column and writes wrong numbers,
// which is the exact failure AWScrape exists to catch.
const CV_HEADERS = ['combat value'];
const COLONY_HEADERS = ['colony ship'];

/**
 * Which column index carries which value, by header text.
 *
 * AWScrape.headerIndex() would be the obvious thing to call, and it cannot be used here:
 * it looks in `thead th, thead td`, and this table has no <thead> at all — the header row
 * is plain <td>s in the first <tbody> row (checked against the live page, 2026-09-22). So
 * the row is walked by hand, but the LABEL MATCHING is still AWScrape's, so "what counts as
 * this column's name" stays defined in one place.
 *
 * Returns null when the table has no header row this recognises, which is what makes the
 * caller skip the table instead of drawing numbers from whatever was in column 7.
 */
export function headerIndexes(headerRow, scrape = globalThis.AWScrape) {
    if (!headerRow || !headerRow.cells || !scrape) return null;
    const cells = [...headerRow.cells];
    const find = (wanted) => cells.findIndex(c => scrape.matchesLabel(c.innerText, wanted) || scrape.containsLabel(c.innerText, wanted));
    const cv = find(CV_HEADERS);
    const colony = find(COLONY_HEADERS);
    if (cv < 0) return null;            // without a combat value there is nothing to plan with
    return { cv, colony };
}

/**
 * One fleet row -> { system_id, planet_index, cv, colonyShips } or null.
 *
 * The location comes from the row's own /Game/Map/SolarSystem/{system}/{planet} link, which
 * is the only place on this page carrying both numbers unambiguously.
 */
export function readFleetRow(row, indexes) {
    if (!row || !row.cells || !indexes) return null;
    const link = row.querySelector('a[href*="/Game/Map/SolarSystem/"]');
    if (!link) return null;
    const match = (link.getAttribute('href') || '').match(/\/Game\/Map\/SolarSystem\/(\d+)\/(\d+)/i);
    if (!match) return null;

    const systemId = parseInt(match[1], 10);
    const planetIndex = parseInt(match[2], 10);
    if (!Number.isInteger(systemId) || systemId <= 0) return null;
    if (!Number.isInteger(planetIndex) || planetIndex < 1 || planetIndex > 12) return null;

    const intAt = (index) => {
        if (index < 0 || !row.cells[index]) return 0;
        const n = parseInt(String(row.cells[index].innerText).replace(/[^\d-]/g, ''), 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    };

    return { system_id: systemId, planet_index: planetIndex, cv: intAt(indexes.cv), colonyShips: intAt(indexes.colony) };
}

function fmtHours(h) {
    if (!Number.isFinite(h)) return '—';
    if (h < 1) return `${Math.round(h * 60)}m`;
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    return mins ? `${whole}h${String(mins).padStart(2, '0')}` : `${whole}h`;
}

function fmtAge(h) {
    if (!Number.isFinite(h)) return 'age unknown';
    if (h < 1) return 'just now';
    if (h < 48) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function fmtClock(ms) {
    const d = new Date(ms);
    const today = d.toDateString() === new Date().toDateString();
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return today ? time : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${time}`;
}

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// An away score is a frequency over observed days, never a promise, so it is rendered as a
// percentage with the sample behind it and a plain "not sampled" when there is none.
function awayCell(target) {
    if (!target.sampled || target.awayScore === null) return '<span style="color:#888">never sampled</span>';
    const pct = Math.round(target.awayScore * 100);
    const colour = pct >= 80 ? '#4ade80' : pct >= 50 ? '#facc15' : '#f87171';
    return `<span style="color:${colour}" title="away in this hour on ${target.observedDays - 0} observed days">${pct}% away</span>`;
}

function defenderCell(target) {
    if (target.defenderCv === null) {
        return '<span style="color:#fbbf24" title="no fleet of theirs has ever been seen — this is not the same as undefended">no estimate</span>';
    }
    const source = target.defenderSource === 'battle' ? 'last seen fielding' : 'ranked strongest fleet';
    return `<span title="${esc(source)}, ${esc(fmtAge(target.defenderAgeHours))}">${target.defenderCv} CV`
        + `<span style="color:#888"> (${esc(source)}, ${esc(fmtAge(target.defenderAgeHours))})</span></span>`;
}

function renderTargets(fleet) {
    const lines = [];

    for (const t of fleet.targets) {
        const ratio = t.ratio ? `${t.ratio.toFixed(1)}×` : '';
        lines.push(`<div style="margin:2px 0">`
            + `<span style="color:#ddd">[${t.system_id}] ${esc(t.system_name || '?')} #${t.planet_index}</span> `
            + `<span style="color:#9ca3af">${esc(t.player_name || '?')}${t.tag ? ` [${esc(t.tag)}]` : ''}</span> · `
            + `${esc(fmtHours(t.travelHours))} → lands ${esc(fmtClock(t.arriveAt))} · `
            + `${awayCell(t)} · ${defenderCell(t)} ${ratio ? `<span style="color:#67e8f9">${ratio}</span>` : ''}`
            + (t.cost ? `<div style="color:#888;margin-left:8px">${esc(t.cost)}</div>` : '')
            + `</div>`);
    }

    for (const c of fleet.colonies) {
        lines.push(`<div style="margin:2px 0">`
            + `<span style="color:#4ade80">settle</span> `
            + `<span style="color:#ddd">[${c.system_id}] ${esc(c.system_name || '?')} #${c.planet_index}</span> · `
            + `${esc(fmtHours(c.travelHours))} → ${esc(fmtClock(c.arriveAt))} · `
            + `<span style="color:#888">last looked ${esc(fmtAge(c.observedAgeHours))}</span>`
            + `</div>`);
    }

    if (!lines.length) {
        const why = fleet.canFight && fleet.riskyExcluded
            ? `nothing in range this fleet outguns — ${fleet.riskyExcluded} target${fleet.riskyExcluded === 1 ? ' is' : 's are'} stronger than it`
            : fleet.canFight ? 'nothing in range' : 'no combat value and no colony ship — nothing to suggest';
        return `<div style="color:#888">${esc(why)}</div>`;
    }

    const tail = [];
    if (fleet.canFight) tail.push(`${fleet.inRange} in range`, `${fleet.riskyExcluded} too strong`, `${fleet.outOfRange} too far`);
    if (fleet.canSettle) tail.push(`${fleet.coloniesInRange} free planets in range`);
    return lines.join('')
        + `<div style="color:#666;margin-top:3px">${esc(tail.join(' · '))}`
        + ` · suggestions only — open Launch yourself and pick the destination there</div>`;
}

let inFlight = false;

export async function initFleetDispatch() {
    if (!window.location.pathname.toLowerCase().includes('/game/fleets')) return;
    // The launch and loop forms are the member's to fill in. Nothing is drawn on them.
    if (window.location.pathname.toLowerCase().includes('/game/fleets/launch')) return;
    if (inFlight) return;

    const report = globalThis.AWScrape ? new globalThis.AWScrape.ScrapeReport('fleet-dispatch') : null;

    // The fleet table is the one whose header row carries a Combat Value column.
    let table = null, indexes = null;
    for (const candidate of document.querySelectorAll('table')) {
        const found = headerIndexes(candidate.rows[0]);
        if (found) { table = candidate; indexes = found; break; }
    }
    if (!table) {
        if (report) report.problem('fleet table not found', 'no table carries a Combat Value header');
        return;
    }

    // A row is a FLEET row when it links to a solar system. The table also carries a "Sum"
    // footer (confirmed on the live page: blank SID, the column totals, and the CV limit),
    // and counting that as a fleet row that failed to parse would report a broken scrape on
    // every single visit. Not-a-fleet and a-fleet-we-could-not-read are different, and only
    // the second is a problem.
    const rows = [...table.rows].slice(1)
        .filter(r => !r.classList.contains(ROW_CLASS))
        .filter(r => r.querySelector('a[href*="/Game/Map/SolarSystem/"]'));
    const fleets = [];
    for (const row of rows) {
        const fleet = report
            ? report.tryRow(() => readFleetRow(row, indexes), 'fleet row')
            : readFleetRow(row, indexes);
        if (fleet) fleets.push({ row, fleet });
        else if (report) report.problem('fleet row unreadable', 'a row links to a system but its counts did not parse');
    }
    // A table with rows that yielded nothing is broken, not empty — say so rather than
    // rendering a clean blank.
    if (report && report.emptyFromNonEmpty) {
        console.warn('[Spy] fleet dispatch: the fleet table has rows but none parsed', report.problems);
        return;
    }
    if (!fleets.length) return;

    // Already drawn for this exact set? The page re-renders on its own timers, and a
    // redraw per tick would mean a request per tick.
    const signature = fleets.map(f => `${f.fleet.system_id}:${f.fleet.planet_index}:${f.fleet.cv}:${f.fleet.colonyShips}`).join(',');
    if (table.getAttribute(MARK) === signature) return;

    inFlight = true;
    try {
        const res = await fetch(`/hub-api/intel/fleet-dispatch?fleets=${encodeURIComponent(signature)}`);
        const body = await res.json();
        if (!body || !body.success) throw new Error((body && body.error) || 'dispatch unavailable');

        const byKey = new Map(body.fleets.map(f => [f.key, f]));
        table.querySelectorAll(`.${ROW_CLASS}`).forEach(r => r.remove());

        for (const { row, fleet } of fleets) {
            const answer = byKey.get(`${fleet.system_id}:${fleet.planet_index}:${fleet.cv}:${fleet.colonyShips}`);
            if (!answer) continue;
            const tr = document.createElement('tr');
            tr.className = ROW_CLASS;
            const td = document.createElement('td');
            td.colSpan = row.cells.length || 9;
            td.style.cssText = 'font-size:8pt;font-family:ui-monospace,monospace;padding:4px 8px 8px 8px;'
                + 'background:rgba(8,20,30,0.55);border-top:1px solid rgba(34,211,238,0.25);';
            td.innerHTML = renderTargets(answer);
            tr.appendChild(td);
            row.parentNode.insertBefore(tr, row.nextSibling);
        }
        table.setAttribute(MARK, signature);
    } catch (err) {
        console.warn('[Spy] fleet dispatch failed:', err.message);
    } finally {
        inFlight = false;
    }
}
