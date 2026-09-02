import { esc } from '../utils/escape.js';
import '../utils/sqlite-time.js';    // side-effect import: puts the model on globalThis
import '../utils/game-rate-limit.js';
import '../utils/game-tables.js';    // side-effect import: empire-model.js's own dependency
import '../utils/travel-model.js';   // side-effect import: empire-model.js's own dependency
import '../utils/empire-model.js';   // side-effect import: TRAIT_PCT, the ONE source for race-bonus %/point
import '../utils/aw-api.js';         // side-effect import: getTravelTime, for initColonizeLaunchWindows
const { gameFetch } = globalThis.AWGameRate;
const { formatSqliteUtc } = globalThis.AWSqliteTime;
const { TRAIT_PCT } = globalThis.AWEmpire.constants;
const { getTravelTime } = globalThis.AWApi;

export function initPlanetPopTimers() {
    if (!window.location.pathname.toLowerCase().includes('/game/planets')) return;

    if (!document.getElementById('custom-pop-timer-styles')) {
        const style = document.createElement('style');
        style.id = 'custom-pop-timer-styles';
        style.textContent = `
            @media (max-width: 767.98px) {
                .custom-pop-timer {
                    font-size: 8pt !important;
                }
            }
        `;
        document.head.appendChild(style);
    }

    document.querySelectorAll('.progress-bar-timed').forEach(barContainer => {
        const title = barContainer.getAttribute('title') || "";
        const durMatch = title.match(/Duration:\s*([a-zA-Z0-9\.\s:]+)/);
        if (!durMatch) return;
        if (barContainer.querySelector('.custom-pop-timer')) return;

        let durationText = durMatch[1].trim();
        durationText = durationText.replace(/^(\d+)\./, '$1d ');

        const timerDiv = document.createElement('div');
        timerDiv.className = 'custom-pop-timer';
        timerDiv.innerText = durationText; 
        
        timerDiv.style.position = 'absolute';
        timerDiv.style.top = '50%';
        timerDiv.style.transform = 'translateY(-50%)';
        timerDiv.style.left = '6px';
        timerDiv.style.zIndex = '10';
        timerDiv.style.color = '#ffffff';
        timerDiv.style.fontFamily = 'monospace';
        timerDiv.style.fontSize = '9pt';
        timerDiv.style.fontWeight = 'bold';
        timerDiv.style.whiteSpace = 'nowrap';
        timerDiv.style.pointerEvents = 'none';
        
        barContainer.style.position = 'relative';
        barContainer.appendChild(timerDiv);

        const progressText = barContainer.querySelector('.progress-text');
        if (progressText) {
            progressText.classList.add('d-none', 'd-md-block');
        }
    });
}

export async function initScienceCultureCalc() {
    if (!window.location.pathname.toLowerCase().includes('/game/science')) return;

    const headers = document.querySelectorAll('th');
    let production = 0;
    headers.forEach(th => {
        if (th.innerText.includes('Culture')) {
            const matchText = th.innerText.match(/\+([^/]+)\/h/);
            if (matchText) {
                production = parseLocaleNumber(matchText[1]);
            }
        }
    });

    const rows = document.querySelectorAll('table tbody tr');
    let targetRow = null;
    let currentLevel = 0;

    rows.forEach(row => {
        const text = row.innerText;
        if ((text.includes('Culture') || text.includes('Cul')) && !text.includes('Science')) {
            const lvlCell = row.cells[1];
            if (lvlCell) {
                const lvl = parseInt(lvlCell.innerText.trim(), 10);
                if (!isNaN(lvl)) {
                    currentLevel = lvl;
                    targetRow = row;
                }
            }
        }
    });

    if (targetRow && production > 0) {
        if (targetRow.getAttribute('data-calc-injected') === 'true' || targetRow.querySelector('.custom-culture-calc-container')) return;
        
        targetRow.setAttribute('data-calc-injected', 'true');

        const timer = targetRow.querySelector('.timer-active');
        const currentSeconds = timer ? parseInt(timer.getAttribute('data-value'), 10) : 0;

        try {
            const res = await gameFetch('/Info/CultureTable');
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const infoRows = doc.querySelectorAll('table tbody tr');

            const getPointsForLevel = (lvl) => {
                for (const r of infoRows) {
                    const cells = r.querySelectorAll('td');
                    if (cells.length >= 2 && parseInt(cells[0].innerText, 10) === lvl) {
                        return parseInt(cells[1].innerText.replace(/\s/g, '').replace(/[\.,]/g, ''), 10) || 0;
                    }
                }
                return 0;
            };

            const nextLevels = [];
            let cumulativeSeconds = currentSeconds;

            for (let i = 1; i <= 3; i++) {
                const targetLvl = currentLevel + i;
                let secondsToReach = 0;

                if (i === 1) {
                    secondsToReach = currentSeconds;
                } else {
                    const points = getPointsForLevel(targetLvl);
                    if (points > 0) {
                        cumulativeSeconds += (points / production) * 3600;
                    }
                    secondsToReach = cumulativeSeconds;
                }

                if (secondsToReach > 0) {
                    const finishDate = new Date(Date.now() + secondsToReach * 1000);
                    const dateStr = finishDate.toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' ' + 
                                    finishDate.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', hour12: false});

                    nextLevels.push({
                        lvl: targetLvl,
                        duration: formatDuration(secondsToReach),
                        date: dateStr
                    });
                }
            }

            if (nextLevels.length > 0) {
                const container = document.createElement('div');
                container.className = 'custom-culture-calc-container';
                container.style.marginTop = "4px";
                container.style.fontSize = "11px"; // Set to 11px size
                container.style.color = "#aaa";
                
                nextLevels.forEach(item => {
                    const line = document.createElement('div');
                    // Label styling flipped to normal grey; duration wrapped in bold white span
                    line.innerHTML = `<span style="color:#aaa; font-weight:normal;">Lvl ${item.lvl}:</span> <span style="color:#fff; font-weight:bold;">${item.duration}</span> <span style="color:#888;">(${item.date})</span>`;
                    container.appendChild(line);
                });

                if (targetRow.cells[2]) {
                    targetRow.cells[2].appendChild(container);
                }
            }
        } catch (e) {
            console.error("Calc Error", e);
            targetRow.removeAttribute('data-calc-injected');
        }
    }
}

// ---------------------------------------------------------------
// COLONY SHIP LAUNCH WINDOWS (Science page, next to the Culture row)
// "When do I need to launch, so the ship lands only after the next culture slot is
// actually open?" A ship that arrives too early just sits there wasted — colonizing
// needs a free slot at the moment it lands, not merely by the time it's built — so this
// computes the EARLIEST safe launch time per planned (Free/Unknown, i.e. actually
// colonizable) target: arrival must be at or after the next culture level-up AND at or
// after the standard server cycle tick that actually applies it (culture level-ups, like
// every other stat, only take effect when that 5-min cycle runs — landing one second
// before it does not yet have the slot). Requires: the culture row's own live timer
// (seconds until the NEXT level — no CultureTable fetch needed, unlike
// initScienceCultureCalc's level+2/+3 look-ahead), the "Standard server hosting cycle"
// badge in the page footer (its own timer, to find the cycle's tick alignment), the
// player's own Energy science level (ships' speed bonus, read straight off this same
// page), and GET /hub-api/intel/colonize-launch-windows for the launch origin (v1: always
// home, per the user) and the list of colonizable plans.
// ---------------------------------------------------------------

