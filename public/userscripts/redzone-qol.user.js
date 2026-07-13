// ==UserScript==
// @name         Astro Wars Redzone — QoL Timers & Calculators
// @namespace    https://37.27.17.97.nip.io/userscripts/
// @version      1.6.0
// @description  Population timer, science/culture research-queue timers, culture level calculator, and an interactive science level calculator for redzone.astrowars.games. Pure client-side — no login, no backend, reads only the current page's own DOM plus the game's own /Info/* tables.
// @match        *://redzone.astrowars.games/*
// @updateURL    https://37.27.17.97.nip.io/userscripts/redzone-qol.user.js
// @downloadURL  https://37.27.17.97.nip.io/userscripts/redzone-qol.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Ported from awt's public/js/core/page-injections.js (the alliance-intel tool this
// author also runs against the regular astrowars.games server). Everything below is
// self-contained: no awt backend calls, no login — only DOM reads on the current page
// and fetch() calls to THIS SAME game server's own /Info/* tables. If redzone's page
// structure ever diverges from astrowars.games, the CSS selectors here are the first
// thing to re-check.
(function () {
    'use strict';

    // -----------------------------------------------------------------
    // POPULATION TIMER — /Game/Planets
    // Reads the "Duration: ..." tooltip already present on each growth bar and prints
    // it directly on the bar (no calculation, just surfacing text the game already sends).
    // -----------------------------------------------------------------
    function initPlanetPopTimers() {
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

    // -----------------------------------------------------------------
    // Shared helpers for the science/culture calculators
    // -----------------------------------------------------------------
    function formatDuration(totalSeconds) {
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);

        if (days > 0) {
            return `${days}d ${hours}h`;
        }
        return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    }

    // Locale-agnostic number parse. The game renders numbers in either "1,039.5" (comma
    // thousands, dot decimal) or "1.039,5" / "49,5" (dot thousands, comma decimal)
    // depending on locale — so which separator is the decimal can't be hard-coded. Rule:
    // when both separators appear, the LAST one is the decimal; when only one appears once,
    // it's the decimal unless it sits in thousands position (followed by exactly 3 digits).
    // The old version assumed comma=decimal, which turned a rate like "1,039.5/h" into
    // 1.0395 — ~1000x too slow, giving absurd ETAs (186d instead of ~5h) once a rate
    // crossed 1,000 and gained a thousands separator.
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

    // Cumulative incremental points required to advance INTO each level. Fetches the
    // game's OWN /Info/CultureTable or /Info/ScienceTable page (same origin as wherever
    // this script is running) — not any awt endpoint.
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
    function readScienceState(sci) {
        let row = null, level = NaN;
        document.querySelectorAll('table tr').forEach(r => {
            if (row || !r.cells || r.cells.length < 2 || !r.cells[0]) return;
            const c0 = r.cells[0].innerText.trim().toLowerCase();
            if (!sci.aliases.includes(c0)) return;
            const lvl = parseInt(r.cells[1].innerText, 10);
            if (!isNaN(lvl)) { row = r; level = lvl; }
        });
        if (!row) return null;

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

    // -----------------------------------------------------------------
    // CULTURE LEVEL CALCULATOR — /Game/Science
    // Projects the next 3 culture level-ups from the current rate + the game's own
    // culture cost table.
    // -----------------------------------------------------------------
    async function initScienceCultureCalc() {
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
                        const dateStr = finishDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                                        finishDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

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
                    container.style.fontSize = "11px";
                    container.style.color = "#aaa";

                    nextLevels.forEach(item => {
                        const line = document.createElement('div');
                        line.innerHTML = `<span style="color:#aaa; font-weight:normal;">Lvl ${item.lvl}:</span> <span style="color:#fff; font-weight:bold;">${item.duration}</span> <span style="color:#888;">(${item.date})</span>`;
                        container.appendChild(line);
                    });

                    if (targetRow.cells[2]) {
                        targetRow.cells[2].appendChild(container);
                    }
                }
            } catch (e) {
                console.error("[Redzone QoL] Culture calc error", e);
                targetRow.removeAttribute('data-calc-injected');
            }
        }
    }

    // -----------------------------------------------------------------
    // SCIENCE LEVEL CALCULATOR (interactive) — /Game/Science
    // "Pick a science, enter a target level -> total time + finish date."
    // -----------------------------------------------------------------
    async function initScienceLevelCalculator() {
        if (!window.location.pathname.toLowerCase().includes('/game/science')) return;
        if (document.getElementById('hub-science-calc')) return;

        const box = document.createElement('div');
        box.id = 'hub-science-calc';
        box.style.cssText = 'box-sizing:border-box;margin:8px 0 0 0;padding:10px 12px;border:1px solid #444;border-radius:6px;background:#1a1a1a;color:#ddd;font-size:13px;width:100%;max-width:520px;';

        const available = SCIENCES
            .map(sci => ({ name: sci.name, sci, state: readScienceState(sci) }))
            .filter(s => s.state);

        if (available.length === 0) {
            // Diagnostic readout, visible on-screen (incl. mobile) — if this shows up on
            // redzone, the science-page selectors below need retuning for that server.
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

    // -----------------------------------------------------------------
    // RESEARCH QUEUE TIMERS — /Game/Science
    // Prints a finish date next to each queued science, in queue order.
    // -----------------------------------------------------------------
    function initScienceTimers() {
        if (!window.location.pathname.toLowerCase().includes('/game/science')) return;

        const queueClasses = ['bi-1-circle', 'bi-2-circle', 'bi-3-circle', 'bi-repeat'];
        const queuedItems = [];

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
                        queuedItems.push({ className: cls, timerEl, seconds });
                    }
                }
            }
        });

        let cumulativeSeconds = 0;

        queuedItems.forEach(item => {
            cumulativeSeconds += item.seconds;

            const finishDate = new Date(Date.now() + cumulativeSeconds * 1000);
            const dateStr = finishDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
                            finishDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

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

    // -----------------------------------------------------------------
    // DISPATCH — this game does a full page reload on basically every action/navigation
    // (confirmed — not the SPA-with-in-place-DOM-patching behavior the original
    // astrowars.games appears to have), which means Tampermonkey's @run-at document-idle
    // already re-fires this entire script fresh on every single page load. No polling
    // loop or MutationObserver needed — that repeated re-checking was itself the cause of
    // the earlier hangs, especially on a fast-paced server where research/culture rows
    // update every few seconds. Run once, when the page settles, and stop.
    //
    // Still yield between each feature's DOM work rather than running all four in one
    // synchronous block — on a page that's mid-reload/still hydrating, one uninterrupted
    // block of scans can itself take long enough to trip the browser's slow-script
    // watchdog even as a single call.
    function yieldToMain() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    async function runAll() {
        try { initPlanetPopTimers(); } catch (e) { /* ignore, keep other features running */ }
        await yieldToMain();
        try { await initScienceCultureCalc(); } catch (e) { }
        await yieldToMain();
        try { await initScienceLevelCalculator(); } catch (e) { }
        await yieldToMain();
        try { initScienceTimers(); } catch (e) { }
    }

    runAll();
})();
