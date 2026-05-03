export async function scrapePlayer(playerId) {
    console.log(`[Spy] Initiating deep scrape for Player ID: ${playerId}`);
    
    // Setup the data container mapping directly to our database columns
    const p = {
        id: parseInt(playerId, 10),
        name: null, alliance_id: null, alliance_tag: null,
        country: null, local_time: null, origin_system: null,
        level: 0, ranking: null, points: 0,
        science_level: 0, culture_level: 0,
        biology: 0, economy: 0, energy: 0, mathematics: 0, physics: 0, social: 0,
        trade_revenue: 0, artefact: null,
        race_growth: 0, race_science: 0, race_culture: 0, race_production: 0, race_speed: 0, race_attack: 0, race_defense: 0
    };

    // 1. Basic Info & Alliance
    const headerLinks = document.querySelectorAll('th[colspan="2"] a');
    if (headerLinks.length >= 1) p.name = headerLinks[0].innerText.trim();
    if (headerLinks.length >= 2 && headerLinks[1].getAttribute('href').includes('Alliance')) {
        p.alliance_tag = headerLinks[1].innerText.trim();
        p.alliance_id = parseInt(headerLinks[1].getAttribute('href').split('/').pop(), 10);
    }

    // Helper function to find a value based on the adjacent label in a table row
    const getRowVal = (labelMatch) => {
        const rows = document.querySelectorAll('table tbody tr');
        for (let row of rows) {
            const tds = row.querySelectorAll('td');
            if (tds.length >= 2 && tds[0].innerText.includes(labelMatch)) {
                return tds[1].innerText.trim();
            }
        }
        return null;
    };

    // 2. Core Stats
    p.local_time = getRowVal('Local Time');
    
    // Extract Country
    const countrySpan = document.querySelector('img[src^="/img/country/"]')?.nextElementSibling;
    if (countrySpan) p.country = countrySpan.innerText.trim();

    // Extract Origin System
    const originLink = document.querySelector('a[href^="/Game/Map/SolarSystem/"]');
    if (originLink) p.origin_system = parseInt(originLink.getAttribute('href').split('/').pop(), 10);

    const lvlStr = getRowVal('Player Level'); // e.g., "44 - 98%"
    if (lvlStr) p.level = parseInt(lvlStr.split('-')[0].trim(), 10) || 0;

    p.science_level = parseInt(getRowVal('Science Level'), 10) || 0;
    p.culture_level = parseInt(getRowVal('Culture Level'), 10) || 0;

    const rankStr = getRowVal('Ranking'); // e.g., "#7 (272)"
    if (rankStr) {
        const rMatch = rankStr.match(/#(\d+)\s*\(([\d,]+)\)/);
        if (rMatch) {
            p.ranking = parseInt(rMatch[1].replace(/,/g, ''), 10);
            p.points = parseInt(rMatch[2].replace(/,/g, ''), 10);
        }
    }

    // 3. Intelligence Report (Sciences & Economy)
    p.biology = parseInt(getRowVal('Biology'), 10) || 0;
    p.economy = parseInt(getRowVal('Economy'), 10) || 0;
    p.energy = parseInt(getRowVal('Energy'), 10) || 0;
    p.mathematics = parseInt(getRowVal('Mathematics'), 10) || 0;
    p.physics = parseInt(getRowVal('Physics'), 10) || 0;
    p.social = parseInt(getRowVal('Social'), 10) || 0;

    const tradeStr = getRowVal('Trade Revenue'); // e.g., "+107%"
    if (tradeStr) p.trade_revenue = parseInt(tradeStr.replace(/[^\d]/g, ''), 10) || 0;

    // Extract Artefact tag (e.g., "OB1")
    const artefactRows = document.querySelectorAll('.ir-summary tr');
    artefactRows.forEach(row => {
        const tds = row.querySelectorAll('td');
        if (tds[0]?.innerText.includes('Artefact')) {
            const span = tds[1].querySelectorAll('span')[1]; // The first span inside the <td>
            if (span) p.artefact = span.innerText.trim();
        }
    });

    // 4. Race Summary Modifiers
    // Extracts the final integer modifier (e.g., "-32% Growth -4" -> -4)
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

    // 5. Send to Hub API
    try {
        const response = await fetch('/hub-api/sync/player', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p)
        });
        if (response.ok) console.log(`[Spy] Player Profile '${p.name}' synced successfully.`);
    } catch (err) {
        console.error(`[Spy] Player API request failed`, err);
    }
}