// The footer's "Standard server hosting cycle" badge (Production/Growth/Science/Culture)
// — distinguished from the OTHER footer timers (fleet hosting, trade) by its tooltip text,
// not by data-repeat, since a repeat interval is an implementation detail that could
// coincidentally collide with another cycle's.
function findServerCycleTimer() {
    const nodes = document.querySelectorAll('[data-timer][data-at-datetime]');
    for (const el of nodes) {
        const badge = el.closest('[title], [data-bs-original-title]');
        const title = (badge && (badge.getAttribute('data-bs-original-title') || badge.getAttribute('title'))) || '';
        if (/standard server hosting cycle/i.test(title)) return el;
    }
    return null;
}

// The next tick of a repeating cycle at or after `targetMs`, given one known tick's
// timing (secondsUntilNextTick, read live off the page right now).
function nextCycleTickAtOrAfter(targetMs, secondsUntilNextTick, repeatSeconds) {
    const firstTickMs = Date.now() + secondsUntilNextTick * 1000;
    if (targetMs <= firstTickMs) return firstTickMs;
    const repeatMs = repeatSeconds * 1000;
    const ticksNeeded = Math.ceil((targetMs - firstTickMs) / repeatMs);
    return firstTickMs + ticksNeeded * repeatMs;
}

export async function initColonizeLaunchWindows() {
    if (!window.location.pathname.toLowerCase().includes('/game/science')) return;

    // Find the Culture row exactly like initScienceCultureCalc does, and read its live
    // timer directly — the seconds remaining until the CURRENTLY IN-PROGRESS level, i.e.
    // the very next one, which is all a launch-window calc needs (unlike the level+2/+3
    // look-ahead elsewhere on this page, no CultureTable fetch is required here).
    let cultureRow = null;
    document.querySelectorAll('table tbody tr').forEach(row => {
        const text = row.innerText;
        if ((text.includes('Culture') || text.includes('Cul')) && !text.includes('Science') && row.cells[1]) {
            if (!isNaN(parseInt(row.cells[1].innerText.trim(), 10))) cultureRow = row;
        }
    });
    if (!cultureRow) return;

    // Claim this row SYNCHRONOUSLY, before any await below — same fix as
    // initScienceCultureCalc's data-calc-injected. The native timers on this page tick
    // every second via their own DOM updates, each of which re-triggers spy.js's
    // MutationObserver-driven view hook; checking "does the final container exist yet"
    // is not enough, because this function is async and multiple invocations can all pass
    // that check before the FIRST one has gotten far enough to create it, each starting
    // its own full (rate-limited, multi-second) run and appending a duplicate. A flag set
    // before the first await closes that window (2026-09-02 fix — this exact bug produced
    // seven stacked copies within moments of the page loading).
    if (cultureRow.getAttribute('data-colonize-injected') === 'true') return;
    cultureRow.setAttribute('data-colonize-injected', 'true');

    const cultureTimer = cultureRow.querySelector('.timer-active');
    if (!cultureTimer) return; // not currently researching culture — no ETA to plan around
    const secondsToNextCulture = parseInt(cultureTimer.getAttribute('data-value'), 10) || 0;
    if (secondsToNextCulture <= 0) return;

    const cycleTimer = findServerCycleTimer();
    if (!cycleTimer) return; // footer not present/rendered yet — try again next view pass
    const cycleSeconds = parseInt(cycleTimer.getAttribute('data-value'), 10) || 0;
    const cycleRepeat = parseInt(cycleTimer.getAttribute('data-repeat'), 10) || 0;
    if (cycleRepeat <= 0) return;

    const cultureLevelUpMs = Date.now() + secondsToNextCulture * 1000;
    // One extra full cycle on top of the first tick at/after the level-up (2026-09-02, per
    // the user: landing exactly ON that boundary tick is too tight a margin — nothing
    // guarantees the server has actually finished applying THAT tick's culture update the
    // instant it fires, e.g. a level-up landing at :04:59 with a cycle at :05:00 could still
    // process after a ship arriving right at :05:00. Arriving a full cycle later than the
    // earliest possible tick costs a few extra minutes of wait but removes that risk.
    const arrivalCutoffMs = nextCycleTickAtOrAfter(cultureLevelUpMs, cycleSeconds, cycleRepeat) + cycleRepeat * 1000;

    let data;
    try {
        const res = await fetch('/hub-api/intel/colonize-launch-windows');
        data = await res.json();
    } catch (e) {
        console.warn('[Spy] colonize launch-windows fetch failed:', e.message);
        cultureRow.removeAttribute('data-colonize-injected'); // transient network hiccup — allow a later retry
        return;
    }
    if (!data || !data.success || !data.origin || !Array.isArray(data.plans) || !data.plans.length) return;

    const energyState = readScienceState(SCIENCES.find(s => s.name === 'Energy'));
    const energyLevel = energyState ? energyState.level : 0;

    const results = [];
    for (const plan of data.plans) {
        try {
            const res = await getTravelTime({
                fromSystem: data.origin.system_id, fromPlanetIndex: data.origin.planet_index,
                toSystem: plan.system_id, toPlanetIndex: plan.planet_index, energyLevel,
            });
            if (!res.ok || !res.data || typeof res.data.totalSeconds !== 'number') continue;
            const launchMs = arrivalCutoffMs - res.data.totalSeconds * 1000;
            const launchDate = new Date(launchMs);
            const label = `${plan.system_name} [${plan.system_id}] #${plan.planet_index}`;
            results.push({
                label,
                pastDue: launchMs <= Date.now(),
                dateStr: launchDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                         launchDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
            });
        } catch (e) {
            // One bad plan must not block the rest.
            console.warn('[Spy] colonize launch-window calc failed for a plan:', e.message);
        }
    }
    if (!results.length) return;

    const container = document.createElement('div');
    container.id = 'custom-colonize-windows';
    container.style.marginTop = '4px';
    container.style.fontSize = '11px';
    container.style.color = '#aaa';
    const header = document.createElement('div');
    header.innerHTML = '<span style="color:#888;">Colony ship launch windows (land after next culture slot):</span>';
    container.appendChild(header);
    results.forEach(r => {
        const line = document.createElement('div');
        const timeSpan = r.pastDue
            ? `<span style="color:#e88;font-weight:bold;">launch now</span>`
            : `<span style="color:#fff;font-weight:bold;">${r.dateStr}</span>`;
        line.innerHTML = `<span style="color:#aaa;">${esc(r.label)}:</span> ${timeSpan}`;
        container.appendChild(line);
    });

    // cells[3] is the raw points-progress value (e.g. "55.785"), cells[4] is the actual
    // "Remain" time column (e.g. "07:22:28") — confirmed against the live page's real cell
    // layout (2026-09-02). Appended below the existing time text, in that same cell.
    if (cultureRow.cells[4]) cultureRow.cells[4].appendChild(container);
}

