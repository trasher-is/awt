export async function runMassScan(updateProgressCb) {
    console.log("[Mass Scan] Initiating sequence...");

    try {
        // STEP 1: Fetch the Calculator to update the Master Index silently
        updateProgressCb("Updating Galaxy Index...", 0, 0);
        const calcRes = await fetch('/About/TravelTimeCalculator');
        const calcHtml = await calcRes.text();
        const calcDoc = new DOMParser().parseFromString(calcHtml, 'text/html');
        
        const select = calcDoc.getElementById('FromSolarSystemId');
        if (select) {
            const systems = [];
            select.querySelectorAll('option[value]:not([value=""])').forEach(opt => {
                const id = parseInt(opt.value, 10);
                const text = opt.innerText.trim();
                try {
                    const bracketStart = text.indexOf('[');
                    const parenStart = text.lastIndexOf('(');
                    const parenEnd = text.lastIndexOf(')');
                    if (bracketStart !== -1 && parenStart !== -1 && parenEnd !== -1) {
                        const namePart = text.substring(0, bracketStart).trim();
                        const coords = text.substring(parenStart + 1, parenEnd).split('/');
                        if (coords.length === 2 && namePart) {
                            systems.push({ id, name: namePart, x: parseInt(coords[0], 10), y: parseInt(coords[1], 10) });
                        }
                    }
                } catch (e) {}
            });

            if (systems.length > 0) {
                await fetch('/hub-api/sync/galaxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ systems })
                });
            }
        }

        // STEP 2: Ask the backend for the list of IDs to scan
        const sysRes = await fetch('/hub-api/systems');
        const sysData = await sysRes.json();
        const sysIds = sysData.systems;
        const total = sysIds.length;

        if (!total) {
            updateProgressCb("Error: No systems found in DB", 0, 0);
            return;
        }

        // STEP 3: The 200ms Loop
        for (let i = 0; i < total; i++) {
            const sysId = sysIds[i];
            updateProgressCb(`Scanning System #${sysId}...`, i + 1, total);

            // Fetch the system HTML silently
            const mapRes = await fetch(`/Game/Map/SolarSystem/${sysId}`);
            const mapHtml = await mapRes.text();
            const doc = new DOMParser().parseFromString(mapHtml, 'text/html');

            const rows = doc.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
            const planets = [];
            const fleets = [];

            // Execute the standard system parser logic on the hidden DOM
            rows.forEach(row => {
                try {
                    const gamePlanetId = parseInt(row.getAttribute('data-planet-id'), 10);
                    const tds = row.querySelectorAll('td');
                    if (tds.length < 3) return;

                    const planetIndex = parseInt(tds[0].innerText.trim(), 10);
                    const population = parseInt(tds[1].innerText.trim(), 10) || 0;
                    const starbase = parseInt(tds[2].innerText.trim(), 10) || 0;

                    let owner = null;
                    const ownerLink = tds[3].querySelector('a[href^="/Game/Players/Profile/"]');
                    if (ownerLink) {
                        owner = {
                            id: parseInt(ownerLink.getAttribute('href').split('/').pop(), 10),
                            name: ownerLink.innerText.trim(),
                            alliance_id: null,
                            alliance_tag: null
                        };
                        const allyLink = tds[3].querySelector('a[href^="/Game/Alliance/Profile/"]');
                        if (allyLink) {
                            owner.alliance_id = parseInt(allyLink.getAttribute('href').split('/').pop(), 10);
                            owner.alliance_tag = allyLink.innerText.trim();
                        }
                    }

                    const hasFleet = !!row.querySelector('.bi-rocket-fill, .bi-rocket-takeoff-fill');
                    planets.push({ game_planet_id: gamePlanetId, planet_index: planetIndex, population, starbase, owner, has_fleet: hasFleet ? 1 : 0 });

                    const nextRow = row.nextElementSibling;
                    if (nextRow && nextRow.classList.contains(`fleetsPlanet${gamePlanetId}`)) {
                        const fleetRows = nextRow.querySelectorAll('table tbody tr:not(.head)');
                        fleetRows.forEach(fRow => {
                            try {
                                const fTds = fRow.querySelectorAll('td');
                                if (fTds.length >= 6) {
                                    let fleetOwnerId = null;
                                    const fOwnerLink = fTds[0].querySelector('a[href^="/Game/Players/Profile/"]');
                                    if (fOwnerLink) fleetOwnerId = parseInt(fOwnerLink.getAttribute('href').split('/').pop(), 10);

                                    let gameFleetId = null;
                                    const bcLink = fRow.querySelector('a[href*="FleetId=" i]');
                                    if (bcLink) {
                                        const match = bcLink.getAttribute('href').match(/FleetId=(\d+)/i);
                                        if (match) gameFleetId = parseInt(match[1], 10);
                                    }

                                    fleets.push({
                                        game_fleet_id: gameFleetId,
                                        owner_id: fleetOwnerId,
                                        planet_index: planetIndex,
                                        transports: parseInt(fTds[1].innerText.replace(/,/g, ''), 10) || 0,
                                        colony_ships: parseInt(fTds[2].innerText.replace(/,/g, ''), 10) || 0,
                                        destroyers: parseInt(fTds[3].innerText.replace(/,/g, ''), 10) || 0,
                                        cruisers: parseInt(fTds[4].innerText.replace(/,/g, ''), 10) || 0,
                                        battleships: parseInt(fTds[5].innerText.replace(/,/g, ''), 10) || 0
                                    });
                                }
                            } catch (e) {}
                        });
                    }
                } catch (e) {}
            });

            if (planets.length > 0) {
                await fetch('/hub-api/sync/system', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ system_id: sysId, planets, fleets })
                });
            }

            // The mandatory delay
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        updateProgressCb("Scan Complete!", total, total);

    } catch (err) {
        console.error("[Mass Scan] Fatal Error", err);
        updateProgressCb("Scan Failed. Check Console.", 0, 0);
    }
}

