import { extractPlayerData, buildSecuredStatsUrl } from './player-parser.js';
import { parseArrivalToISO } from '../utils/fleet-time.js';
import '../utils/scrape-report.js';
import '../utils/parse-number.js';
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const { ScrapeReport, LABELS, matchesLabel, containsLabel } = globalThis.AWScrape;
const { parseLocaleInt } = globalThis.AWNumber;

// Ship columns inside a planet's fleet sub-table. The table has a `.head` row, so the
// columns can be located by their own header text instead of by a fixed offset. Only
// wordings confirmed from the live game are listed — a guessed translation would match
// the wrong column silently.
const FLEET_COLUMNS = [
    { key: 'transports',   synonyms: ['tr', 'transports', 'transport'] },
    { key: 'colony_ships', synonyms: ['cs', 'colony ships', 'colony'] },
    { key: 'destroyers',   synonyms: ['ds', 'destroyers', 'destroyer'] },
    { key: 'cruisers',     synonyms: ['cr', 'cruisers', 'cruiser'] },
    { key: 'battleships',  synonyms: ['bs', 'battleships', 'battleship'] },
];

// Map the fleet sub-table's ship columns from its own `.head` row.
// Returns null when the header is missing or only partially matched — a partial match is
// treated as no match, because mixing header and positional addressing is how plausible
// numbers end up in the wrong fields.
function fleetColumnMap(fleetTable, report) {
    if (!fleetTable || typeof fleetTable.querySelector !== 'function') return null;
    const head = fleetTable.querySelector('tr.head');
    if (!head) return null;
    const cells = head.querySelectorAll('th, td');
    const map = {};
    let hits = 0;
    for (const col of FLEET_COLUMNS) {
        let idx = -1;
        for (let i = 0; i < cells.length; i++) {
            if (matchesLabel(cells[i].innerText, col.synonyms)) { idx = i; break; }
        }
        map[col.key] = idx;
        if (idx >= 0) hits++;
    }
    if (hits === FLEET_COLUMNS.length) return map;
    if (hits > 0) report.problem('fleet sub-table header only partially matched', `${hits}/${FLEET_COLUMNS.length}`);
    return null;
}