// ---------------------------------------------------------------
// SCIENCE LEVEL CALCULATOR (interactive)
// "Pick a science, enter a target level -> total time + finish date."
// Reuses the proven culture-calc maths: read current level + research
// rate + in-progress timer from the page, then divide the remaining
// points-per-level (from the Info table) by the rate.
// ---------------------------------------------------------------
// name = display/level-table key; aliases = how the row's first cell may read
// (the science page abbreviates: Bio Eco E Math Phy Soc Cul). Matched exactly so
// "E" (Energy) doesn't substring-match Eco, etc.
const SCIENCES = [
    { name: 'Biology', aliases: ['biology', 'bio'] },
    { name: 'Economy', aliases: ['economy', 'eco'] },
    { name: 'Energy', aliases: ['energy', 'e'] },
    { name: 'Mathematics', aliases: ['mathematics', 'math'] },
    { name: 'Physics', aliases: ['physics', 'phy'] },
    { name: 'Social', aliases: ['social', 'soc'] },
    { name: 'Culture', aliases: ['culture', 'cul'] },
];
const _pointsTableCache = {};

// Locale-agnostic number parse. The game renders numbers in either "1,039.5" (comma
// thousands, dot decimal) or "1.039,5" / "49,5" (dot thousands, comma decimal) depending
// on locale — so which separator is the decimal can't be hard-coded. Rule: when both
// separators appear, the LAST one is the decimal; when only one appears once, it's the
// decimal unless it sits in thousands position (followed by exactly 3 digits). Mirrors
// trade.js's parseLocaleNumber. The old version assumed comma=decimal, which turned a
// rate like "1,039.5/h" into 1.0395 — ~1000x too slow, giving absurd ETAs (e.g. 186 days
// instead of ~5h) once a rate crossed 1,000 and gained a thousands separator.
function parseLocaleNumber(str) {
    if (str == null) return 0;
    let s = String(str).replace(/[^\d.,]/g, '');
    if (!s) return 0;
    const nComma = (s.match(/,/g) || []).length;
    const nDot = (s.match(/\./g) || []).length;
    let dec = null;
    if (nComma && nDot) {
        dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    } else if (nComma === 1 || nDot === 1) {
        const sep = nComma ? ',' : '.';
        if (s.length - s.lastIndexOf(sep) - 1 !== 3) dec = sep;
    }
    if (dec) s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
    else s = s.replace(/[.,]/g, '');
    const v = parseFloat(s);
    return isNaN(v) ? 0 : v;
}

// Cumulative incremental points required to advance INTO each level.
async function getPointsTable(url) {
    if (_pointsTableCache[url]) return _pointsTableCache[url];
    const res = await fetch(url);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const map = {};
    doc.querySelectorAll('table tbody tr').forEach(r => {
        const cells = r.querySelectorAll('td');
        if (cells.length >= 2) {
            const lvl = parseInt(cells[0].innerText, 10);
            const pts = parseInt(cells[1].innerText.replace(/\s/g, '').replace(/[.,]/g, ''), 10);
            if (!isNaN(lvl) && !isNaN(pts)) map[lvl] = pts;
        }
    });
    _pointsTableCache[url] = map;
    return map;
}

// Read {level, rate (pts/h), timerSecs, researching} for a science off the page.
// `sci` is a SCIENCES entry { name, aliases }.
function readScienceState(sci) {
    // Find the row whose first cell exactly equals one of the aliases (the page
    // abbreviates names), with a numeric level in the second cell.
    let row = null, level = NaN;
    document.querySelectorAll('table tr').forEach(r => {
        if (row || !r.cells || r.cells.length < 2 || !r.cells[0]) return;
        const c0 = r.cells[0].innerText.trim().toLowerCase();
        if (!sci.aliases.includes(c0)) return;
        const lvl = parseInt(r.cells[1].innerText, 10);
        if (!isNaN(lvl)) { row = r; level = lvl; }
    });
    if (!row) return null;

    // Rate is the shared research output, shown in a header like "Science +293.3/h"
    // (or "Culture +X/h"); also tolerate abbreviated "Sci"/"Cul" labels on mobile.
    // You research one science at a time, so all six sciences share the Science rate.
    const labels = sci.name === 'Culture' ? ['Culture', 'Cul'] : ['Science', 'Sci'];
    const rateRe = new RegExp('(?:' + labels.join('|') + ')\\s*\\+([\\d.,\\s\\u00a0]+)\\/h', 'i');
    let rate = 0, bonusPct = 0;
    document.querySelectorAll('th, td').forEach(el => {
        if (rate) return;
        const mm = (el.innerText || '').match(rateRe);
        if (!mm) return;
        rate = parseLocaleNumber(mm[1]);
        // The same header carries a "+X%" bonus badge (research/culture modifier, e.g.
        // "+38.6%" after the flask icon). The displayed rate ALREADY includes it, so we
        // read it to back out the pre-bonus base growth (see baseGrowth) for the what-if
        // inputs. Prefer the .bonus badge; fall back to a "+N%" match in the header text.
        const bonusEl = el.querySelector('.bonus');
        const bm = ((bonusEl && bonusEl.innerText) || el.innerText || '').match(/\+\s*([\d.,]+)\s*%/);
        if (bm) bonusPct = parseLocaleNumber(bm[1]);
    });

    const timer = row.querySelector('.timer-active');
    const timerSecs = timer ? (parseInt(timer.getAttribute('data-value'), 10) || 0) : 0;

    // Base growth = displayed rate with the % bonus removed. One extra research building
    // adds 1 to this base; the bonus (and any what-if extra %) then re-multiplies it.
    const baseGrowth = bonusPct > -100 ? rate / (1 + bonusPct / 100) : rate;

    return { level, rate, bonusPct, baseGrowth, timerSecs, researching: !!timer };
}

