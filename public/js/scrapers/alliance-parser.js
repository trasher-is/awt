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