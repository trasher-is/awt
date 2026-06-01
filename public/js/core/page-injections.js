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