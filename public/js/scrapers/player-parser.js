// Pure data collection logic that can target any window, iframe, or virtual DOM element.
//
// Field lookups go through the shared scrape helpers rather than one hard-coded English
// string each, and every lookup is counted. A member whose game interface is not English
// used to sync a profile full of zeros with no complaint; now the miss ratio is reported.
// Numbers go through the shared locale-aware parser — the old inline regexes dropped the
// non-breaking space the game uses as a thousands separator, which made points and
// ranking come back empty.
import '../utils/scrape-report.js';
import '../utils/parse-number.js';
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const { ScrapeReport, LABELS, labelledValue, headerIndex, matchesLabel } = globalThis.AWScrape;
const { parseLocaleInt, parseLocaleNumber } = globalThis.AWNumber;

export function extractPlayerData(playerId, doc = document, report = new ScrapeReport('player profile')) {
    const p = {
        id: parseInt(playerId, 10), name: null, alliance_id: null, alliance_tag: null,
        country: null, local_time: null, idle_time: null, origin_system: null,
        joined: null, logins: 0,
        level: 0, ranking: null, points: 0, science_level: 0, culture_level: 0,
        biology: 0, economy: 0, energy: 0, mathematics: 0, physics: 0, social: 0,
        trade_revenue: 0, artefact: null, eco_bonus: 0,
        race_growth: 0, race_science: 0, race_culture: 0, race_production: 0, race_speed: 0, race_attack: 0, race_defense: 0,
        race_trader: 0, race_sul: 0,
        has_intel: 0, 
        
        // New tracking fields for tactical home planet visualization
        home_planet_id: null,
        home_system_id: null,
        home_planet_index: null,
        possible_homes: [],

        // Infrastructure Metrics (Populated later by background stats scan)
        total_planets: 0,
        total_population: 0,
        total_farms: 0,
        total_factories: 0,
        total_labs: 0,
        total_cybernetics: 0,
        cv_used: 0,
        cv_limit: 0
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

    // One lookup helper, counted. `which` names the field so a miss is reportable rather
    // than an indistinguishable empty string.
    const getRowVal = (which, synonyms, { exact = false, accept = null, optional = false } = {}) => {
        const hit = labelledValue(doc, synonyms, { exact, accept });
        if (!optional) report.label(hit.found, which);
        return hit.found ? hit.value : null;
    };

    p.local_time = getRowVal('local time', LABELS.localTime);
    p.idle_time = getRowVal('idle', LABELS.idle);
    p.joined = getRowVal('joined', LABELS.joined);
    p.logins = parseLocaleInt(getRowVal('logins', LABELS.logins));

    // Only shown on some views, so a miss here is not evidence of a broken scrape.
    p.cv_limit = parseLocaleInt(getRowVal('cv limit', LABELS.cvLimit, { optional: true }));
    p.cv_used = parseLocaleInt(getRowVal('cv used', LABELS.cvUsed, { optional: true }));

    const countryImg = doc.querySelector('img[src^="/img/country/"]');
    if (countryImg) {
        p.country = countryImg.getAttribute('alt') || countryImg.getAttribute('title');
    }

    // Origin is read from the link, not the label's neighbouring text — the system id is
    // in the href, which no translation can change.
    const originHit = labelledValue(doc, LABELS.origin, { exact: true });
    report.label(!!originHit.found, 'origin');
    const originLink = (originHit.cell && originHit.cell.querySelector)
        ? originHit.cell.querySelector('a[href^="/Game/Map/SolarSystem/"]')
        : doc.querySelector('table tbody tr a[href^="/Game/Map/SolarSystem/"]');
    if (originLink) p.origin_system = parseInt(originLink.getAttribute('href').split('/').pop(), 10);

    const lvlStr = getRowVal('player level', LABELS.playerLevel);
    if (lvlStr) p.level = parseLocaleInt(lvlStr.split('-')[0]);

    p.science_level = parseLocaleInt(getRowVal('science level', LABELS.scienceLevel));
    p.culture_level = parseLocaleInt(getRowVal('culture level', LABELS.cultureLevel));

    const rankStr = getRowVal('ranking', LABELS.ranking);
    if (rankStr) {
        // "#123 (4 567 890)" — the digits and the bracket are language-independent, but
        // the thousands separator is not, so the numbers go through the shared parser.
        const rMatch = rankStr.match(/#\s*([\d\s.,]+?)\s*\(([^)]+)\)/);
        if (rMatch) {
            p.ranking = parseLocaleInt(rMatch[1]);
            p.points = parseLocaleInt(rMatch[2]);
        } else {
            report.problem('ranking did not match the "#rank (points)" shape', rankStr.slice(0, 40));
        }
    }

    if (p.has_intel === 1) {
        // "Economy" the science level and "Economy Bonus" the percentage share a prefix,
        // so the exact match plus a no-percent guard keeps them apart.
        const noPercent = v => !v.includes('%');
        p.biology = parseLocaleInt(getRowVal('biology', LABELS.biology, { exact: true }));
        p.economy = parseLocaleInt(getRowVal('economy', LABELS.economy, { exact: true, accept: noPercent }));
        p.energy = parseLocaleInt(getRowVal('energy', LABELS.energy, { exact: true }));
        p.mathematics = parseLocaleInt(getRowVal('mathematics', LABELS.mathematics, { exact: true }));
        p.physics = parseLocaleInt(getRowVal('physics', LABELS.physics, { exact: true }));
        p.social = parseLocaleInt(getRowVal('social', LABELS.social, { exact: true }));

        const ecoBonusStr = getRowVal('economy bonus', LABELS.economyBonus, { optional: true });
        if (ecoBonusStr) p.eco_bonus = parseLocaleInt(ecoBonusStr);

        const tradeStr = getRowVal('trade revenue', LABELS.tradeRevenue, { optional: true });
        if (tradeStr) p.trade_revenue = parseLocaleInt(tradeStr);

        const artefactHit = labelledValue(doc.querySelector('.ir-summary') || doc, LABELS.artefact, { exact: false });
        if (artefactHit.found) {
            p.artefact = artefactHit.value === 'N/A' ? null : (artefactHit.value.split(/\s+/)[0] || null);
        }

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

    const planetRows = doc.querySelectorAll('tr[data-planet-id]');
    if (planetRows.length > 0) {
        // Population used to be read as tds[2]. One inserted column and every planet's
        // population became whatever now sits in slot 2 — a plausible number, stored
        // without complaint. Ask the table's own header where the column is instead.
        const planetTable = planetRows[0].closest ? planetRows[0].closest('table') : null;
        let popIdx = headerIndex(planetTable, LABELS.population);
        if (popIdx < 0) {
            popIdx = 2;
            report.problem('no Population header on the planets table — falling back to column 2', '');
        }

        const parsedPlanets = [];
        planetRows.forEach(row => {
            report.tryRow(() => {
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
                if (system_id == null) {
                    report.problem('planet row without a SolarSystem link', `planet ${game_planet_id}`);
                    return false;
                }
                const tds = row.querySelectorAll('td');
                const pop = tds[popIdx] ? parseLocaleInt(tds[popIdx].innerText) : 0;
                parsedPlanets.push({ game_planet_id, system_id, planet_index, pop });
                return true;
            }, 'planet row');
        });

        if (parsedPlanets.length > 0) {
            const mainHome = parsedPlanets[0];
            p.home_planet_id = mainHome.game_planet_id;
            p.home_system_id = mainHome.system_id;
            p.home_planet_index = mainHome.planet_index;

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

    // Planets table footer carries reliable, always-public totals (no intel needed):
    //   Sum row -> [ "Sum", "<owned> of <total>", <total population>, <total starbase> ].
    // Prefer these over the Statistic-history fetch, which can be empty/redacted.
    const sumRow = Array.from(doc.querySelectorAll('table tfoot tr'))
        .find(r => r.cells && r.cells[0] && matchesLabel(r.cells[0].innerText, LABELS.sum));
    if (sumRow && sumRow.cells.length >= 3) {
        const ownedMatch = sumRow.cells[1] ? sumRow.cells[1].innerText.match(/\d+/) : null;
        if (ownedMatch) p.total_planets = parseLocaleInt(ownedMatch[0]) || p.total_planets;
        const popCell = sumRow.cells[2] ? sumRow.cells[2].innerText : '';
        const pop = parseLocaleInt(popCell);
        if (pop) p.total_population = pop || p.total_population;
    }

    p.scrapeReport = report;
    return p;
}

// Generates the safe date URL string parameters to step backwards over obfuscation walls
export function buildSecuredStatsUrl(playerId) {
    const now = new Date();
    
    const contextFrom = new Date(now);
    contextFrom.setDate(now.getDate() - 5);
    
    const contextTo = new Date(now);
    contextTo.setDate(now.getDate() - 3);
    
    const formatDate = (d) => d.toISOString().split('T')[0];
    
    return `/Game/Players/Statistic?from=${formatDate(contextFrom)}&to=${formatDate(contextTo)}&playerId=${playerId}`;
}

export async function scrapePlayer(playerId) {
    console.log(`[Spy] Initiating deep profile parse sequence for Player ID: ${playerId}`);

    // 1. Gather baseline profile parameters synchronously
    const report = new ScrapeReport(`player ${playerId}`);
    const p = extractPlayerData(playerId, document, report);
    delete p.scrapeReport;   // never send the instrumentation to the server

    // 2. Background execute fetch over custom-calculated safe historical index boundaries
    const statsUrl = buildSecuredStatsUrl(playerId);
    console.log(`[Spy] Fetching infrastructure history matrix via endpoint: ${statsUrl}`);
    
    try {
        const statsResponse = await gameFetch(statsUrl);
        if (statsResponse.ok) {
            const htmlText = await statsResponse.text();
            
            // Regex targeting string data: var data = [ ... ];
            const dataRegexMatch = htmlText.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
            if (dataRegexMatch) {
                const infrastructureHistoryArray = JSON.parse(dataRegexMatch[1]);
                
                if (Array.isArray(infrastructureHistoryArray) && infrastructureHistoryArray.length > 0) {
                    // Extract the latest non-redacted log element entry at the tail end of the query window
                    const latestLogRecord = infrastructureHistoryArray[infrastructureHistoryArray.length - 1];
                    console.log(`[Spy] Historical infrastructure values decrypted:`, latestLogRecord);
                    
                    // Direct structural conversion mapping down into matching keys.
                    // Planets/population already come from the profile's Planets table
                    // (more current + always public) — only fall back to history if absent.
                    p.total_planets     = p.total_planets    || parseInt(latestLogRecord.count, 10) || 0;
                    p.total_population  = p.total_population  || parseInt(latestLogRecord.population, 10) || 0;
                    p.total_farms       = parseInt(latestLogRecord.farms, 10) || 0;
                    p.total_factories   = parseInt(latestLogRecord.factories, 10) || 0;
                    p.total_labs        = parseInt(latestLogRecord.labs, 10) || 0;
                    p.total_cybernetics = parseInt(latestLogRecord.cybernets, 10) || 0;
                }
            } else {
                console.warn(`[Spy] Script data block initialization line missing on target history window layout.`);
            }
        }
    } catch (statsErr) {
        console.error(`[Spy] Background infrastructure parsing failure:`, statsErr);
    }

    // 3. Post notification up to UI frame context
    window.parent.postMessage({
        type: 'GAME_CONTEXT',
        payload: {
            path: window.location.pathname,
            isPlayerView: true,
            playerId: p.id
        }
    }, window.location.origin);

    // 4. Ship structural payload transaction package directly to backend server route receiver
    try {
        const response = await fetch('/hub-api/sync/player', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(p) 
        });
        
        if (response.ok) {
            // Report BEFORE claiming success. A profile that parsed nothing used to sync a
            // row of zeros and show the same green toast as a good one.
            const result = report.finish();
            const label = result.ok
                ? `Player ${p.name} Complete Profile Synced`
                : `⚠️ Player ${p.name}: ${result.line}`;
            console.log(`[Spy] Player Profile '${p.name}' synced. ${result.line}`);
            window.parent.postMessage({ type: 'SHOW_TOAST', payload: label }, window.location.origin);
            const header = document.querySelector('th[colspan="2"] span');
            if (header && !header.querySelector('.aw-synced')) {
                header.innerHTML += ' <span class="badge bg-success ms-2 aw-synced" style="font-size: 0.6em; vertical-align: middle; background-color: #22c55e !important; color: #fff;"><i class="bi bi-cloud-check"></i> Hub Synced</span>';
            }
        }
    } catch (err) { 
        console.error(`[Spy] Player API upload transaction failed:`, err); 
    }
}