export async function initScienceLevelCalculator() {
    if (!window.location.pathname.toLowerCase().includes('/game/science')) return;
    if (document.getElementById('hub-science-calc')) return;

    // Always render the box first so it's visible even if detection fails —
    // this is how we diagnose mobile (no console there): the box shows what it found.
    const box = document.createElement('div');
    box.id = 'hub-science-calc';
    box.style.cssText = 'box-sizing:border-box;margin:8px 0 0 0;padding:10px 12px;border:1px solid #444;border-radius:6px;background:#1a1a1a;color:#ddd;font-size:13px;width:100%;max-width:520px;';

    // Detect which sciences are present on the page (with their current level).
    const available = SCIENCES
        .map(sci => ({ name: sci.name, sci, state: readScienceState(sci) }))
        .filter(s => s.state);

    if (available.length === 0) {
        // Diagnostic readout, visible on-screen (incl. mobile).
        const tables = document.querySelectorAll('table').length;
        const rows = document.querySelectorAll('table tr').length;
        const firstCells = Array.from(document.querySelectorAll('table tr'))
            .slice(0, 8)
            .map(r => (r.cells && r.cells[0] ? r.cells[0].innerText.trim().slice(0, 18) : '∅'))
            .filter(Boolean);
        box.innerHTML = `
            <div style="font-weight:bold;color:#fff;margin-bottom:6px;">🔬 Research Calculator — no sciences detected</div>
            <div style="color:#c96;font-size:11px;line-height:1.5;">
                tables: ${tables} · rows: ${rows}<br>
                first cells: ${firstCells.length ? esc(firstCells.join(' | ')) : '(none)'}
            </div>`;
        const clk = document.querySelector('[data-clock]');
        ((clk && clk.closest('div')) || document.body || document.documentElement).appendChild(box);
        return;
    }

    const inStyle = 'background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 6px;';
    box.innerHTML = `
        <div style="font-weight:bold;color:#fff;margin-bottom:8px;">🔬 Research Time Calculator</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <select id="hub-sci-select" style="${inStyle}">
                ${available.map(s => `<option value="${s.name}">${s.name} (lvl ${s.state.level})</option>`).join('')}
            </select>
            <span style="color:#888;">to level</span>
            <input id="hub-sci-target" type="number" min="1" style="width:70px;${inStyle}" placeholder="30">
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px;">
            <span style="color:#888;">what if:</span>
            <input id="hub-sci-buildings" type="number" min="0" style="width:110px;${inStyle}" placeholder="+ buildings" title="Extra research buildings — each adds 1 to base growth (before the % bonus).">
            <input id="hub-sci-extra" type="number" min="0" step="any" style="width:90px;${inStyle}" placeholder="+ %" title="Extra % bonus stacked on top of the current one (e.g. artifact/event), applied multiplicatively.">
        </div>
        <div id="hub-sci-result" style="margin-top:8px;color:#aaa;min-height:18px;"></div>
    `;
    // Drop it into the top badge bar (clock / hosting-cycle badges), below those
    // badges, so it shows in the same spot on PC and mobile.
    const clock = document.querySelector('[data-clock]');
    const badgeBar = clock ? clock.closest('div') : null;
    (badgeBar || document.body || document.documentElement).appendChild(box);

    const selEl = box.querySelector('#hub-sci-select');
    const targetEl = box.querySelector('#hub-sci-target');
    const buildingsEl = box.querySelector('#hub-sci-buildings');
    const extraEl = box.querySelector('#hub-sci-extra');
    const resultEl = box.querySelector('#hub-sci-result');

    const compute = async () => {
        const name = selEl.value;
        const sci = SCIENCES.find(s => s.name === name);
        const target = parseInt(targetEl.value, 10);
        const st = sci ? readScienceState(sci) : null;
        if (!st) { resultEl.innerHTML = '<span style="color:#e88;">Could not read current state.</span>'; return; }
        if (isNaN(target)) { resultEl.innerText = ''; return; }
        if (target <= st.level) { resultEl.innerHTML = `<span style="color:#9c9;">Already at level ${st.level}.</span>`; return; }
        if (st.rate <= 0) { resultEl.innerHTML = '<span style="color:#e88;">No research rate detected for this science.</span>'; return; }

        // What-if inputs: extra buildings add to base growth (1 each), extra % stacks
        // multiplicatively on top of the current bonus. With both blank, effRate == the
        // live rate, so the result matches the plain calculation.
        const buildings = parseInt(buildingsEl.value, 10) || 0;
        const extraPct = parseFloat(extraEl.value) || 0;
        const effRate = (st.baseGrowth + buildings) * (1 + st.bonusPct / 100) * (1 + extraPct / 100);
        const modified = buildings !== 0 || extraPct !== 0;
        if (effRate <= 0) { resultEl.innerHTML = '<span style="color:#e88;">Effective rate is zero.</span>'; return; }

        try {
            const url = name === 'Culture' ? '/Info/CultureTable' : '/Info/ScienceTable';
            const table = await getPointsTable(url);

            let total = 0;
            let startK = st.level + 1;
            // The in-progress research timer is measured at the CURRENT rate; scale it to
            // the effective rate so it stays consistent when the what-if inputs change.
            if (st.researching) { total += st.timerSecs * (st.rate / effRate); startK = st.level + 2; }

            const missing = [];
            for (let k = startK; k <= target; k++) {
                const pts = table[k];
                if (pts == null || isNaN(pts)) { missing.push(k); continue; }
                total += (pts / effRate) * 3600;
            }

            const finish = new Date(Date.now() + total * 1000);
            const dateStr = finish.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                            finish.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
            let html = `<span style="color:#aaa;">Lvl ${st.level} → ${target}:</span> <span style="color:#fff;font-weight:bold;">${formatDuration(total)}</span> <span style="color:#888;">(${dateStr})</span>`;
            html += `<br><span style="color:#666;font-size:11px;">rate ${Math.round(effRate).toLocaleString()}/h${modified ? ` (was ${Math.round(st.rate).toLocaleString()})` : ''}${st.researching ? ' · current research counted' : ''}</span>`;
            if (missing.length) html += `<br><span style="color:#c96;font-size:11px;">No cost data for level(s): ${missing.join(', ')}</span>`;
            resultEl.innerHTML = html;
        } catch (e) {
            resultEl.innerHTML = '<span style="color:#e88;">Failed to load the level cost table.</span>';
        }
    };

    selEl.addEventListener('change', compute);
    targetEl.addEventListener('input', compute);
    buildingsEl.addEventListener('input', compute);
    extraEl.addEventListener('input', compute);
}

