export async function scrapePlayer(playerId) {
    console.log(`[Spy] Initiating deep scrape for Player ID: ${playerId}`);
    
    const p = {
        id: parseInt(playerId, 10), name: null, alliance_id: null, alliance_tag: null,
        country: null, local_time: null, idle_time: null, origin_system: null,
        level: 0, ranking: null, points: 0, science_level: 0, culture_level: 0,
        biology: 0, economy: 0, energy: 0, mathematics: 0, physics: 0, social: 0,
        trade_revenue: 0, artefact: null,
        race_growth: 0, race_science: 0, race_culture: 0, race_production: 0, race_speed: 0, race_attack: 0, race_defense: 0
    };

    // FIX: Explicitly target the profile link to avoid supporter medals
    const nameLink = document.querySelector('th[colspan="2"] a[href^="/Game/Players/Profile/"]');
    if (nameLink) p.name = nameLink.innerText.trim();

    const allyLink = document.querySelector('th[colspan="2"] a[href^="/Game/Alliance/Profile/"]');
    if (allyLink) {
        p.alliance_tag = allyLink.innerText.trim();
        p.alliance_id = parseInt(allyLink.getAttribute('href').split('/').pop(), 10);
    }

    const getRowVal = (labelMatch) => {
        const rows = document.querySelectorAll('table tbody tr');
        for (let row of rows) {
            const tds = row.querySelectorAll('td');
            if (tds.length >= 2 && tds[0].innerText.includes(labelMatch)) return tds[1].innerText.trim();
        }
        return null;
    };

    p.local_time = getRowVal('Local Time');
    p.idle_time = getRowVal('Idle'); // NEW: Grabs "6m" or "Online"
    
    const countrySpan = document.querySelector('img[src^="/img/country/"]')?.nextElementSibling;
    if (countrySpan) p.country = countrySpan.innerText.trim();

    const originLink = document.querySelector('a[href^="/Game/Map/SolarSystem/"]');
    if (originLink) p.origin_system = parseInt(originLink.getAttribute('href').split('/').pop(), 10);

    const lvlStr = getRowVal('Player Level');
    if (lvlStr) p.level = parseInt(lvlStr.split('-')[0].trim(), 10) || 0;

    p.science_level = parseInt(getRowVal('Science Level'), 10) || 0;
    p.culture_level = parseInt(getRowVal('Culture Level'), 10) || 0;

    const rankStr = getRowVal('Ranking');
    if (rankStr) {
        const rMatch = rankStr.match(/#(\d+)\s*\(([\d,]+)\)/);
        if (rMatch) {
            p.ranking = parseInt(rMatch[1].replace(/,/g, ''), 10);
            p.points = parseInt(rMatch[2].replace(/,/g, ''), 10);
        }
    }

    p.biology = parseInt(getRowVal('Biology'), 10) || 0;
    p.economy = parseInt(getRowVal('Economy'), 10) || 0;
    p.energy = parseInt(getRowVal('Energy'), 10) || 0;
    p.mathematics = parseInt(getRowVal('Mathematics'), 10) || 0;
    p.physics = parseInt(getRowVal('Physics'), 10) || 0;
    p.social = parseInt(getRowVal('Social'), 10) || 0;

    const tradeStr = getRowVal('Trade Revenue');
    if (tradeStr) p.trade_revenue = parseInt(tradeStr.replace(/[^\d]/g, ''), 10) || 0;

    // FIX: Safely grab the first continuous string in the cell, ignoring badge icons
    const artefactRows = document.querySelectorAll('.ir-summary tr');
    artefactRows.forEach(row => {
        const tds = row.querySelectorAll('td');
        if (tds[0]?.innerText.includes('Artefact')) {
            const rawText = tds[1].innerText.trim();
            // Splitting by whitespace guarantees we only get "MJ3" or "OB1"
            p.artefact = rawText.split(/\s+/)[0] || null;
        }
    });

    const parseRace = (text) => parseInt(text.match(/([+-]\d+)$/)?.[1] || "0", 10);
    document.querySelectorAll('.race-summary tbody td').forEach(td => {
        const text = td.innerText.trim();
        if (text.includes('Growth')) p.race_growth = parseRace(text);
        if (text.includes('Science')) p.race_science = parseRace(text);
        if (text.includes('Culture')) p.race_culture = parseRace(text);
        if (text.includes('Production')) p.race_production = parseRace(text);
        if (text.includes('Speed')) p.race_speed = parseRace(text);
        if (text.includes('Attack')) p.race_attack = parseRace(text);
        if (text.includes('Defence') || text.includes('Defense')) p.race_defense = parseRace(text);
    });

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