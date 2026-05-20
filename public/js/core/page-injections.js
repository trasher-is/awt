export function initPlanetPopTimers() {
    if (!window.location.pathname.includes('/Game/Planets')) return;

    document.querySelectorAll('tr[data-planet-id]').forEach(row => {
        const barContainer = row.querySelector('.progress-bar-timed');
        if (!barContainer) return;

        // Extract "Duration: HH:MM:SS" from the title attribute
        const title = barContainer.getAttribute('title') || "";
        const durMatch = title.match(/Duration:\s*([\d:]+)/);
        if (!durMatch) return;

        const prog = barContainer.querySelector('.progress');
        
        // Create the timer element
        const timerDiv = document.createElement('div');
        timerDiv.className = 'text-[9px] text-white font-mono font-bold absolute top-0 left-1 whitespace-nowrap';
        timerDiv.innerText = durMatch[1]; // Just the time string
        
        // Ensure progress div is relative so absolute timer stays inside
        prog.style.position = 'relative';
        prog.appendChild(timerDiv);
    });
}

// --- SCIENCE PAGE: Fixed ReferenceError ---
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
                const points = getPointsForLevel(targetLvl);
                if (points > 0) {
                    cumulativeSeconds += (points / production) * 3600;
                    
                    // Create target date object
                    const finishDate = new Date(Date.now() + cumulativeSeconds * 1000);
                    
                    // Format for display: May 24 11:52
                    const dateStr = finishDate.toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' ' + 
                                    finishDate.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', hour12: false});

                    nextLevels.push({
                        lvl: targetLvl,
                        duration: formatDuration(cumulativeSeconds),
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
    
    // Logic: if > 24h, show 'Xd Yh'. Else 'HH:MM'
    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}