function formatDuration(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    
    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

export async function initAllianceNewsAlerts() {
    if (!window.location.pathname.toLowerCase().startsWith('/game/news')) return;

    const newsTable = document.querySelector('.table.hover');
    if (!newsTable || newsTable.getAttribute('data-broadcasts-injected') === 'true') return;
    newsTable.setAttribute('data-broadcasts-injected', 'true');

    const newsTableBody = newsTable.querySelector('tbody');
    if (!newsTableBody) return;

    try {
        const res = await fetch('/hub-api/broadcasts');
        const data = await res.json();
        if (!data.success || !data.broadcasts || data.broadcasts.length === 0) return;

        const filterRow = newsTableBody.querySelector('tr.lowlight');

        for (const b of [...data.broadcasts].reverse()) {
            const rowHTML = `
                <tr class="custom-alliance-broadcast-row" style="border-left: 3px solid #1e3a8a; background-color: rgba(121, 53, 14, 0.47);">
                    <td class="msg player-incoming unread" style="vertical-align: top; white-space: nowrap; background-color: rgba(77, 41, 7, 0.85) !important;">
                        ${esc(b.display_time)}
                        <br>
                        <b>(<span>${esc(b.author_name)}</span>)</b>
                    </td>
                    <td class="black text-left" style="vertical-align: top; padding: 6px 12px; background-color: transparent !important;">
                        <!-- message is intentionally NOT escaped: the admin panel labels this
                             field "HTML Tags Supported" and it is written by admins only, who
                             can already change passwords and wipe the database. Everything
                             around it is plain text and is escaped. -->
                        <div><b>${esc(b.title)}</b> ${b.message}</div>
                    </td>
                </tr>
            `;

            if (filterRow) {
                filterRow.insertAdjacentHTML('afterend', rowHTML);
            } else {
                newsTableBody.insertAdjacentHTML('afterbegin', rowHTML);
            }
        }
    } catch (e) {
        console.error("[AWT Extension] Broadcast Injection Failed:", e);
        newsTable.removeAttribute('data-broadcasts-injected');
    }
}

export function initStarbaseTimer() {
    if (!window.location.pathname.toLowerCase().includes('/game/planets/planet/')) return;

    const starbaseRow = document.querySelector('tr[data-spend-to="Starbase"]');
    if (!starbaseRow) return;

    const barContainer = starbaseRow.querySelector('.progress-bar');
    if (!barContainer) return;
    if (barContainer.querySelector('.custom-starbase-timer')) return;

    const lvlCell = starbaseRow.querySelector('.building-lvl-up') || starbaseRow.cells[1];
    const remainCell = starbaseRow.cells[3];
    if (!lvlCell || !remainCell) return;

    const level = parseInt(lvlCell.innerText.trim(), 10);
    const remain = parseInt(remainCell.innerText.trim(), 10);

    if (isNaN(level) || isNaN(remain) || level <= 0 || remain <= 0) return;

    const growthPerHour = level / 5;
    const hoursNeeded = remain / growthPerHour;

    const totalMinutes = Math.round(hoursNeeded * 60);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    let timerText = '±';
    if (days > 0) {
        timerText += `${days}d ${hours}h`;
    } else if (hours > 0) {
        timerText += `${hours}h ${mins}m`;
    } else {
        timerText += `${mins}m`;
    }

    const timerDiv = document.createElement('div');
    timerDiv.className = 'custom-starbase-timer';
    timerDiv.innerText = timerText;

    timerDiv.style.position = 'absolute';
    timerDiv.style.top = '50%';
    timerDiv.style.transform = 'translateY(-50%)';
    timerDiv.style.left = '6px';
    timerDiv.style.zIndex = '10';
    timerDiv.style.color = '#ffffff';
    timerDiv.style.fontFamily = 'monospace';
    timerDiv.style.fontSize = '12px';
    timerDiv.style.fontWeight = 'bold';
    timerDiv.style.whiteSpace = 'nowrap';
    timerDiv.style.pointerEvents = 'none';

    barContainer.style.position = 'relative';
    barContainer.appendChild(timerDiv);
}

// ---------------------------------------------------------------
// PLAYER LEVEL (PL) AUTOGROWTH CALCULATOR (profile page)
// PL grows twice a day (00:00 & 12:00 CET) by a % of current XP.
// Observed rate: +0.3% per update per point of SAD = Speed+Attack+Defence
// (so SAD +4 ≈ +1.2%/upd). factor = SAD * 0.003 per update.
// We just show the ETA to the next level.
// ---------------------------------------------------------------
let _plAggCache = null;

// Build {level: aggregatedXP} from /Info/PlayerLevelTable (cols: Level, XP, Aggregated).
async function getPLAggregatedTable() {
    if (_plAggCache) return _plAggCache;
    const res = await gameFetch('/Info/PlayerLevelTable');
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const map = {};
    doc.querySelectorAll('table tbody tr').forEach(r => {
        const cells = r.querySelectorAll('td');
        if (cells.length >= 3) {
            const lvl = parseInt(cells[0].innerText, 10);
            const agg = parseLocaleNumber(cells[2].innerText);
            if (!isNaN(lvl) && agg > 0) map[lvl] = agg;
        }
    });
    _plAggCache = map;
    return map;
}

// Read a race combat stat (Speed/Attack/Defence) off the profile's race-summary table.
function readRaceStat(label) {
    let val = null;
    document.querySelectorAll('.race-summary tbody td').forEach(td => {
        if (val !== null) return;
        const text = td.innerText.trim();
        if (text.includes(label)) {
            const m = text.match(/([+-]?\d+)\s*$/);
            if (m) val = parseInt(m[1], 10);
        }
    });
    return val;
}

// Next PL update is at 00:00 or 12:00 Europe/Berlin time. Returns a Date.
function nextPLUpdate() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit',
        second: '2-digit', hour12: false
    }).formatToParts(now);
    const get = t => parseInt(parts.find(p => p.type === t).value, 10);
    const h = get('hour') % 24, m = get('minute'), s = get('second');
    const secsSinceMidnight = h * 3600 + m * 60 + s;
    const secsToNext = ((secsSinceMidnight < 43200) ? 43200 : 86400) - secsSinceMidnight;
    return new Date(now.getTime() + secsToNext * 1000);
}

export async function initProfilePLGrowth() {
    if (!window.location.pathname.toLowerCase().includes('/game/players/profile/')) return;

    // Locate the "Player Level" value cell: "6 - 77% (72 XP)".
    let valCell = null, levelText = '';
    document.querySelectorAll('table tbody tr').forEach(row => {
        if (valCell) return;
        const cells = row.querySelectorAll('th, td');
        if (cells.length >= 2 && cells[0].innerText.includes('Player Level')) {
            valCell = cells[1];
            levelText = cells[1].innerText;
        }
    });
    if (!valCell) return;
    if (valCell.querySelector('.awt-pl-growth')) return;   // idempotent

    const lvlMatch = levelText.match(/(\d+)\s*-\s*(\d+)\s*%/);
    const xpMatch = levelText.match(/([\d.,\s ]+)\s*XP/);
    if (!lvlMatch || !xpMatch) return;

    const currentLevel = parseInt(lvlMatch[1], 10);
    const xpToNext = parseLocaleNumber(xpMatch[1]);
    if (isNaN(currentLevel) || xpToNext <= 0) return;

    // Mark early so the 200ms poller doesn't re-enter while we await.
    const placeholder = document.createElement('div');
    placeholder.className = 'awt-pl-growth';
    placeholder.style.cssText = 'margin-top:4px;font-size:11px;color:#888;';
    placeholder.textContent = '⏳ PL growth…';
    valCell.appendChild(placeholder);

    try {
        const agg = await getPLAggregatedTable();
        const nextLevel = currentLevel + 1;
        const target = agg[nextLevel];
        if (!target) { placeholder.remove(); return; }

        const currentXP = target - xpToNext;

        const speed = readRaceStat('Speed');
        const attack = readRaceStat('Attack');
        const defence = readRaceStat('Defence') ?? readRaceStat('Defense');

        if (speed === null || attack === null || defence === null) {
            placeholder.innerHTML = `<span style="color:#c96;">PL ${currentXP.toLocaleString()} XP — combat stats not visible (need intel)</span>`;
            return;
        }

        // SAD = Speed + Attack + Defence (raw sum, range −12..+12). Growth is linear across
        // the range: −12 → 0% per update, +12 → 2.4% per update (0.1% per SAD point).
        const sad = speed + attack + defence;
        const factor = Math.max(0, (sad + 12) * 0.001);

        if (factor <= 0) {
            placeholder.innerHTML = `<span style="color:#aaa;">PL ${currentXP.toLocaleString()} XP · SAD ${sad >= 0 ? '+' : ''}${sad} — no growth</span>`;
            return;
        }

        // Updates to reach the next level, compounding (1 + factor) per update.
        const updates = Math.ceil(Math.log(target / currentXP) / Math.log(1 + factor));
        // First growth lands at the next update; level-up after `updates` updates.
        const finish = new Date(nextPLUpdate().getTime() + (updates - 1) * 43200 * 1000);
        const fmtDate = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                             d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

        placeholder.innerHTML = `<span style="color:#aaa;">PL → lvl ${nextLevel} in </span>`
            + `<b style="color:#fff;">${updates} upd</b> <span style="color:#666;">(${fmtDate(finish)})</span>`;
    } catch (e) {
        console.error('[AWT] PL growth calc failed:', e);
        placeholder.remove();
    }
}

