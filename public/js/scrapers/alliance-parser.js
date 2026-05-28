export async function scrapeAlliance() {
    console.log(`[Spy] Initiating scrape for Alliance profile...`);

    const p = {
        id: null,
        name: null,
        tag: null,
        leader_id: null,
        ranking: null,
        points: null,
        members: []
    };

    // 1. Extract the true Alliance ID from the Ranking link
    const rankLink = document.querySelector('a[href*="/Ranking/Alliance?allianceId="]');
    if (rankLink) {
        const match = rankLink.getAttribute('href').match(/allianceId=(\d+)/i);
        if (match) p.id = parseInt(match[1], 10);
    }

    if (!p.id) {
        console.warn("[Spy] Could not extract Alliance ID. Aborting scrape.");
        return;
    }

    // 2. Parse the Alliance Profile Table
    document.querySelectorAll('table tbody tr').forEach(row => {
        const tds = row.querySelectorAll('td');
        if (tds.length >= 2) {
            const label = tds[0].innerText.trim();
            const val = tds[1].innerText.trim();

            if (label === 'Name') p.name = val;
            if (label === 'Tag') p.tag = val;
            if (label.includes('Points')) p.points = parseInt(val.split('(')[0].replace(/,/g, ''), 10) || 0;
            if (label === 'Ranking') p.ranking = parseInt(val, 10) || null;
            if (label === 'Leader') {
                const a = tds[1].querySelector('a');
                if (a) p.leader_id = parseInt(a.getAttribute('href').split('/').pop(), 10);
            }
        }
    });

    // 3. Rip the entire Member roster
    // By searching for all player links inside tables, we grab both the leader and the members roster in one sweep.
    document.querySelectorAll('table tbody a[href^="/Game/Players/Profile/"]').forEach(link => {
        const mId = parseInt(link.getAttribute('href').split('/').pop(), 10);
        const mName = link.innerText.trim();
        
        // Ensure we don't add duplicates
        if (!p.members.find(m => m.id === mId)) {
            p.members.push({ id: mId, name: mName });
        }
    });

    // 4. Beam to backend
    try {
        const response = await fetch('/hub-api/sync/alliance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p)
        });
        if (response.ok) {
            console.log(`[Spy] Alliance '${p.tag}' synced! (${p.members.length} members mapped)`);
            
            window.parent.postMessage({ type: 'SHOW_TOAST', payload: `Alliance [${p.tag}] Synced` }, window.location.origin);
            
            const header = document.querySelector('h5 span');
            if (header && !header.querySelector('.aw-synced')) {
                header.innerHTML += ' <span class="badge bg-success ms-2 aw-synced" style="font-size: 0.6em; vertical-align: middle; background-color: #22c55e !important; color: #fff;"><i class="bi bi-cloud-check"></i> Alliance Synced</span>';
            }
        }
    } catch (err) {
        console.error(`[Spy] Alliance API request failed`, err);
    }
}

export async function scrapeAllianceMembers() {
    if (!window.location.pathname.toLowerCase().includes('/game/alliance')) return;
    
    // Stop parser if navigating tabs (list, naps, specific detail screens)
    if (window.location.pathname.toLowerCase().includes('/member/') || 
        window.location.pathname.toLowerCase().includes('/list') || 
        window.location.pathname.toLowerCase().includes('/naps')) return;

    const eyeButtons = Array.from(document.querySelectorAll('a[href*="/Game/Alliance/Member/"]'));
    if (eyeButtons.length === 0) return;

    console.log(`[AWT Scraper] Found ${eyeButtons.length} alliance members. Syncing detailed stats in background...`);
    window.parent.postMessage({ type: 'SHOW_TOAST', payload: 'Syncing Alliance Stats...' }, window.location.origin);

    for (const btn of eyeButtons) {
        try {
            const url = btn.href;
            const idMatch = url.match(/\/Member\/(\d+)/);
            if (!idMatch) continue;
            const playerId = parseInt(idMatch[1], 10);

            const res = await fetch(url);
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const tds = Array.from(doc.querySelectorAll('td'));

            // Parse Username
            const profileLink = doc.querySelector('a[href*="/Game/Players/Profile/"]');
            if (!profileLink) continue;
            const name = profileLink.innerText.trim();

            // Planets & Next Culture
            const planetTd = tds.find(td => td.innerHTML.includes('Planets<br>(Next Culture)'));
            let planetsText = '';
            let nextCultureSeconds = null;
            if (planetTd && planetTd.nextElementSibling) {
                const valTd = planetTd.nextElementSibling;
                planetsText = valTd.innerText.split('(')[0].trim();
                const timerSpan = valTd.querySelector('#nextCulture');
                if (timerSpan) {
                    nextCultureSeconds = parseInt(timerSpan.getAttribute('data-value'), 10);
                }
            }

            const getRate = (label) => {
                const td = tds.find(t => t.innerText.trim() === label);
                return (td && td.nextElementSibling) ? td.nextElementSibling.innerText.trim().split(' ')[0] : '';
            };

            const getSimpleVal = (label) => {
                const td = tds.find(t => t.innerText.trim() === label);
                return (td && td.nextElementSibling) ? td.nextElementSibling.innerText.trim() : '';
            };

            const getIntelVal = (label) => {
                const td = tds.find(t => t.innerText.trim() === label);
                if (td && td.nextElementSibling) {
                    const parsed = parseInt(td.nextElementSibling.innerText.trim(), 10);
                    return isNaN(parsed) ? 0 : parsed;
                }
                return 0;
            };

            const pLevelTd = tds.find(t => t.innerText.includes('Player Level') && t.querySelector('a[data-href*="PlayerLevelTable"]'));
            const cvLimitTd = tds.find(t => t.innerText.includes('CV Limit'));

            const payload = {
                player_id: playerId,
                name,
                planets_text: planetsText,
                next_culture_seconds: nextCultureSeconds,
                science_rate: getRate('Science'),
                culture_rate: getRate('Culture'),
                production_rate: getRate('Production'),
                astro_dollars: getSimpleVal('Astro Dollars'),
                production_points: getSimpleVal('Production Points'),
                artefact: getSimpleVal('Artefact'),
                level_text: pLevelTd && pLevelTd.nextElementSibling ? pLevelTd.nextElementSibling.innerText.trim().replace(/\s+/g, ' ') : '',
                cv_limit_text: cvLimitTd && cvLimitTd.nextElementSibling ? cvLimitTd.nextElementSibling.innerText.trim().replace(/\s+/g, ' ') : '',
                economy: getIntelVal('Economy'),
                energy: getIntelVal('Energy'),
                mathematics: getIntelVal('Mathematics'),
                physics: getIntelVal('Physics'),
                population: getIntelVal('Population')
            };

            await fetch('/hub-api/sync/alliance-stats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

        } catch (err) {
            console.error(`[AWT Scraper] Error collecting data for member link:`, err);
        }
    }
    window.parent.postMessage({ type: 'SHOW_TOAST', payload: 'Alliance Stats Updated!' }, window.location.origin);
}