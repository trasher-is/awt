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
                        const coords = text.substring(parenStart + 1, parenEnd).replace(/[−—–]/g, '-').split('/');
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

            const mapRes = await fetch(`/Game/Map/SolarSystem/${sysId}`);
            const mapHtml = await mapRes.text();
            const doc = new DOMParser().parseFromString(mapHtml, 'text/html');

            const rows = doc.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
            const planets = [];
            const fleets = [];

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
                    const isUnknown = tds[3].innerText.includes('Unknown');
                    planets.push({ game_planet_id: gamePlanetId, planet_index: planetIndex, population, starbase, owner, has_fleet: hasFleet ? 1 : 0, is_unknown: isUnknown });

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

                                    let arrival_time = null;
                                    if (fTds.length >= 8) {
                                        const clone = fTds[7].cloneNode(true);
                                        clone.querySelectorAll('a, button').forEach(n => n.remove());
                                        const text = clone.innerText.trim();
                                        if (text.length > 3) arrival_time = text;
                                    }

                                    fleets.push({
                                        game_fleet_id: gameFleetId,
                                        owner_id: fleetOwnerId,
                                        planet_index: planetIndex,
                                        transports: parseInt(fTds[1].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        colony_ships: parseInt(fTds[2].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        destroyers: parseInt(fTds[3].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        cruisers: parseInt(fTds[4].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        battleships: parseInt(fTds[5].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        arrival_time: arrival_time
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

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        updateProgressCb("Scan Complete!", total, total);

    } catch (err) {
        console.error("[Mass Scan] Fatal Error", err);
        updateProgressCb("Scan Failed. Check Console.", 0, 0);
    }
}

export async function runPlayerScan(updateProgressCb) {
    console.log("[Mass Scan] Initiating player sequence from Rankings...");
    try {
        // STEP 1: Compile the Master Index from Eco Bonus Rankings
        updateProgressCb("Compiling Player Index from Rankings...", 0, 0);
        
        const playerIds = [];
        let currentPage = 1;

        while (true) {
            updateProgressCb(`Fetching Ranking Page ${currentPage}...`, currentPage, currentPage + 2); 
            
            const rankRes = await fetch(`/Ranking/EcoBonus?pageNumber=${currentPage}`);
            if (!rankRes.ok) break;
            
            const rankHtml = await rankRes.text();
            const rankDoc = new DOMParser().parseFromString(rankHtml, 'text/html');
            
            const playerLinks = rankDoc.querySelectorAll('td a[href^="/Game/Players/Profile/"]');
            
            if (playerLinks.length === 0) break; 

            let newIdsAdded = 0;
            playerLinks.forEach(link => {
                const id = parseInt(link.getAttribute('href').split('/').pop(), 10);
                if (id && !playerIds.includes(id)) {
                    playerIds.push(id);
                    newIdsAdded++;
                }
            });

            if (newIdsAdded === 0) break;

            currentPage++;
            await new Promise(resolve => setTimeout(resolve, 150)); 
        }

        const total = playerIds.length;
        if (!total) { 
            updateProgressCb("Error: No players found in Ranking", 0, 0); 
            return; 
        }

        console.log(`[Mass Scan] Index compiled. Deep scanning ${total} players...`);

        // STEP 2: The Deep Profile Scan
        for (let i = 0; i < total; i++) {
            const playerId = playerIds[i];
            updateProgressCb(`Scanning Player #${playerId}...`, i + 1, total);

            const res = await fetch(`/Game/Players/Profile/${playerId}`);
            if (!res.ok) continue; 
            
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            const p = {
                id: parseInt(playerId, 10), name: null, alliance_id: null, alliance_tag: null,
                country: null, local_time: null, idle_time: null, origin_system: null,
                joined: null, logins: 0,
                level: 0, ranking: null, points: 0, science_level: 0, culture_level: 0,
                biology: 0, economy: 0, energy: 0, mathematics: 0, physics: 0, social: 0,
                trade_revenue: 0, artefact: null, eco_bonus: 0,
                race_growth: 0, race_science: 0, race_culture: 0, race_production: 0, race_speed: 0, race_attack: 0, race_defense: 0
            };

            const nameLink = doc.querySelector('th[colspan="2"] a[href^="/Game/Players/Profile/"]');
            if (nameLink) p.name = nameLink.innerText.trim();

            const allyLink = doc.querySelector('th[colspan="2"] a[href^="/Game/Alliance/Profile/"]');
            if (allyLink) {
                p.alliance_tag = allyLink.innerText.trim();
                p.alliance_id = parseInt(allyLink.getAttribute('href').split('/').pop(), 10);
            }

            // Fixed: Scrape both th and td tags to support the modified profile tables
            const getRowVal = (labelMatch, exact = false) => {
                const rows = doc.querySelectorAll('table tbody tr');
                for (let row of rows) {
                    const cells = row.querySelectorAll('th, td');
                    if (cells.length >= 2) {
                        const labelText = cells[0].innerText.trim();
                        if (exact ? labelText === labelMatch : labelText.includes(labelMatch)) {
                            return cells[1].innerText.trim();
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

            const originLink = doc.querySelector('a[href^="/Game/Map/SolarSystem/"]');
            if (originLink) p.origin_system = parseInt(originLink.getAttribute('href').split('/').pop(), 10);

            const lvlStr = getRowVal('Player Level');
            if (lvlStr) p.level = parseInt(lvlStr.split('-')[0].trim(), 10) || 0;

            p.science_level = parseInt(getRowVal('Science Level'), 10) || 0;
            p.culture_level = parseInt(getRowVal('Culture Level'), 10) || 0;

            const rankStr = getRowVal('Ranking');
            if (rankStr) {
                // Fixed: Enhanced regex matches dots, commas, and formatting spaces
                const rMatch = rankStr.match(/#(\d+)\s*\(([\d,\.\s]+)\)/);
                if (rMatch) {
                    p.ranking = parseInt(rMatch[1].replace(/[^\d]/g, ''), 10);
                    p.points = parseInt(rMatch[2].replace(/[^\d]/g, ''), 10);
                }
            }

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

            if (p.name) {
                await fetch('/hub-api/sync/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        updateProgressCb("Player Scan Complete!", total, total);
    } catch (err) {
        console.error("[Mass Scan] Fatal Error", err);
        updateProgressCb("Scan Failed. Check Console.", 0, 0);
    }
}