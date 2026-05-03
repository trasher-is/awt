export async function scrapeSystem(systemId) {
    console.log(`[Spy] Initiating scrape for System ID: ${systemId}`);
    
    const rows = document.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
    const planets = [];
    const fleets = []; 

    rows.forEach(row => {
        try {
            const gamePlanetId = parseInt(row.getAttribute('data-planet-id'), 10);
            const tds = row.querySelectorAll('td');
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

            planets.push({
                game_planet_id: gamePlanetId,
                planet_index: planetIndex,
                population,
                starbase,
                owner,
                has_fleet: hasFleet ? 1 : 0
            });

            // --- FLEET EXTRACTION ---
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
                    } catch (fleetErr) {
                        console.warn(`[Spy] Skipped malformed fleet at planet ${planetIndex}`, fleetErr);
                    }
                });
            }
        } catch (planetErr) {
            console.error(`[Spy] Failed to parse a planet row`, planetErr);
        }
    });

    if (planets.length === 0) return;

    try {
        const response = await fetch('/hub-api/sync/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_id: parseInt(systemId, 10), planets, fleets })
        });
        
        if (response.ok) {
            console.log(`[Spy] System ${systemId} synced! (${planets.length} planets, ${fleets.length} fleets)`);
        }
    } catch (err) {
        console.error(`[Spy] API request failed`, err);
    }
}