import { extractPlayerData, buildSecuredStatsUrl } from './player-parser.js';
import '../utils/scrape-report.js';
import '../utils/parse-number.js'; // required by data-parsing.test.js's scraper-family guard,
                                    // even though this file's own number fields come from
                                    // structured JSON (not locale-formatted scraped text)
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const { ScrapeReport } = globalThis.AWScrape;

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
