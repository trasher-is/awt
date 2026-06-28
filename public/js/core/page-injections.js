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
                let cleanStr = matchText[1].trim().replace(/\s/g, '');
                if ((/\d+[\.,]\d{1,2}$/).test(cleanStr)) {
                    cleanStr = cleanStr.replace(/[\.,]/g, m => m === cleanStr.charAt(cleanStr.length - 2) || m === cleanStr.charAt(cleanStr.length - 3) ? '.' : '');
                } else {
                    cleanStr = cleanStr.replace(/[\.,]/g, '');
                }
                production = parseFloat(cleanStr) || 0;
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
            const res = await fetch('/Info/CultureTable');
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

// "$2 865,73" / "1 234" / "49,5" -> number (comma is the decimal separator here)
function parseLocaleNumber(str) {
    if (!str) return 0;
    let t = String(str).replace(/[^\d.,]/g, '').trim();
    if (!t) return 0;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/\.(?=\d{3}\b)/g, '');   // dots as thousands separators
    const v = parseFloat(t);
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
    let rate = 0;
    document.querySelectorAll('th, td').forEach(el => {
        if (rate) return;
        const mm = (el.innerText || '').match(rateRe);
        if (mm) { rate = parseLocaleNumber(mm[1]); }
    });

    const timer = row.querySelector('.timer-active');
    const timerSecs = timer ? (parseInt(timer.getAttribute('data-value'), 10) || 0) : 0;

    return { level, rate, timerSecs, researching: !!timer };
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
                first cells: ${firstCells.length ? firstCells.join(' | ') : '(none)'}
            </div>`;
        const clk = document.querySelector('[data-clock]');
        ((clk && clk.closest('div')) || document.body || document.documentElement).appendChild(box);
        return;
    }

    box.innerHTML = `
        <div style="font-weight:bold;color:#fff;margin-bottom:8px;">🔬 Research Time Calculator</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <select id="hub-sci-select" style="background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 6px;">
                ${available.map(s => `<option value="${s.name}">${s.name} (lvl ${s.state.level})</option>`).join('')}
            </select>
            <span style="color:#888;">to level</span>
            <input id="hub-sci-target" type="number" min="1" style="width:70px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 6px;" placeholder="30">
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

        try {
            const url = name === 'Culture' ? '/Info/CultureTable' : '/Info/ScienceTable';
            const table = await getPointsTable(url);

            let total = 0;
            let startK = st.level + 1;
            if (st.researching) { total += st.timerSecs; startK = st.level + 2; }   // active timer finishes current+1

            const missing = [];
            for (let k = startK; k <= target; k++) {
                const pts = table[k];
                if (pts == null || isNaN(pts)) { missing.push(k); continue; }
                total += (pts / st.rate) * 3600;
            }

            const finish = new Date(Date.now() + total * 1000);
            const dateStr = finish.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                            finish.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
            let html = `<span style="color:#aaa;">Lvl ${st.level} → ${target}:</span> <span style="color:#fff;font-weight:bold;">${formatDuration(total)}</span> <span style="color:#888;">(${dateStr})</span>`;
            html += `<br><span style="color:#666;font-size:11px;">rate ${st.rate.toLocaleString()}/h${st.researching ? ' · current research counted' : ''}</span>`;
            if (missing.length) html += `<br><span style="color:#c96;font-size:11px;">No cost data for level(s): ${missing.join(', ')}</span>`;
            resultEl.innerHTML = html;
        } catch (e) {
            resultEl.innerHTML = '<span style="color:#e88;">Failed to load the level cost table.</span>';
        }
    };

    selEl.addEventListener('change', compute);
    targetEl.addEventListener('input', compute);
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
                        ${b.display_time}
                        <br>
                        <b>(<span>${b.author_name}</span>)</b>
                    </td>
                    <td class="black text-left" style="vertical-align: top; padding: 6px 12px; background-color: transparent !important;">
                        <div><b>${b.title}</b> ${b.message}</div>
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
    const res = await fetch('/Info/PlayerLevelTable');
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

        // Observed: +0.3% per update per SAD point (SAD = Speed+Attack+Defence).
        // Negative stats don't contribute — each is floored at 0 before summing
        // (so −4/−4/−4 counts as 0, not −12).
        const sad = Math.max(0, speed) + Math.max(0, attack) + Math.max(0, defence);
        const factor = Math.max(0, sad * 0.003);

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