export async function runMassScan(updateProgressCb) {
    console.log("[Mass Scan] Initiating sequence...");

    try {
        updateProgressCb("Updating Galaxy Index...", 0, 0);
        const calcRes = await gameFetch('/About/TravelTimeCalculator');
        const calcHtml = await calcRes.text();
        const calcDoc = new DOMParser().parseFromString(calcHtml, 'text/html');
        
        const select = calcDoc.getElementById('FromSolarSystemId');
        if (select) {
            const systems = [];
            const indexReport = new ScrapeReport('galaxy index');
            select.querySelectorAll('option[value]:not([value=""])').forEach(opt => {
                indexReport.tryRow(() => {
                    const id = parseInt(opt.value, 10);
                    const text = opt.innerText.trim();
                    const bracketStart = text.indexOf('[');
                    const parenStart = text.lastIndexOf('(');
                    const parenEnd = text.lastIndexOf(')');
                    if (bracketStart === -1 || parenStart === -1 || parenEnd === -1) {
                        indexReport.problem('system option not in "Name [tag] (x/y)" shape', text.slice(0, 40));
                        return false;
                    }
                    const namePart = text.substring(0, bracketStart).trim();
                    const coords = text.substring(parenStart + 1, parenEnd).replace(/[−—–]/g, '-').split('/');
                    if (coords.length !== 2 || !namePart) {
                        indexReport.problem('system option without usable coordinates', text.slice(0, 40));
                        return false;
                    }
                    systems.push({ id, name: namePart, x: parseInt(coords[0], 10), y: parseInt(coords[1], 10) });
                    return true;
                }, 'system option');
            });
            indexReport.finish();

            // A dropdown full of options that produced no systems means the option format
            // changed. Overwriting the galaxy index with nothing would be far worse than
            // keeping yesterday's coordinates, so refuse.
            if (indexReport.emptyFromNonEmpty) {
                updateProgressCb(`Galaxy index parse failed (0 of ${indexReport.rowsSeen} entries)`, 0, 0);
                return;
            }

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

        // One tally for the whole galaxy sweep. A scan that silently dropped rows used to
        // finish with the same "Scan Complete!" as a clean one.
        const scanReport = new ScrapeReport('galaxy scan');
        let systemsWithNothing = 0;

        for (let i = 0; i < total; i++) {
            const sysId = sysIds[i];
            updateProgressCb(`Scanning System #${sysId}...`, i + 1, total);

            const mapRes = await gameFetch(`/Game/Map/SolarSystem/${sysId}`);
            const mapHtml = await mapRes.text();
            const doc = new DOMParser().parseFromString(mapHtml, 'text/html');

            const rows = doc.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
            const planets = [];
            const fleets = [];

            rows.forEach(row => {
                scanReport.tryRow(() => {
                    const gamePlanetId = parseInt(row.getAttribute('data-planet-id'), 10);
                    const tds = row.querySelectorAll('td');
                    if (tds.length < 3) { scanReport.problem('planet row too short', `${tds.length} cells`); return false; }

                    // Index cell can carry hub-injected badges (e.g. "10caveman: next") —
                    // take only the LEADING digits so injected text/numbers never leak in.
                    const idxMatch = (tds[0].textContent || '').trim().match(/^\d+/);
                    const planetIndex = idxMatch ? parseInt(idxMatch[0], 10) : NaN;
                    // Skip rows with an unusable id/index so we never store impossible values.
                    if (!Number.isInteger(gamePlanetId) || gamePlanetId <= 0) {
                        scanReport.problem('planet row with an unusable data-planet-id', String(gamePlanetId));
                        return false;
                    }
                    if (!Number.isInteger(planetIndex) || planetIndex < 1 || planetIndex > 99) {
                        scanReport.problem('planet row with an unusable index', String(planetIndex));
                        return false;
                    }
                    const population = parseLocaleInt(tds[1].innerText);
                    const starbase = parseLocaleInt(tds[2].innerText);

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
                    // "Unknown" is an English string; the rocket icon and the absence of an
                    // owner link are not, so treat a missing owner link as unknown too.
                    const isUnknown = !ownerLink || containsLabel(tds[3].innerText, ['unknown']);
                    planets.push({ game_planet_id: gamePlanetId, planet_index: planetIndex, population, starbase, owner, has_fleet: hasFleet ? 1 : 0, is_unknown: isUnknown });

                    const nextRow = row.nextElementSibling;
                    if (nextRow && nextRow.classList.contains(`fleetsPlanet${gamePlanetId}`)) {
                        const fleetTable = nextRow.querySelector('table');
                        const colMap = fleetColumnMap(fleetTable, scanReport);
                        const fleetRows = nextRow.querySelectorAll('table tbody tr:not(.head)');
                        fleetRows.forEach(fRow => {
                            // This used to be a bare catch {} — a fleet row that threw
                            // vanished and the scan still reported success.
                            scanReport.tryRow(() => {
                                const fTds = fRow.querySelectorAll('td');
                                if (fTds.length < 6) {
                                    scanReport.problem('fleet row too short', `${fTds.length} cells`);
                                    return false;
                                }
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

                                // Ship counts by header when the sub-table has one, by
                                // offset otherwise. fTds[1..5] on its own shifted every
                                // ship count by one the moment a column was inserted.
                                const ships = {};
                                FLEET_COLUMNS.forEach((col, i) => {
                                    const idx = colMap ? colMap[col.key] : i + 1;
                                    ships[col.key] = fTds[idx] ? parseLocaleInt(fTds[idx].innerText) : 0;
                                });

                                fleets.push({
                                    game_fleet_id: gameFleetId,
                                    owner_id: fleetOwnerId,
                                    planet_index: planetIndex,
                                    ...ships,
                                    arrival_time: arrival_time,
                                    arrival_at: parseArrivalToISO(arrival_time)
                                });
                                return true;
                            }, 'fleet row');
                        });
                    }
                    return true;
                }, 'planet row');
            });

            if (planets.length > 0) {
                await fetch('/hub-api/sync/system', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ system_id: sysId, planets, fleets, scan_mode: 'galaxy' })
                });
            } else if (rows.length > 0) {
                // The page had planet rows and none of them parsed. Not syncing is right,
                // but staying silent about it is what let a broken scan look complete.
                systemsWithNothing++;
                scanReport.problem('system produced no planets from a non-empty table', `system ${sysId}`);
            }

            // Pacing is handled centrally by the 5-per-second game gate.
        }

        const result = scanReport.finish();
        document.getElementById('scan-progress-bar').style.width = '100%';

        // The final message now carries the tally instead of an unconditional success.
        if (!result.ok || scanReport.rowsSkipped > 0 || systemsWithNothing > 0) {
            const extra = systemsWithNothing ? `, ${systemsWithNothing} system(s) yielded nothing` : '';
            updateProgressCb(`Scan finished with problems: ${result.line}${extra}`, total, total);
        } else {
            updateProgressCb(`Scan Complete! ${scanReport.rowsParsed} rows from ${total} systems`, total, total);
        }

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
            
            const rankRes = await gameFetch(`/Ranking/EcoBonus?pageNumber=${currentPage}`);
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
            // Pacing is handled centrally by the 5-per-second game gate. 
        }

        const total = playerIds.length;
        if (!total) { 
            updateProgressCb("Error: No players found in Ranking", 0, 0); 
            return; 
        }

        console.log(`[Mass Scan] Index compiled. Deep scanning ${total} players...`);
        const rankScan = new ScrapeReport('ranking player scan');

        for (let i = 0; i < total; i++) {
            const playerId = playerIds[i];
            updateProgressCb(`Scanning Player #${playerId}...`, i + 1, total);

            const res = await gameFetch(`/Game/Players/Profile/${playerId}`);
            if (!res.ok) {
                rankScan.row(false);
                rankScan.problem('profile fetch failed', `player ${playerId} -> HTTP ${res.status}`);
                continue;
            }

            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            const playerReport = new ScrapeReport(`player ${playerId}`);
            const p = extractPlayerData(playerId, doc, playerReport);
            delete p.scrapeReport;
            if (!playerReport.ok) rankScan.problem('player profile degraded', playerReport.summary());

            // --- ADDED LOGIC: Read infrastructure history (Total pop, factories, etc.) ---
            try {
                const statsUrl = buildSecuredStatsUrl(playerId);
                const statsResponse = await gameFetch(statsUrl);
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
                rankScan.row(playerReport.ok);
            } else {
                rankScan.row(false);
                rankScan.problem('profile had no name — not synced', `player ${playerId}`);
            }
            // No sleep here any more: every request to the game goes through the
            // shared 5-per-second gate, which bounds the whole process rather than one loop.
        }
        const rankResult = rankScan.finish();
        updateProgressCb(rankResult.ok
            ? `Player Scan Complete! ${rankScan.rowsParsed}/${rankScan.rowsSeen} profiles`
            : `Scan finished with problems: ${rankResult.line}`, total, total);
    } catch (err) {
        console.error("[Mass Scan] Fatal Error", err);
        updateProgressCb("Scan Failed. Check Console.", 0, 0);
    }
}