// Hub-tracked additions to a player's profile page: an always-shown login-time heatmap
// ("Activity Log" — Hub-tracked, independent of intel), and, only when the game itself is
// NOT currently showing live intel (no .race-summary/.ir-summary table on the page — either
// never scanned or the scan has expired), a "last known" fallback built from whatever the
// Hub last captured. When the game IS showing live intel, that block is skipped entirely —
// duplicating what the player can already see would just be clutter.
//
// Also hides the "Astro Wars Supporter" promo rows unconditionally (unrelated to intel).
export async function initProfileHubIntel() {
    if (!window.location.pathname.toLowerCase().includes('/game/players/profile/')) return;

    hideSupporterPromo();

    if (document.getElementById('awt-hub-intel-block')) return; // idempotent

    const idMatch = window.location.pathname.match(/\/Profile\/(\d+)/i);
    const playerId = idMatch ? idMatch[1] : null;
    if (!playerId) return;

    // Anchor: the Planets table's own column wrapper exists in every layout variant seen
    // so far (with or without live intel) — insert our block immediately before it, so it
    // lands right after the player-info/intel area and before the planet list.
    const planetsTable = document.querySelector('table.sortable');
    const anchor = planetsTable ? planetsTable.closest('.col-12, .col-lg-6') : null;
    if (!anchor || !anchor.parentNode) return;

    let data;
    try {
        const res = await fetch(`/hub-api/intel/player/${playerId}`);
        data = await res.json();
    } catch (err) {
        return;
    }
    if (!data || !data.success || !data.player) return;
    const p = data.player;

    const hasLiveIntel = !!document.querySelector('.race-summary, .ir-summary');

    const wrap = document.createElement('div');
    wrap.className = 'col-12';
    wrap.id = 'awt-hub-intel-block';
    wrap.innerHTML = `
        <div class="row">
            <div class="col-lg-6">${buildActivityLogCard(data.heatmap)}</div>
            <div class="col-lg-6">${buildBuildingsCard(p)}</div>
        </div>`;
    anchor.parentNode.insertBefore(wrap, anchor);

    // Without live intel, the game renders the player-info card as a single col-12 instead
    // of its usual col-lg-6 paired with an Intelligence Report column — there is no "top
    // right" slot already waiting for us. Reclaim it: shrink player-info to col-lg-6 (the
    // same width it would already be if the game itself had intel to show) and place the
    // Hub Intel card beside it as the second column, so a profile with no intel on record
    // ends up laid out exactly like one that does, just with X's instead of numbers.
    if (!hasLiveIntel) {
        const playerInfoTable = [...document.querySelectorAll('table.table')]
            .find(t => t.querySelector('tbody tr td')?.textContent?.trim() === 'Local Time');
        const playerInfoCol = playerInfoTable ? playerInfoTable.closest('[class*="col-"]') : null;
        if (playerInfoCol) {
            playerInfoCol.className = 'col-lg-6';
            const intelCol = document.createElement('div');
            intelCol.className = 'col-lg-6';
            intelCol.id = 'awt-hub-intel-col';
            intelCol.innerHTML = buildIntelCard(p);
            playerInfoCol.insertAdjacentElement('afterend', intelCol);
        }
    }
}

function hideSupporterPromo() {
    document.querySelectorAll('table th[colspan="2"]').forEach(th => {
        if (th.textContent.trim() !== 'Astro Wars Supporter') return;
        const headerRow = th.closest('tr');
        if (!headerRow || headerRow.dataset.awtHidden) return;
        const badgeRow = headerRow.nextElementSibling;
        headerRow.style.display = 'none';
        headerRow.dataset.awtHidden = '1';
        if (badgeRow) badgeRow.style.display = 'none';
    });
}

// No last-active line here on purpose — the game's own "Idle" field on this same page
// already says that, more precisely (live seconds/minutes, not our own polling cadence).
function buildActivityLogCard(heatmap) {
    const counts = Array.isArray(heatmap) && heatmap.length === 24 ? heatmap : Array(24).fill(0);
    const max = Math.max(1, ...counts);
    const offsetHours = Math.round(-new Date().getTimezoneOffset() / 60);
    const bars = counts.map((_, i) => {
        // Rotate UTC hours into the viewer's local time, same as intel.js's raw
        // per-hour counts assume UTC storage.
        const localHour = (i + offsetHours + 24) % 24;
        const count = counts[localHour];
        const pct = Math.round((count / max) * 100);
        return `<div title="${localHour}:00 — ${count} login(s)" style="flex:1;height:${Math.max(pct, 2)}%;background:#22c55e;border-radius:1px 1px 0 0;"></div>`;
    }).join('');

    return `
        <table class="table">
            <thead><tr><th><i class="bi bi-activity"></i> Activity <span style="font-weight:normal;font-size:10px;color:#888;">(local time)</span></th></tr></thead>
            <tbody>
                <tr><td>
                    <div style="display:flex;align-items:flex-end;gap:1px;height:50px;">${bars}</div>
                    <div style="display:flex;justify-content:space-between;font-size:9px;color:#888;margin-top:2px;">
                        <span>00h</span><span>12h</span><span>23h</span>
                    </div>
                </td></tr>
            </tbody>
        </table>`;
}

function buildBuildingsCard(p) {
    const row = (label, val) => `<tr><td>${esc(label)}</td><td class="lowlight">${val ?? 0}</td></tr>`;
    // The disclaimer is about the GAME's own Statistics page, not our scrape timing: it
    // reports building counts up to ~4 days behind live, so even a scrape taken this
    // second would still show old numbers. stats_scraped_at (when the Hub itself last
    // captured this) is real but secondary info — a hover tooltip, not the headline.
    const scrapedTitle = p.stats_scraped_at
        ? ` title="Hub last scraped this: ${esc(formatSqliteUtc(p.stats_scraped_at))}"`
        : '';
    return `
        <table class="table">
            <thead><tr${scrapedTitle}><th colspan="2"><i class="bi bi-building"></i> Buildings <span style="font-weight:normal;font-size:10px;color:#c96;">(4 day old data)</span></th></tr></thead>
            <tbody>
                ${row('Farms', p.total_farms)}
                ${row('Factories', p.total_factories)}
                ${row('Labs', p.total_labs)}
                ${row('Cybernetics', p.total_cybernetics)}
            </tbody>
        </table>`;
}

// Dispatches between the two shapes a player's row of intel columns can be in when this
// page has no live intel of its own to show: has_intel=1 means every column below was
// actually captured at some point (buildStaleIntelCard shows the real last-known values);
// has_intel=0 means the hub has never had vision on this player at all — the table still
// renders, with an "X" in every cell, so its absence never reads as "definitely zero" and
// its presence always tells a member at a glance whether the hub has ANY read on this
// player, without needing to check a separate signal.
function buildIntelCard(p) {
    return p.has_intel ? buildStaleIntelCard(p) : buildNoIntelCard();
}

// Mirrors the game's own Intelligence Report field order exactly, so a member who knows
// that table can read this one the same way. No Eco Bonus row: the real table doesn't
// have one either — that field lives elsewhere in the hub, not here.
const IR_ROW_LABELS = ['Biology', 'Economy', 'Energy', 'Mathematics', 'Physics', 'Social', 'Trade Revenue', 'Artefact'];

