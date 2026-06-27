import { parseArrivalToISO } from '../utils/fleet-time.js';

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

    // 3. Rip the entire Member roster cleanly from the roster tracking buttons
    // Since rows contain 2 members horizontally, we target the distinct member buttons directly.
    document.querySelectorAll('a[href*="/Game/Alliance/Member/"]').forEach(btn => {
        const mId = parseInt(btn.getAttribute('href').split('/').pop(), 10);
        
        // Find the matching profile link on the page using the ID to steal the name string
        const playerProfileLink = document.querySelector(`a[href^="/Game/Players/Profile/${mId}"]`);
        if (playerProfileLink) {
            const mName = playerProfileLink.innerText.trim();
            
            // Prevent duplicate mutations
            if (!p.members.find(m => m.id === mId)) {
                p.members.push({ id: mId, name: mName });
            }
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
            
            // Toast notification removed from here
            
            const header = document.querySelector('h5 span');
            if (header && !header.querySelector('.aw-synced')) {
                header.innerHTML += ' <span class="badge bg-success ms-2 aw-synced" style="font-size: 0.6em; vertical-align: middle; background-color: #22c55e !important; color: #fff;"><i class="bi bi-cloud-check"></i> Alliance Synced</span>';
            }
        }
    } catch (err) {
        console.error(`[Spy] Alliance API request failed`, err);
    }
}

// Extract every fleet from a member's alliance planet table. Two row shapes carry ships:
//   • Stationed (14 cells): SID,Name,Pop | Frm,Fac,Cyb,Lab,SB | TR,CS,DS,CR,BS,CV
//   • In-flight (11 cells): the 4 building cols are replaced by one colspan=4 cell holding
//     the landing time ("00:59:46 - birž. 28"); the fleet lands at this planet then.
// In BOTH shapes the ship columns are the LAST SIX cells [TR,CS,DS,CR,BS,CV], so we read
// from the end and don't care about the building-column layout.
//
// Siege rows (class *-siege, e.g. "friendly-siege"/"enemy-siege") are OTHER players'
// fleets parked on the planet — never the member's own — so we skip them.
function extractMemberFleets(doc, playerId) {
    const fleets = [];
    doc.querySelectorAll('tr[data-planet-id]').forEach(row => {
        if (/siege/i.test(row.className)) return;

        const cells = row.querySelectorAll('td');
        if (cells.length < 11) return;

        const sysLink = row.querySelector('a[href*="/Game/Map/SolarSystem/"]');
        if (!sysLink) return;
        const m = sysLink.getAttribute('href').match(/\/SolarSystem\/(\d+)\/(\d+)/);
        if (!m) return;

        const n = (cell) => parseInt((cell.innerText || '').replace(/[,.\s ]/g, ''), 10) || 0;
        const last = cells.length;
        const transports  = n(cells[last - 6]);
        const colony_ships = n(cells[last - 5]);
        const destroyers  = n(cells[last - 4]);
        const cruisers    = n(cells[last - 3]);
        const battleships = n(cells[last - 2]);

        if (transports + colony_ships + destroyers + cruisers + battleships === 0) return;

        // In-flight rows carry a landing time in a colspan'd cell -> set arrival_at so the
        // server treats it as "lands later, then can relaunch".
        let arrival_at = null;
        const timerCell = Array.from(cells).find(c => c.getAttribute('colspan') === '4');
        if (timerCell) arrival_at = parseArrivalToISO(timerCell.innerText.trim());

        fleets.push({
            system_id: parseInt(m[1], 10),
            planet_index: parseInt(m[2], 10),
            transports, colony_ships, destroyers, cruisers, battleships,
            arrival_at
        });
    });
    return fleets;
}

// Fetch + parse one member's alliance page and sync stats + stationed fleets.
async function syncMember(url) {
    const idMatch = url.match(/\/Member\/(\d+)/);
    if (!idMatch) return;
    const playerId = parseInt(idMatch[1], 10);

    const res = await fetch(url);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tds = Array.from(doc.querySelectorAll('td'));

    // Parse Username
    const profileLink = doc.querySelector('a[href*="/Game/Players/Profile/"]');
    if (!profileLink) return;
    const name = profileLink.innerText.trim();
    {

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
                population: getIntelVal('Population'),
                fleets: extractMemberFleets(doc, playerId)
            };

            await fetch('/hub-api/sync/alliance-stats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
    }
}

// Collect the member links from a document (alliance overview page).
function memberLinksFrom(doc) {
    const seen = new Set();
    const urls = [];
    doc.querySelectorAll('a[href*="/Game/Alliance/Member/"]').forEach(a => {
        const href = a.getAttribute('href');
        const m = href.match(/\/Member\/(\d+)/);
        if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            urls.push(new URL(href, window.location.origin).href);
        }
    });
    return urls;
}

// On-page scan: runs while sitting on the alliance overview.
export async function scrapeAllianceMembers() {
    if (!window.location.pathname.toLowerCase().includes('/game/alliance')) return;

    // Stop parser if navigating tabs (list, naps, specific detail screens)
    if (window.location.pathname.toLowerCase().includes('/member/') ||
        window.location.pathname.toLowerCase().includes('/list') ||
        window.location.pathname.toLowerCase().includes('/naps')) return;

    const urls = memberLinksFrom(document);
    if (urls.length === 0) return;

    console.log(`[AWT Scraper] Found ${urls.length} alliance members. Syncing stats + fleets in background...`);
    for (const url of urls) {
        try { await syncMember(url); }
        catch (err) { console.error('[AWT Scraper] Member sync failed:', err); }
    }
}

// Off-page scan (e.g. triggered from the News page): fetch the alliance overview to get
// the member roster, then sync each member's stats + stationed fleets. Returns a count.
export async function runAllianceFleetScan() {
    const ovRes = await fetch('/Game/Alliance');
    const ovDoc = new DOMParser().parseFromString(await ovRes.text(), 'text/html');
    const urls = memberLinksFrom(ovDoc);
    if (urls.length === 0) return 0;

    console.log(`[AWT Scraper] Refreshing ${urls.length} alliance members' fleets...`);
    let ok = 0;
    for (const url of urls) {
        try { await syncMember(url); ok++; }
        catch (err) { console.error('[AWT Scraper] Member sync failed:', err); }
    }
    return ok;
}