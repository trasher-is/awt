import { extractPlayerData, buildSecuredStatsUrl } from './player-parser.js';
import { parseArrivalToISO } from '../utils/fleet-time.js';

export async function runMassScan(updateProgressCb) {
    console.log("[Mass Scan] Initiating sequence...");

    try {
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

        const sysRes = await fetch('/hub-api/systems');
        const sysData = await sysRes.json();
        const sysIds = sysData.systems;
        const total = sysIds.length;

        if (!total) {
            updateProgressCb("Error: No systems found in DB", 0, 0);
            return;
        }

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

                    // Index cell can carry hub-injected badges (e.g. "10caveman: next") —
                    // take only the LEADING digits so injected text/numbers never leak in.
                    const idxMatch = (tds[0].textContent || '').trim().match(/^\d+/);
                    const planetIndex = idxMatch ? parseInt(idxMatch[0], 10) : NaN;
                    // Skip rows with an unusable id/index so we never store impossible values.
                    if (!Number.isInteger(gamePlanetId) || gamePlanetId <= 0) return;
                    if (!Number.isInteger(planetIndex) || planetIndex < 1 || planetIndex > 99) return;
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
                                        arrival_time: arrival_time,
                                        arrival_at: parseArrivalToISO(arrival_time)
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
                    body: JSON.stringify({ system_id: sysId, planets, fleets, scan_mode: 'galaxy' })
                });
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        document.getElementById('scan-progress-bar').style.width = '100%';
        updateProgressCb("Scan Complete!", total, total);

    } catch (err) {
        console.error("[Mass Scan] Fatal Error", err);
        updateProgressCb("Scan Failed. Check Console.", 0, 0);
    }
}

export async function runPlayerScan(updateProgressCb) {
    console.log("[Mass Scan] Initiating player sequence from Rankings...");
    try {
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

        for (let i = 0; i < total; i++) {
            const playerId = playerIds[i];
            updateProgressCb(`Scanning Player #${playerId}...`, i + 1, total);

            const res = await fetch(`/Game/Players/Profile/${playerId}`);
            if (!res.ok) continue; 
            
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            // FIXED: Reuses shared selector configuration context from central helper function quietly
            const p = extractPlayerData(playerId, doc);

            // --- ADDED LOGIC: Read infrastructure history (Total pop, factories, etc.) ---
            try {
                const statsUrl = buildSecuredStatsUrl(playerId);
                const statsResponse = await fetch(statsUrl);
                if (statsResponse.ok) {
                    const statsHtmlText = await statsResponse.text();
                    const dataRegexMatch = statsHtmlText.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
                    
                    if (dataRegexMatch) {
                        const infrastructureHistoryArray = JSON.parse(dataRegexMatch[1]);
                        if (Array.isArray(infrastructureHistoryArray) && infrastructureHistoryArray.length > 0) {
                            const latestLogRecord = infrastructureHistoryArray[infrastructureHistoryArray.length - 1];
                            p.total_planets     = parseInt(latestLogRecord.count, 10) || 0;
                            p.total_population  = parseInt(latestLogRecord.population, 10) || 0;
                            p.total_farms       = parseInt(latestLogRecord.farms, 10) || 0;
                            p.total_factories   = parseInt(latestLogRecord.factories, 10) || 0;
                            p.total_labs        = parseInt(latestLogRecord.labs, 10) || 0;
                            p.total_cybernetics = parseInt(latestLogRecord.cybernets, 10) || 0;
                        }
                    }
                }
            } catch (statsErr) {
                console.warn(`[Mass Scan] Failed to fetch stats for Player ID: ${playerId}`, statsErr);
            }
            // -----------------------------------------------------------------------------

            if (p.name) {
                await fetch('/hub-api/sync/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
            }
            
            // Since 2 requests are now made per player, it's recommended to slightly increase the delay to avoid an IP ban
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        updateProgressCb("Player Scan Complete!", total, total);
    } catch (err) {
        console.error("[Mass Scan] Fatal Error", err);
        updateProgressCb("Scan Failed. Check Console.", 0, 0);
    }
}

export async function scanPlayerList(playerIds, updateProgressCb) {
    console.log(`[Mass Scan] Scanning ${playerIds.length} specific players...`);
    const total = playerIds.length;

    if (!total) { 
        updateProgressCb("Error: No players to scan", 0, 0); 
        return; 
    }

    for (let i = 0; i < total; i++) {
        const playerId = playerIds[i];
        updateProgressCb(`Scanning Player #${playerId}...`, i + 1, total);

        const res = await fetch(`/Game/Players/Profile/${playerId}`);
        if (!res.ok) continue; 
        
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const p = extractPlayerData(playerId, doc);

        // -- Use the previously prepared infrastructure fetch (buildSecuredStatsUrl) --
        try {
            const statsUrl = buildSecuredStatsUrl(playerId);
            const statsResponse = await fetch(statsUrl);
            if (statsResponse.ok) {
                const statsHtmlText = await statsResponse.text();
                const dataRegexMatch = statsHtmlText.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
                if (dataRegexMatch) {
                    const infrastructureHistoryArray = JSON.parse(dataRegexMatch[1]);
                    if (Array.isArray(infrastructureHistoryArray) && infrastructureHistoryArray.length > 0) {
                        const latestLogRecord = infrastructureHistoryArray[infrastructureHistoryArray.length - 1];
                        p.total_planets     = parseInt(latestLogRecord.count, 10) || 0;
                        p.total_population  = parseInt(latestLogRecord.population, 10) || 0;
                        p.total_farms       = parseInt(latestLogRecord.farms, 10) || 0;
                        p.total_factories   = parseInt(latestLogRecord.factories, 10) || 0;
                        p.total_labs        = parseInt(latestLogRecord.labs, 10) || 0;
                        p.total_cybernetics = parseInt(latestLogRecord.cybernets, 10) || 0;
                    }
                }
            }
        } catch (e) {}
        // -----------------------------------------------------------------------------------

        if (p.name) {
            await fetch('/hub-api/sync/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    updateProgressCb("Alliance Scan Complete!", total, total);
}