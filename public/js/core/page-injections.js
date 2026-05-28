export function initPlanetPopTimers() {
    if (!window.location.pathname.includes('/Game/Planets')) return;

    // Inject responsive style rules once if not already present
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

    // Direct selection ensures this runs on both the overview table and individual planet views
    document.querySelectorAll('.progress-bar-timed').forEach(barContainer => {
        // Match numbers, letters, spaces, colons, and dots
        const title = barContainer.getAttribute('title') || "";
        const durMatch = title.match(/Duration:\s*([a-zA-Z0-9\.\s:]+)/);
        if (!durMatch) return;

        // Prevent duplicate injections
        if (barContainer.querySelector('.custom-pop-timer')) return;

        let durationText = durMatch[1].trim();
        
        // Convert "X.XX:XX:XX" format to "Xd XX:XX:XX"
        durationText = durationText.replace(/^(\d+)\./, '$1d ');

        const timerDiv = document.createElement('div');
        timerDiv.className = 'custom-pop-timer';
        timerDiv.innerText = durationText; 
        
        // Use standard vanilla CSS layout properties so it works on the game's page
        timerDiv.style.position = 'absolute';
        timerDiv.style.top = '50%';
        timerDiv.style.transform = 'translateY(-50%)';
        timerDiv.style.left = '6px';
        timerDiv.style.zIndex = '10';
        timerDiv.style.color = '#ffffff';
        timerDiv.style.fontFamily = 'monospace';
        timerDiv.style.fontSize = '9pt'; // Base desktop size (~12px)
        timerDiv.style.fontWeight = 'bold';
        timerDiv.style.whiteSpace = 'nowrap';
        timerDiv.style.pointerEvents = 'none'; // Prevents the text from blocking mouse hovers on the bar
        
        barContainer.style.position = 'relative';
        barContainer.appendChild(timerDiv);

        // Hide progress text (e.g. "125/813") on mobile, show on medium screens and up
        const progressText = barContainer.querySelector('.progress-text');
        if (progressText) {
            progressText.classList.add('d-none', 'd-md-block');
        }
    });
}

export async function initScienceCultureCalc() {
    if (!window.location.pathname.includes('/Game/Science')) return;

    const headers = document.querySelectorAll('th');
    let production = 0;
    headers.forEach(th => {
        if (th.innerText.includes('Culture')) {
            const match = th.innerText.match(/\+([\d,]+)\/h/);
            if (match) production = parseFloat(match[1].replace(',', '.'));
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
                const lvl = parseInt(lvlCell.innerText.trim());
                if (!isNaN(lvl)) {
                    currentLevel = lvl;
                    targetRow = row;
                }
            }
        }
    });

    if (targetRow && production > 0) {
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
                    if (cells.length >= 2 && parseInt(cells[0].innerText) === lvl) {
                        return parseInt(cells[1].innerText.replace(/\s/g, '').replace('.', '')) || 0;
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
                container.style.marginTop = "4px";
                container.style.fontSize = "10px";
                container.style.color = "#aaa";
                
                nextLevels.forEach(item => {
                    const line = document.createElement('div');
                    line.innerHTML = `<span style="color:#fff; font-weight:bold">Lvl ${item.lvl}:</span> ${item.duration} <span style="color:#888;">(${item.date})</span>`;
                    container.appendChild(line);
                });

                targetRow.cells[2].appendChild(container);
            }
        } catch (e) { console.error("Calc Error", e); }
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
    if (!window.location.pathname.startsWith('/Game/News')) return;

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
                    <td class="msg player-incoming unread" style="vertical-align: top; white-space: nowrap; background-color: rgba(77, 41, 7, 0.85);!important;">
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

// --- PLANET VIEW: STARBASE AUTOGROWTH TIMER ---
export function initStarbaseTimer() {
    // Check if we are on an individual planet page
    if (!window.location.pathname.toLowerCase().includes('/game/planets/planet/')) return;

    // Locate the Starbase row
    const starbaseRow = document.querySelector('tr[data-spend-to="Starbase"]');
    if (!starbaseRow) return;

    // Locate the progress bar container inside the row
    const barContainer = starbaseRow.querySelector('.progress-bar');
    if (!barContainer) return;

    // Prevent duplicate styling/injections if run multiple times
    if (barContainer.querySelector('.custom-starbase-timer')) return;

    // Extract values safely from the DOM cells
    const lvlCell = starbaseRow.querySelector('.building-lvl-up') || starbaseRow.cells[1];
    const remainCell = starbaseRow.cells[3];
    if (!lvlCell || !remainCell) return;

    const level = parseInt(lvlCell.innerText.trim(), 10);
    const remain = parseInt(remainCell.innerText.trim(), 10);

    // If level is invalid or remaining points is 0, calculation isn't needed
    if (isNaN(level) || isNaN(remain) || level <= 0 || remain <= 0) return;

    // Formula: growth = level / 5 points per hour
    const growthPerHour = level / 5;
    const hoursNeeded = remain / growthPerHour;

    // Convert to distinct days, hours, and minutes strings
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

    // Build the visual div overlay with identical styling to population bar
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