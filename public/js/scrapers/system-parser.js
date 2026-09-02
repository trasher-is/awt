import { parseArrivalToISO } from '../utils/fleet-time.js';
import '../utils/scrape-report.js';
import '../utils/parse-number.js';
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const { ScrapeReport, matchesLabel, containsLabel } = globalThis.AWScrape;
const { parseLocaleInt } = globalThis.AWNumber;

// Ship columns inside a planet's fleet sub-table, matched against that table's own
// `.head` row. Reading fTds[1..5] worked only until the game inserted a column, and
// nothing would have noticed. Only wordings confirmed from the live game are listed.
const FLEET_COLUMNS = [
    { key: 'transports',   synonyms: ['tr', 'transports', 'transport'] },
    { key: 'colony_ships', synonyms: ['cs', 'colony ships', 'colony'] },
    { key: 'destroyers',   synonyms: ['ds', 'destroyers', 'destroyer'] },
    { key: 'cruisers',     synonyms: ['cr', 'cruisers', 'cruiser'] },
    { key: 'battleships',  synonyms: ['bs', 'battleships', 'battleship'] },
];

// A partial header match is treated as no match: mixing header and positional addressing
// is how plausible numbers land in the wrong fields.
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

// Pure parser: pull planets + fleets out of any system-map document (the live page or a
// fetched-and-parsed one). Used by both the on-page scraper and the off-page "Update".
export function extractSystemData(doc = document, report = new ScrapeReport('system map')) {
    const rows = doc.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
    const planets = [];
    const fleets = [];

    rows.forEach(row => {
        report.tryRow(() => {
            const gamePlanetId = parseInt(row.getAttribute('data-planet-id'), 10);
            const tds = row.querySelectorAll('td');
            // Index cell can carry hub-injected badges (e.g. "10caveman: next") — take
            // only the LEADING digits so injected text/numbers never leak into the index.
            const idxMatch = (tds[0].textContent || '').trim().match(/^\d+/);
            const planetIndex = idxMatch ? parseInt(idxMatch[0], 10) : NaN;
            // Skip rows with an unusable id/index so we never store impossible values.
            if (!Number.isInteger(gamePlanetId) || gamePlanetId <= 0) {
                report.problem('planet row with an unusable data-planet-id', String(gamePlanetId));
                return false;
            }
            if (!Number.isInteger(planetIndex) || planetIndex < 1 || planetIndex > 99) {
                report.problem('planet row with an unusable index', String(planetIndex));
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
            // "Unknown" is a REAL, permanent owner state the game itself assigns — a
            // resigned player's leftover planet, or a game-spawned Unknown (see
            // docs/game-rules.md's Colonizing section) — not fog of war. It is trustworthy
            // live data whenever this page is actually rendering (you cannot be viewing a
            // live system table without vision of it — an out-of-vision system gets the
            // hub's own "last recorded data" fallback page instead, which this scraper never
            // runs against). A bare missing owner link on its own just means Free Planet
            // (never owned, or currently unclaimed) — a completely different, ordinary state
            // that must NOT be flagged is_unknown, or the server's fog-of-war guard for the
            // OTHER, genuinely uncertain source (the out-of-vision bulk galaxy seed — see
            // vision_uncertain in api-galaxy-seed.js) would wrongly freeze real Free Planet
            // transitions too. Confirmed against a real "Unknown" cell (2026-09-02): the game
            // renders the literal word "Unknown" there, distinct from "Free Planet".
            const isUnknown = containsLabel(tds[3].innerText, ['unknown']);

            planets.push({
                game_planet_id: gamePlanetId,
                planet_index: planetIndex,
                population,
                starbase,
                owner,
                has_fleet: hasFleet ? 1 : 0,
                is_unknown: isUnknown
            });

            // --- FLEET EXTRACTION ---
            const nextRow = row.nextElementSibling;
            if (nextRow && nextRow.classList.contains(`fleetsPlanet${gamePlanetId}`)) {
                const fleetTable = nextRow.querySelector('table');
                const colMap = fleetColumnMap(fleetTable, report);
                const fleetRows = nextRow.querySelectorAll('table tbody tr:not(.head)');

                fleetRows.forEach(fRow => {
                    report.tryRow(() => {
                        const fTds = fRow.querySelectorAll('td');
                        if (fTds.length < 6) {
                            report.problem('fleet row too short', `${fTds.length} cells`);
                            return false;
                        }
                        {
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
                        }
                    }, 'fleet row');
                });
            }
            return true;
        }, 'planet row');
    });

    return { planets, fleets, report };
}

// Off-page refresh: fetch a system's map, parse it, and sync. Returns true on success.
// Runs from the dashboard (e.g. travel-calc "Update" button); no game-page DOM needed.
export async function scrapeSystemById(systemId) {
    try {
        const res = await gameFetch(`/Game/Map/SolarSystem/${systemId}`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const { planets, fleets, report } = extractSystemData(doc);
        // A map page with planet rows that produced nothing is a broken parse, not an
        // empty system. Returning false here (rather than syncing zero planets) keeps the
        // stored system intact, and the report says why.
        if (report.emptyFromNonEmpty) { report.finish(); return false; }
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

    const { planets, fleets, report } = extractSystemData(document);

    if (report.emptyFromNonEmpty) {
        const r = report.finish();
        window.parent.postMessage({ type: 'SHOW_TOAST', payload: `⚠️ System #${systemId}: ${r.line}` }, window.location.origin);
        return;
    }
    if (planets.length === 0) return;

    try {
        const response = await fetch('/hub-api/sync/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_id: parseInt(systemId, 10), planets, fleets })
        });
        
        if (response.ok) {
            const r = report.finish();
            console.log(`[Spy] System ${systemId} synced! (${planets.length} planets, ${fleets.length} fleets) ${r.line}`);

            // Tell the Wrapper to show a Toast & update stats
            window.parent.postMessage({
                type: 'SHOW_TOAST',
                payload: r.ok ? `System #${systemId} Synced` : `⚠️ System #${systemId}: ${r.line}`
            }, window.location.origin);
            
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