export async function runPlayerScan(updateProgressCb) {
    console.log("[Mass Scan] Initiating player sequence...");
    try {
        const resList = await fetch('/hub-api/players');
        const dataList = await resList.json();
        const playerIds = dataList.players;
        const total = playerIds.length;

        if (!total) {
            updateProgressCb("Error: No players in DB", 0, 0);
            return;
        }

        for (let i = 0; i < total; i++) {
            const playerId = playerIds[i];
            updateProgressCb(`Scanning Player #${playerId}...`, i + 1, total);

            const res = await fetch(`/Game/Players/Profile/${playerId}`);
            if (!res.ok) continue; // Skip if they deleted their account or got banned
            
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

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

            const headerLinks = doc.querySelectorAll('th[colspan="2"] a');
            if (headerLinks.length >= 1) p.name = headerLinks[0].innerText.trim();
            if (headerLinks.length >= 2 && headerLinks[1].getAttribute('href').includes('Alliance')) {
                p.alliance_tag = headerLinks[1].innerText.trim();
                p.alliance_id = parseInt(headerLinks[1].getAttribute('href').split('/').pop(), 10);
            }

            const getRowVal = (labelMatch) => {
                const rows = doc.querySelectorAll('table tbody tr');
                for (let row of rows) {
                    const tds = row.querySelectorAll('td');
                    if (tds.length >= 2 && tds[0].innerText.includes(labelMatch)) return tds[1].innerText.trim();
                }
                return null;
            };

            p.local_time = getRowVal('Local Time');
            const countrySpan = doc.querySelector('img[src^="/img/country/"]')?.nextElementSibling;
            if (countrySpan) p.country = countrySpan.innerText.trim();

            const originLink = doc.querySelector('a[href^="/Game/Map/SolarSystem/"]');
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

            const artefactRows = doc.querySelectorAll('.ir-summary tr');
            artefactRows.forEach(row => {
                const tds = row.querySelectorAll('td');
                if (tds[0]?.innerText.includes('Artefact')) {
                    const span = tds[1].querySelectorAll('span')[1];
                    if (span) p.artefact = span.innerText.trim();
                }
            });

            const parseRace = (text) => parseInt(text.match(/([+-]\d+)$/)?.[1] || "0", 10);
            doc.querySelectorAll('.race-summary tbody td').forEach(td => {
                const text = td.innerText.trim();
                if (text.includes('Growth')) p.race_growth = parseRace(text);
                if (text.includes('Science')) p.race_science = parseRace(text);
                if (text.includes('Culture')) p.race_culture = parseRace(text);
                if (text.includes('Production')) p.race_production = parseRace(text);
                if (text.includes('Speed')) p.race_speed = parseRace(text);
                if (text.includes('Attack')) p.race_attack = parseRace(text);
                if (text.includes('Defence') || text.includes('Defense')) p.race_defense = parseRace(text);
            });

            // Only submit if we successfully parsed a name (validates the DOM structure didn't break)
            if (p.name) {
                await fetch('/hub-api/sync/player', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(p)
                });
            }

            await new Promise(resolve => setTimeout(resolve, 100)); // The 100ms delay
        }

        updateProgressCb("Player Scan Complete!", total, total);

    } catch (err) {
        console.error("[Mass Scan] Fatal Error", err);
        updateProgressCb("Scan Failed. Check Console.", 0, 0);
    }
}