// Mirrors the game's own Race Summary grid: two traits per row, Defence alone in the last
// row (the game leaves that cell's partner empty too — there is no 8th trait to pair it
// with). `pct` is the TRAIT_PCT key, NOT the same spelling as the race_* column for
// growth/culture/production/speed — only defense/defence differ, but keeping every trait
// explicit here avoids relying on a naming coincidence for the rest.
const RACE_TRAITS = [
    { label: 'Growth', field: 'race_growth', pct: 'growth' },
    { label: 'Science', field: 'race_science', pct: 'science' },
    { label: 'Culture', field: 'race_culture', pct: 'culture' },
    { label: 'Production', field: 'race_production', pct: 'production' },
    { label: 'Speed', field: 'race_speed', pct: 'speed' },
    { label: 'Attack', field: 'race_attack', pct: 'attack' },
    { label: 'Defence', field: 'race_defense', pct: 'defence' },
];
const RACE_ROWS = [[0, 1], [2, 3], [4, 5], [6, null]].map(([a, b]) => [RACE_TRAITS[a], b == null ? null : RACE_TRAITS[b]]);

// "-32% Growth -4" — the game's own format: percent first (its own sign), trait name,
// then the raw per-level value (also signed, including +0).
function raceCellKnown(trait, value) {
    const v = value || 0;
    const pct = Math.round(v * TRAIT_PCT[trait.pct] * 100);
    return `${pct >= 0 ? '+' : ''}${pct}% ${trait.label} ${v >= 0 ? '+' : ''}${v}`;
}

function raceCellUnknown(trait) {
    return `${trait.label}: X`;
}

function buildIrTable(caption, rows) {
    return `
        <table class="table">
            <thead><tr><th colspan="2"><i class="bi bi-clock-history"></i> Hub Intel <span style="font-weight:normal;font-size:11px;${caption.color ? `color:${caption.color};` : ''}">${caption.text}</span></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function buildRaceTable(cellFn, values) {
    const rows = RACE_ROWS.map(([a, b]) => `
        <tr>
            <td>${esc(cellFn(a, values && values[a.field]))}</td>
            <td>${b ? esc(cellFn(b, values && values[b.field])) : ''}</td>
        </tr>`).join('');
    return `
        <table class="table mb-2">
            <thead><tr><th colspan="2">Race Summary</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function buildNoIntelCard() {
    const row = (label) => `<tr><td>${esc(label)}</td><td class="lowlight">X</td></tr>`;
    return buildIrTable({ text: '(no intel on record)', color: '#888' }, IR_ROW_LABELS.map(row).join(''))
        + buildRaceTable(raceCellUnknown, null);
}

function buildStaleIntelCard(p) {
    const row = (label, val) => `<tr><td>${esc(label)}</td><td class="lowlight">${esc(val)}</td></tr>`;
    const updatedAt = formatSqliteUtc(p.intel_updated_at, undefined, 'unknown date');
    const irRows = [
        row('Biology', p.biology || 0),
        row('Economy', p.economy || 0),
        row('Energy', p.energy || 0),
        row('Mathematics', p.mathematics || 0),
        row('Physics', p.physics || 0),
        row('Social', p.social || 0),
        row('Trade Revenue', `+${p.trade_revenue || 0}%`),
        row('Artefact', p.artefact || 'N/A'),
    ].join('');

    return buildIrTable({ text: `(last known — as of ${esc(updatedAt)}, not currently visible in-game)`, color: '#c96' }, irRows)
        + buildRaceTable(raceCellKnown, p);
}

(function() {
    console.log("[Hub Debug] page-injections.js has loaded on this page.");

    // Look at both the local path and the dashboard query param to support all proxy/iframe layouts
    const urlParams = new URLSearchParams(window.location.search);
    const combinedPath = window.location.pathname + (urlParams.get('p') || '');
    
    console.log(`[Hub Debug] Evaluating current execution path: "${combinedPath}"`);

    const allianceMatch = combinedPath.match(/\/Game\/Alliance\/Profile\/(\d+)/);
    
    if (allianceMatch) {
        const allianceId = allianceMatch[1];
        console.log(`[Hub Debug] Target Alliance detected. ID parsed: ${allianceId}`);
        
        // Execute targeting modification once DOM structures are parsed
        const injectIntelBadges = () => {
            // FIXED: Path changed to /hub-api to match mounting layout in server.js
            fetch(`/hub-api/alliance-intel/${allianceId}`)
                .then(res => {
                    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                    return res.json();
                })
                .then(trackedPlayerIds => {
                    console.log("[Hub Debug] Server returned tracked IDs:", trackedPlayerIds);

                    if (!Array.isArray(trackedPlayerIds) || trackedPlayerIds.length === 0) {
                        console.log("[Hub Debug] No intelligence dossiers found for this alliance in the DB.");
                        return;
                    }

                    const playerLinks = document.querySelectorAll('a[href^="/Game/Players/Profile/"]');
                    console.log(`[Hub Debug] Found ${playerLinks.length} player profile links on the page.`);

                    playerLinks.forEach(link => {
                        const href = link.getAttribute('href');
                        const playerMatch = href.match(/\/Game\/Players\/Profile\/(\d+)/);
                        
                        if (playerMatch) {
                            const playerId = playerMatch[1];
                            
                            // Loose comparison (String matching) to protect against SQLite type discrepancies
                            const isTracked = trackedPlayerIds.some(id => String(id) === String(playerId));
                            
                            if (isTracked) {
                                console.log(`[Hub Debug] Injecting tracker icon for player ID: ${playerId}`);
                                
                                // Prevent duplicating icons if script executes multiple times
                                if (link.nextSibling && link.nextSibling.classList && link.nextSibling.classList.contains('aw-intel-badge')) {
                                    return; 
                                }

                                const intelIcon = document.createElement('i');
                                intelIcon.className = 'bi bi-eye-fill text-success ms-1 aw-intel-badge';
                                intelIcon.style.fontSize = '0.85em';
                                intelIcon.style.verticalAlign = 'middle';
                                intelIcon.title = 'Tactical Intel Synced';
                                
                                link.parentNode.insertBefore(intelIcon, link.nextSibling);
                            }
                        }
                    });
                })
                .catch(err => console.error('[Hub Error] Failed to parse player intel mappings:', err));
        };

        // Run immediately if DOM is ready, otherwise wait for load
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', injectIntelBadges);
        } else {
            injectIntelBadges();
        }
    } else {
        console.log("[Hub Debug] Path did not match alliance profile criteria. Injections skipped.");
    }
})();

