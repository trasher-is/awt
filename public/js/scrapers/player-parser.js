// Pure data collection logic that can target any window, iframe, or virtual DOM element
export function extractPlayerData(playerId, doc = document) {
    const p = {
        id: parseInt(playerId, 10), name: null, alliance_id: null, alliance_tag: null,
        country: null, local_time: null, idle_time: null, origin_system: null,
        joined: null, logins: 0,
        level: 0, ranking: null, points: 0, science_level: 0, culture_level: 0,
        biology: 0, economy: 0, energy: 0, mathematics: 0, physics: 0, social: 0,
        trade_revenue: 0, artefact: null, eco_bonus: 0,
        race_growth: 0, race_science: 0, race_culture: 0, race_production: 0, race_speed: 0, race_attack: 0, race_defense: 0,
        race_trader: 0, race_sul: 0,
        has_intel: 0, // <--- Initialize default tracking byte
        
        // New tracking fields for tactical home planet visualization
        home_planet_id: null,
        home_system_id: null,
        home_planet_index: null,
        possible_homes: [] 
    };

    // Verify presence of specialized alliance intelligence blocks
    const hasIrTable = !!doc.querySelector('table.ir-summary');
    p.has_intel = hasIrTable ? 1 : 0;

    const nameHeader = doc.querySelector('th[colspan="2"]');
    if (nameHeader) {
        const nameLink = nameHeader.querySelector('a[href^="/Game/Players/Profile/"]');
        p.name = nameLink ? nameLink.innerText.trim() : nameHeader.innerText.replace(/Hub Synced/i, '').trim();
    }

    const allyLink = doc.querySelector('th[colspan="2"] a[href^="/Game/Alliance/Profile/"]');
    if (allyLink) {
        p.alliance_tag = allyLink.innerText.trim();
        p.alliance_id = parseInt(allyLink.getAttribute('href').split('/').pop(), 10);
    }

    const getRowVal = (labelMatch, exact = false) => {
        const rows = doc.querySelectorAll('table tbody tr');
        for (let row of rows) {
            const cells = row.querySelectorAll('th, td');
            if (cells.length >= 2) {
                const labelText = cells[0].innerText.trim();
                if (exact ? labelText === labelMatch : labelText.includes(labelMatch)) {
                    const valText = cells[1].innerText.trim();
                    if (labelMatch === 'Economy' && exact && valText.includes('%')) {
                        continue;
                    }
                    return valText;
                }
            }
        }
        return null;
    };

    p.local_time = getRowVal('Local Time');
    p.idle_time = getRowVal('Idle');
    p.joined = getRowVal('Joined'); 
    p.logins = parseInt(getRowVal('Logins'), 10) || 0; 
    
    const countryImg = doc.querySelector('img[src^="/img/country/"]');
    if (countryImg) {
        p.country = countryImg.getAttribute('alt') || countryImg.getAttribute('title');
    }

    const originRow = Array.from(doc.querySelectorAll('table tbody tr')).find(row => {
        const cells = row.querySelectorAll('th, td');
        return cells.length > 0 && cells[0].innerText.trim() === 'Origin';
    });

    if (originRow) {
        const originLink = originRow.querySelector('a[href^="/Game/Map/SolarSystem/"]');
        p.origin_system = originLink ? parseInt(originLink.getAttribute('href').split('/').pop(), 10) : null;
    }

    const lvlStr = getRowVal('Player Level');
    if (lvlStr) p.level = parseInt(lvlStr.split('-')[0].trim(), 10) || 0;

    p.science_level = parseInt(getRowVal('Science Level'), 10) || 0;
    p.culture_level = parseInt(getRowVal('Culture Level'), 10) || 0;

    const rankStr = getRowVal('Ranking');
    if (rankStr) {
        const rMatch = rankStr.match(/#(\d+)\s*\(([\d,\.\s]+)\)/);
        if (rMatch) {
            p.ranking = parseInt(rMatch[1].replace(/[^\d]/g, ''), 10);
            p.points = parseInt(rMatch[2].replace(/[^\d]/g, ''), 10);
        }
    }

    // Only scrape these values if the Intelligence Report is visible
    if (p.has_intel === 1) {
        p.biology = parseInt(getRowVal('Biology', true), 10) || 0;
        p.economy = parseInt(getRowVal('Economy', true), 10) || 0;
        p.energy = parseInt(getRowVal('Energy', true), 10) || 0;
        p.mathematics = parseInt(getRowVal('Mathematics', true), 10) || 0;
        p.physics = parseInt(getRowVal('Physics', true), 10) || 0;
        p.social = parseInt(getRowVal('Social', true), 10) || 0;

        const ecoBonusStr = getRowVal('Economy Bonus');
        if (ecoBonusStr) p.eco_bonus = parseInt(ecoBonusStr.replace(/[^\d+-]/g, ''), 10) || 0;

        const tradeStr = getRowVal('Trade Revenue');
        if (tradeStr) p.trade_revenue = parseInt(tradeStr.replace(/[^\d]/g, ''), 10) || 0;
        
        const artefactRows = doc.querySelectorAll('.ir-summary tr');
        artefactRows.forEach(row => {
            const tds = row.querySelectorAll('td');
            if (tds.length >= 2 && tds[0]?.innerText.includes('Artefact')) {
                const rawText = tds[1].innerText.trim();
                p.artefact = rawText === 'N/A' ? null : (rawText.split(/\s+/)[0] || null);
            }
        });

        const parseRace = (text) => parseInt(text.match(/([+-]\d+)\s*$/)?.[1] || "0", 10);
        doc.querySelectorAll('.race-summary tbody td').forEach(td => {
            const text = td.innerText.trim();
            if (text.includes('Growth')) p.race_growth = parseRace(text);
            if (text.includes('Science')) p.race_science = parseRace(text);
            if (text.includes('Culture')) p.race_culture = parseRace(text);
            if (text.includes('Production')) p.race_production = parseRace(text);
            if (text.includes('Speed')) p.race_speed = parseRace(text);
            if (text.includes('Attack')) p.race_attack = parseRace(text);
            if (text.includes('Defence') || text.includes('Defense')) p.race_defense = parseRace(text);
            if (text.includes('Trader')) p.race_trader = parseRace(text);
            if (text.includes('Start Up') || text.includes('Start Up Lab')) p.race_sul = parseRace(text);
        });
    }

    // Scrape Planets table data for Home and Candidate Home planet designations
    const planetRows = doc.querySelectorAll('tr[data-planet-id]');
    if (planetRows.length > 0) {
        const parsedPlanets = [];

        planetRows.forEach(row => {
            const game_planet_id = parseInt(row.getAttribute('data-planet-id'), 10);
            const link = row.querySelector('a[href^="/Game/Map/SolarSystem/"]');
            let system_id = null;
            let planet_index = null;

            if (link) {
                const href = link.getAttribute('href');
                const matches = href.match(/\/SolarSystem\/(\d+)\/(\d+)/);
                if (matches) {
                    system_id = parseInt(matches[1], 10);
                    planet_index = parseInt(matches[2], 10);
                }
            }

            const tds = row.querySelectorAll('td');
            // Pop is column 3 (index 2)
            const pop = tds[2] ? parseInt(tds[2].innerText.trim(), 10) : 0;

            parsedPlanets.push({ game_planet_id, system_id, planet_index, pop });
        });

        if (parsedPlanets.length > 0) {
            const mainHome = parsedPlanets[0];
            p.home_planet_id = mainHome.game_planet_id;
            p.home_system_id = mainHome.system_id;
            p.home_planet_index = mainHome.planet_index;

            // Find possible alternatives (same pop as main home, skipping index 0 itself)
            const alternatives = [];
            for (let i = 1; i < parsedPlanets.length; i++) {
                if (parsedPlanets[i].pop === mainHome.pop) {
                    alternatives.push({
                        game_planet_id: parsedPlanets[i].game_planet_id,
                        system_id: parsedPlanets[i].system_id,
                        planet_index: parsedPlanets[i].planet_index
                    });
                }
            }
            p.possible_homes = alternatives;
        }
    }

    return p;
}

export async function scrapePlayer(playerId) {
    console.log(`[Spy] Initiating deep scrape for Player ID: ${playerId}`);
    
    const p = extractPlayerData(playerId, document);

    window.parent.postMessage({
        type: 'GAME_CONTEXT',
        payload: {
            path: window.location.pathname,
            isPlayerView: true,
            playerId: p.id
        }
    }, window.location.origin);

    try {
        const response = await fetch('/hub-api/sync/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
        if (response.ok) {
            console.log(`[Spy] Player Profile '${p.name}' synced successfully.`);
            window.parent.postMessage({ type: 'SHOW_TOAST', payload: `Player ${p.name} Synced` }, window.location.origin);
            const header = document.querySelector('th[colspan="2"] span');
            if (header && !header.querySelector('.aw-synced')) {
                header.innerHTML += ' <span class="badge bg-success ms-2 aw-synced" style="font-size: 0.6em; vertical-align: middle; background-color: #22c55e !important; color: #fff;"><i class="bi bi-cloud-check"></i> Hub Synced</span>';
            }
        }
    } catch (err) { console.error(`[Spy] Player API request failed`, err); }
}