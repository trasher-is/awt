import { parseArrivalToISO } from '../utils/fleet-time.js';

// Pure parser: pull planets + fleets out of any system-map document (the live page or a
// fetched-and-parsed one). Used by both the on-page scraper and the off-page "Update".
export function extractSystemData(doc = document) {
    const rows = doc.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
    const planets = [];
    const fleets = [];

    rows.forEach(row => {
        try {
            const gamePlanetId = parseInt(row.getAttribute('data-planet-id'), 10);
            const tds = row.querySelectorAll('td');
            // Index cell can carry hub-injected badges (e.g. "10caveman: next") — take
            // only the LEADING digits so injected text/numbers never leak into the index.
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
            const isUnknown = tds[3].innerText.includes('Unknown'); // <-- ADD THIS

            planets.push({
                game_planet_id: gamePlanetId,
                planet_index: planetIndex,
                population,
                starbase,
                owner,
                has_fleet: hasFleet ? 1 : 0,
                is_unknown: isUnknown // <-- ADD THIS
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

                            let arrival_time = null;
                                    // The 8th column (index 7) contains the Arrival Time and the BC button
                                    if (fTds.length >= 8) {
                                        const clone = fTds[7].cloneNode(true);
                                        // Rip out the buttons so we only get the raw text
                                        clone.querySelectorAll('a, button').forEach(n => n.remove());
                                        const text = clone.innerText.trim();
                                        if (text.length > 3) arrival_time = text;
                                    }

                                    fleets.push({
                                        game_fleet_id: gameFleetId,
                                        owner_id: fleetOwnerId,
                                        planet_index: planetIndex,
                                        // The aggressive regex strips everything that isn't a digit
                                        transports: parseInt(fTds[1].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        colony_ships: parseInt(fTds[2].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        destroyers: parseInt(fTds[3].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        cruisers: parseInt(fTds[4].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        battleships: parseInt(fTds[5].innerText.replace(/[^\d]/g, ''), 10) || 0,
                                        arrival_time: arrival_time,
                                        arrival_at: parseArrivalToISO(arrival_time)
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

    return { planets, fleets };
}

// Off-page refresh: fetch a system's map, parse it, and sync. Returns true on success.
// Runs from the dashboard (e.g. travel-calc "Update" button); no game-page DOM needed.
export async function scrapeSystemById(systemId) {
    try {
        const res = await fetch(`/Game/Map/SolarSystem/${systemId}`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const { planets, fleets } = extractSystemData(doc);
        if (planets.length === 0) return false;
        const r = await fetch('/hub-api/sync/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_id: parseInt(systemId, 10), planets, fleets })
        });
        return r.ok;
    } catch (err) {
        console.error('[Spy] scrapeSystemById failed:', err);
        return false;
    }
}

export async function scrapeSystem(systemId) {
    console.log(`[Spy] Initiating scrape for System ID: ${systemId}`);

    const { planets, fleets } = extractSystemData(document);

    if (planets.length === 0) return;

    try {
        const response = await fetch('/hub-api/sync/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_id: parseInt(systemId, 10), planets, fleets })
        });
        
        if (response.ok) {
            console.log(`[Spy] System ${systemId} synced! (${planets.length} planets, ${fleets.length} fleets)`);
            
            // Tell the Wrapper to show a Toast & update stats
            window.parent.postMessage({ type: 'SHOW_TOAST', payload: `System #${systemId} Synced` }, window.location.origin);
            
            // Inject a native-looking Bootstrap badge directly into the game's header
            const header = document.querySelector('h5');
            if (header && !header.querySelector('.aw-synced')) {
                header.innerHTML += ' <span class="badge bg-success ms-2 aw-synced" style="font-size: 0.6em; vertical-align: middle; background-color: #22c55e !important; color: #fff;"><i class="bi bi-cloud-check"></i> System Synced</span>';
            }
        }
    } catch (err) {
        console.error(`[Spy] API request failed`, err);
    }
}