export function initScienceTimers() {
    if (!window.location.pathname.toLowerCase().includes('/game/science')) return;

    const queueClasses = ['bi-1-circle', 'bi-2-circle', 'bi-3-circle', 'bi-repeat'];
    const queuedItems = [];

    // 1. Find and sort queued sciences by their exact execution order
    queueClasses.forEach(cls => {
        const icon = document.querySelector(`.${cls}`);
        if (icon) {
            const row = icon.closest('tr');
            if (row && row.cells[4] && row.cells[5]) {
                const iconsInRow = Array.from(row.cells[5].querySelectorAll('i'));
                const index = iconsInRow.indexOf(icon);
                const timersInRow = Array.from(row.cells[4].querySelectorAll('.timer'));
                const timerEl = timersInRow[index];
                
                if (timerEl) {
                    const seconds = parseInt(timerEl.getAttribute('data-value'), 10) || 0;
                    queuedItems.push({
                        className: cls,
                        timerEl: timerEl,
                        seconds: seconds
                    });
                }
            }
        }
    });

    // 2. Compute cumulative times and inject timestamps right next to the native timers
    let cumulativeSeconds = 0;

    queuedItems.forEach(item => {
        cumulativeSeconds += item.seconds;

        const finishDate = new Date(Date.now() + cumulativeSeconds * 1000);
        const dateStr = finishDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + 
                        finishDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

        // Idempotency: Check if the badge is already there so we don't stack duplicates
        let dateSpan = item.timerEl.nextElementSibling;
        if (!dateSpan || !dateSpan.classList.contains('custom-science-date')) {
            dateSpan = document.createElement('span');
            dateSpan.className = 'custom-science-date ms-2';
            dateSpan.style.cssText = 'color: #888; font-size: 11px; font-weight: normal;';
            item.timerEl.parentNode.insertBefore(dateSpan, item.timerEl.nextSibling);
        }
        
        dateSpan.innerText = `(${dateStr})`;
    });
}

// ---------------------------------------------------------------
// AUTO PRODUCE FINISH DATES — /Game/Planets/Planet/{id}
// Same idea as initScienceTimers above: the "Auto Produce" table's own "Remain" timer
// gives only the DURATION of each queued item (not already including the wait for
// earlier items in the same queue — confirmed the same way science's queue works), so a
// second/third queued item's real finish time is the cumulative sum of every timer above
// it plus its own, not just its own value read in isolation.
// ---------------------------------------------------------------
export function initAutoProduceFinishDates() {
    if (!window.location.pathname.toLowerCase().includes('/game/planets/planet/')) return;

    const rows = document.querySelectorAll('tr[data-auto-produce]');
    let cumulativeSeconds = 0;

    rows.forEach(row => {
        const timerEl = row.querySelector('.timer[data-value]');
        if (!timerEl) return;

        const seconds = parseInt(timerEl.getAttribute('data-value'), 10) || 0;
        cumulativeSeconds += seconds;

        const finishDate = new Date(Date.now() + cumulativeSeconds * 1000);
        const dateStr = finishDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                        finishDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

        // Idempotency: reuse the badge already there instead of stacking duplicates.
        let dateSpan = timerEl.nextElementSibling;
        if (!dateSpan || !dateSpan.classList.contains('custom-autoproduce-date')) {
            dateSpan = document.createElement('span');
            dateSpan.className = 'custom-autoproduce-date ms-2';
            dateSpan.style.cssText = 'color: #888; font-size: 11px; font-weight: normal;';
            timerEl.parentNode.insertBefore(dateSpan, timerEl.nextSibling);
        }

        dateSpan.innerText = `(${dateStr})`;
    });
}

// ---------------------------------------------------------------
// FLEET ARRIVAL COUNTDOWN — /Game/Fleets
// The "Estimated Arrival" cell shows an absolute local time like "04:28:17 - Jul 16".
// Append the time REMAINING from now, e.g. " | 26m", " | 4h 28m", " | 2d 1h 30m".
// Pure client-side, viewer-local (the game already renders the arrival in local time).
// ---------------------------------------------------------------
const _FLEET_MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
// "04:28:17 - Jul 16" -> a local Date (this year, or next year if it'd otherwise be well past).
function parseFleetArrival(text) {
    const m = (text || '').match(/(\d{1,2}):(\d{2}):(\d{2})\s*-\s*([A-Za-z]{3})\s+(\d{1,2})/);
    if (!m) return null;
    const mo = _FLEET_MONTHS[m[4].toLowerCase()];
    if (mo == null) return null;
    const now = new Date();
    let d = new Date(now.getFullYear(), mo, +m[5], +m[1], +m[2], +m[3]);
    if (d.getTime() - now.getTime() < -2 * 86400 * 1000) d = new Date(now.getFullYear() + 1, mo, +m[5], +m[1], +m[2], +m[3]);
    return d;
}
function fmtFleetRemaining(ms) {
    if (ms <= 0) return 'arrived';
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const mn = Math.floor(s / 60);
    if (d > 0) return `${d}d ${h}h ${mn}m`;
    if (h > 0) return `${h}h ${mn}m`;
    return `${mn}m`;
}
export function initFleetTimers() {
    if (!window.location.pathname.toLowerCase().includes('/game/fleets')) return;
    document.querySelectorAll('td').forEach(td => {
        // Cache the parsed target on the cell so repeat passes only recompute the text.
        let ms = td.getAttribute('data-aw-eta-ms');
        if (ms == null) {
            const d = parseFleetArrival(td.textContent);
            if (!d) return;
            ms = String(d.getTime());
            td.setAttribute('data-aw-eta-ms', ms);
        }
        let span = td.querySelector('.aw-fleet-eta');
        if (!span) {
            span = document.createElement('span');
            span.className = 'aw-fleet-eta';
            span.style.whiteSpace = 'nowrap';
            span.innerHTML = ' <span style="color:#fff">|</span> <span class="aw-fleet-eta-t" style="color:#ced4da"></span>';
            td.appendChild(span);
        }
        span.querySelector('.aw-fleet-eta-t').textContent = fmtFleetRemaining(Number(ms) - Date.now());
    });
}

(function autoScrapeRankings() {
    if (!window.location.pathname.toLowerCase().includes('/ranking/bestguarded')) return;

    console.log('[Hub Tracker] Best Guarded ranking channel recognized. Evaluating metrics...');
    const lastUpdateSpan = document.querySelector('span[data-utc]');
    const tickTimestamp = lastUpdateSpan ? lastUpdateSpan.getAttribute('data-utc') : null;

    if (!tickTimestamp) {
        console.warn('[Hub Tracker] Missing core timestamp metric data element attributes.');
        return;
    }

    const rows = document.querySelectorAll('table.table tbody tr');
    const processedEntries = [];

    rows.forEach(row => {
        const targetLink = row.querySelector('a[href^="/Game/Map/Planet/"]');
        if (!targetLink) return;

        const planetId = parseInt(targetLink.getAttribute('href').split('/').pop(), 10);
        const tds = row.querySelectorAll('td');

        if (tds.length >= 5 && !isNaN(planetId)) {
            // Normalize spaces and convert raw space breaks cleanly
            const parsedCvValue = tds[4].innerText.replace(/\u00a0/g, ' ').trim();
            processedEntries.push({ planet_id: planetId, cv: parsedCvValue });
        }
    });

    if (processedEntries.length > 0) {
        fetch('/hub-api/sync/best-guarded', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ last_update: tickTimestamp, entries: processedEntries })
        })
        .then(res => res.json())
        .then(data => {
            if (data.skipped) {
                console.log('[Hub Tracker] Sync execution skipped: Data already updated for this current day block.');
            } else {
                console.log('[Hub Tracker] Daily guarded tracking updates successfully recorded.');
            }
        })
        .catch(err => console.error('[Hub Tracker] Ranking update injection error trace:', err));
    }
})();