let currentObservedTable = null;
let systemTableObserver = null;

export async function initPersistentPlanPills() {
    const systemTable = document.getElementById("solarSystem");
    if (!systemTable) return;

    // Strict Guard: If we are already attached to this exact table element instance, exit.
    if (currentObservedTable === systemTable) return;

    // Disconnect old targets to prevent cross-view instance stacking leaks
    if (systemTableObserver) {
        systemTableObserver.disconnect();
    }

    currentObservedTable = systemTable;

    const urlMatch = window.location.href.match(/(?:SolarSystem\/|solarSystemId=)(\d+)/i);
    const targetLink = document.querySelector('a[href*="solarSystemId="]');
    const fallbackMatch = targetLink ? targetLink.getAttribute('href').match(/solarSystemId=(\d+)/i) : null;
    
    const systemId = urlMatch ? urlMatch[1] : (fallbackMatch ? fallbackMatch[1] : null);
    if (!systemId) return;

    try {
        const res = await fetch(`/hub-api/plans/${systemId}`);
        const data = await res.json();
        if (!data.success || !data.plans) return;

        const applyPills = () => {
            const rows = systemTable.querySelectorAll("tbody > tr:not(.collapse)");
            rows.forEach(row => {
                const firstCell = row.querySelector("td:first-child");
                if (!firstCell) return;

                const planetIndex = parseInt(firstCell.innerText.trim(), 10);
                if (isNaN(planetIndex)) return;

                const planetPlans = data.plans.filter(p => p.planet_index === planetIndex);
                const existingPills = row.querySelectorAll(".awt-persistent-pill");

                // Idempotence Check: If the layout reflects the data state perfectly, skip execution 
                if (existingPills.length === planetPlans.length) return;

                // Clear out mismatched allocations cleanly
                existingPills.forEach(p => p.remove());

                // Build out fresh plan identifiers safely
                planetPlans.forEach(plan => {
                    const pillNode = document.createElement('span');
                    pillNode.className = "badge bg-white text-dark awt-persistent-pill ms-2";
                    pillNode.style.cssText = "background-color: #ffffff !important; color: #000000 !important; font-weight: bold; font-size: 0.75em; border: 1px solid #ccc; display: inline-block; vertical-align: middle;";
                    pillNode.innerText = "PLAN";
                    pillNode.setAttribute("data-bs-toggle", "tooltip");
                    pillNode.setAttribute("title", `${plan.author}: ${plan.note}`);

                    firstCell.appendChild(pillNode);

                    if (window.bootstrap && window.bootstrap.Tooltip) {
                        new window.bootstrap.Tooltip(pillNode);
                    }
                });
            });
        };

        // Render initial view layers
        applyPills();

        // Bind localized table content tracker to preserve layout values during live fleet adjustments
        const tbody = systemTable.querySelector("tbody");
        if (tbody) {
            systemTableObserver = new MutationObserver((mutations) => {
                let structuralChangeDetected = false;
                for (const mutation of mutations) {
                    if (mutation.type === "childList") {
                        const isSelfGenerated = Array.from(mutation.addedNodes).some(n => 
                            n.classList && n.classList.contains("awt-persistent-pill")
                        );
                        if (!isSelfGenerated) {
                            structuralChangeDetected = true;
                            break;
                        }
                    }
                }
                if (structuralChangeDetected) {
                    applyPills();
                }
            });
            systemTableObserver.observe(tbody, { childList: true, subtree: true });
        }

    } catch (err) {
        console.error("[AWT Tools] Pill generation processing fault:", err);
    }
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