export async function scanPlayerList(playerIds, updateProgressCb) {
    console.log(`[Mass Scan] Scanning ${playerIds.length} specific players...`);
    const total = playerIds.length;
    const playerScan = new ScrapeReport('player list scan');

    if (!total) {
        updateProgressCb("Error: No players to scan", 0, 0);
        return;
    }

    for (let i = 0; i < total; i++) {
        const playerId = playerIds[i];
        updateProgressCb(`Scanning Player #${playerId}...`, i + 1, total);

        const res = await gameFetch(`/Game/Players/Profile/${playerId}`);
        if (!res.ok) continue; 
        
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const playerReport = new ScrapeReport(`player ${playerId}`);
        const p = extractPlayerData(playerId, doc, playerReport);
        delete p.scrapeReport;
        if (!playerReport.ok) {
            playerScan.row(false);
            playerScan.problem('player profile degraded', playerReport.summary());
        }

        // -- Use the previously prepared infrastructure fetch (buildSecuredStatsUrl) --
        try {
            const statsUrl = buildSecuredStatsUrl(playerId);
            const statsResponse = await gameFetch(statsUrl);
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
        } catch (e) {
            // Was a bare catch {}. The infrastructure history is optional, so this is not
            // fatal — but a run where it failed for every player should say so.
            playerScan.problem('infrastructure history fetch failed', e.message);
        }
        // -----------------------------------------------------------------------------------

        if (p.name) {
            await fetch('/hub-api/sync/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
            if (playerReport.ok) playerScan.row(true);
        } else {
            playerScan.row(false);
            playerScan.problem('profile had no name — not synced', `player ${playerId}`);
        }

        // Pacing is handled centrally by the 5-per-second game gate.
    }
    const playerResult = playerScan.finish();
    updateProgressCb(playerResult.ok
        ? `Alliance Scan Complete! ${playerScan.rowsParsed}/${playerScan.rowsSeen} profiles`
        : `Scan finished with problems: ${playerResult.line}`, total, total);
}