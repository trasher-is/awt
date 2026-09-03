import { initPlanetPopTimers, initScienceCultureCalc, initAllianceNewsAlerts, initStarbaseTimer, initScienceTimers, initScienceLevelCalculator, initProfilePLGrowth, initProfileHubIntel, initFleetTimers, initAutoProduceFinishDates, initColonizeLaunchWindows, initAllianceRelationIcons } from './page-injections.js';
import { initNewsIncomingTools } from '../ui/news-incoming.js';
import { initNewsBattleEvents } from '../ui/news-battle-events.js';
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

export function initSpy() {
    let currentMapX = null;
    let currentMapY = null;
    let verifiedPlayerName = null;
    let knownSysIdsCache = null;
    let alliedSysIdsCache = null;
    let alliedPlayerNamesCache = new Set();
    let isFetchingSystems = false;
    let simulatedSystemId = null;
    let lastScrapedUrl = null;

    // Counters, so "is this actually cheaper?" has an answer instead of an opinion.
    // Readable from the console as window.__awtSpyStats.
    const spyStats = {
        startedAt: Date.now(),
        viewPasses: 0,        // times the per-view hooks ran
        layoutReads: 0,       // times the map scale was actually measured (reflow)
        mutationBursts: 0,    // observer callbacks that survived the debounce
        mutationsIgnored: 0,  // callbacks suppressed as our own injections
        navigations: 0,
        get perSecond() { return +(this.viewPasses / ((Date.now() - this.startedAt) / 1000)).toFixed(3); }
    };
    if (typeof window !== 'undefined') window.__awtSpyStats = spyStats;

    // A token that changes when the visible view changes. Used to invalidate cached
    // layout measurements and to skip repeat work for a view already processed.
    const viewToken = () => window.location.pathname + window.location.search;

    // Layout reads are cached per view. This function reads offsetLeft/offsetTop inside a
    // nested loop, which forces a reflow every time, and injectMapIndicators() calls it up
    // to twice per pass. The scale only changes when the view changes or the window is
    // resized, so compute it once and reuse it until one of those happens.
    let mapScaleCache = { token: null, value: null };
    function invalidateLayoutCache() { mapScaleCache = { token: null, value: null }; }

    function calculateMapScaleFromOffset() {
        const token = viewToken();
        if (mapScaleCache.token === token) return mapScaleCache.value;
        const value = computeMapScaleFromOffset();
        mapScaleCache = { token, value };
        return value;
    }

    function computeMapScaleFromOffset() {
        spyStats.layoutReads++;
        const nodes = Array.from(document.querySelectorAll('.map-planet'));
        if (nodes.length < 2) return null;

        for (let i = 0; i < nodes.length; i++) {
            const spanA = nodes[i].querySelector('span');
            if (!spanA) continue;
            const matchA = spanA.innerText.match(/\[(\d+)\]/);
            if (!matchA) continue;
            const coordsA = window.allSystemsCoordsCacheMap?.[matchA[1]];
            if (!coordsA || coordsA.x === null || coordsA.y === null) continue;
            
            for (let j = i + 1; j < nodes.length; j++) {
                const spanB = nodes[j].querySelector('span');
                if (!spanB) continue;
                const matchB = spanB.innerText.match(/\[(\d+)\]/);
                if (!matchB) continue;
                const coordsB = window.allSystemsCoordsCacheMap?.[matchB[1]];
                if (!coordsB || coordsB.x === null || coordsB.y === null) continue;
                
                const dxCoords = Math.abs(coordsA.x - coordsB.x);
                const dyCoords = Math.abs(coordsA.y - coordsB.y);
                
                if (dxCoords > 0 || dyCoords > 0) {
                    const dxPixels = Math.abs(nodes[i].offsetLeft - nodes[j].offsetLeft);
                    const dyPixels = Math.abs(nodes[i].offsetTop - nodes[j].offsetTop);
                    
                    if (dxCoords > 0 && dxPixels > 0) return dxPixels / dxCoords;
                    if (dyCoords > 0 && dyPixels > 0) return dyPixels / dyCoords;
                }
            }
        }
        return null;
    }

    async function injectMapIndicators() {
        if (knownSysIdsCache === null && !isFetchingSystems) {
            isFetchingSystems = true;
            try {
                const [sysRes, plnRes, fltRes, memRes] = await Promise.all([
                    fetch('/hub-api/intel/systems_db'),
                    fetch('/hub-api/intel/planets_db'),
                    fetch('/hub-api/intel/fleets_db'),
                    fetch('/hub-api/intel/members')
                ]);

                const sysData = await sysRes.json();
                const plnData = await plnRes.json();
                const fltData = await fltRes.json();
                const memData = await memRes.json();

                if (memData.success) {
                    alliedPlayerNamesCache = new Set(memData.members.map(m => m.toLowerCase()));
                }

                if (sysData.success) {
                    knownSysIdsCache = new Set(sysData.systems.map(s => String(s.id)));
                    alliedSysIdsCache = new Set();

                    window.allSystemsCoordsCacheMap = {};
                    sysData.systems.forEach(s => {
                        window.allSystemsCoordsCacheMap[String(s.id)] = { x: s.x, y: s.y };
                    });

                    if (plnData.success) {
                        plnData.planets.forEach(p => {
                            if (p.owner_name && alliedPlayerNamesCache.has(p.owner_name.toLowerCase())) {
                                alliedSysIdsCache.add(String(p.system_id));
                            }
                        });
                    }

                    if (fltData.success) {
                        fltData.fleets.forEach(f => {
                            if (f.owner_name && alliedPlayerNamesCache.has(f.owner_name.toLowerCase())) {
                                alliedSysIdsCache.add(String(f.system_id));
                            }
                        });
                    }
                } else {
                    knownSysIdsCache = new Set();
                    alliedSysIdsCache = new Set();
                }
            } catch (err) {
                knownSysIdsCache = new Set();
                alliedSysIdsCache = new Set();
            }
            isFetchingSystems = false;
        }

        if (!knownSysIdsCache) return;

        // --- MAP NODE ASSET INDICATOR INJECTION BLOCK ---
        const systemNodes = document.querySelectorAll('.map-planet:not([data-hub-tagged="true"])');

        systemNodes.forEach(node => {
            node.setAttribute('data-hub-tagged', 'true');
            
            const span = node.querySelector('span');
            if (!span) return;
            const match = span.innerText.match(/\[(\d+)\]/);
            if (!match) return;
            const sysId = match[1];

            node.style.pointerEvents = 'auto !important';
            node.style.cursor = 'crosshair';

            node.addEventListener('click', (e) => {
                const isClickable = !!node.querySelector('.link');
                if (!isClickable) {
                    e.preventDefault();
                    e.stopPropagation();
                }

                simulatedSystemId = sysId;
                sendContext();

                try {
                    if (typeof window.parent.toggleSidebar === 'function') {
                        const sidebar = window.parent.document.getElementById('sidebar');
                        if (sidebar && !sidebar.classList.contains('expanded')) window.parent.toggleSidebar();
                        
                        if (typeof window.parent.closeSystemDatabasePanel === 'function') window.parent.closeSystemDatabasePanel();
                        if (typeof window.parent.closePlanetDatabasePanel === 'function') window.parent.closePlanetDatabasePanel();
                        if (typeof window.parent.closeFleetDatabasePanel === 'function') window.parent.closeFleetDatabasePanel();
                        if (typeof window.parent.closeDatabasePanel === 'function') window.parent.closeDatabasePanel();
                    }
                } catch (err) { /* Cross-origin frame safety fallback */ }
            }, { capture: true }); 

            if (knownSysIdsCache.has(sysId)) {
                const icon = node.querySelector('img') || node;

                // Default tracking profile — the "target system" white-highlight variant
                // this used to branch to only applied while the searched-player-vision
                // feature was active (removed; the game now shows this natively).
                icon.style.boxShadow = '0 0 4px 1px rgba(34, 197, 94, 0.3)';
                icon.style.borderRadius = '50%';
                icon.style.border = '1px solid rgba(34, 197, 94, 0.5)';
                span.style.color = 'rgba(74, 222, 128, 0.7)';
                span.style.fontWeight = 'normal';
                span.style.fontSize = '';
                span.style.textShadow = '';
            }
        });
    }

    async function backgroundIdentityCheck() {
        if (verifiedPlayerName) return; 
        try {
            const response = await gameFetch('/Game/Players');
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const nameNode = doc.querySelector('th span a[href^="/Game/Players/Profile/"]');
            if (nameNode) {
                verifiedPlayerName = nameNode.innerText.trim();
                sendContext(); 
            }
        } catch (error) {}
    }

    backgroundIdentityCheck();

    function extractCoords(urlStr) {
        try {
            if (!urlStr) return false;
            const search = urlStr.includes('?') ? urlStr.split('?')[1] : '';
            if (!search) return false;
            
            const params = new URLSearchParams(search);
            const x = params.get('centerX') || params.get('centerx');
            const y = params.get('centerY') || params.get('centery');
            if (x && y) {
                if (currentMapX !== x || currentMapY !== y) simulatedSystemId = null; 
                currentMapX = x;
                currentMapY = y;
                return true;
            }
        } catch(e) {}
        return false;
    }

    function sendContext() {
        const currentUrl = window.location.pathname + window.location.search;
        const pathLower = currentUrl.toLowerCase();
        
        extractCoords(currentUrl);

        let isSystemView = pathLower.includes('/game/map/solarsystem') || pathLower.includes('/game/system');
        let sysId = null;

        if (isSystemView) {
            const match = pathLower.match(/solarsystem\/(\d+)/) || pathLower.match(/\/system\/(\d+)/);
            if (match) sysId = match[1];
            else {
                const urlParams = new URLSearchParams(window.location.search);
                sysId = urlParams.get('id') || urlParams.get('system');
            }
        }

        if (simulatedSystemId) {
            isSystemView = true;
            sysId = simulatedSystemId;
        }

        const isPlayerView = pathLower.includes('/game/players/profile/');
        let targetPlayerId = null;
        if (isPlayerView) {
            const match = pathLower.match(/\/profile\/(\d+)/);
            if (match) targetPlayerId = match[1];
        }

        const isAllianceView = pathLower.includes('/game/alliance');
        const isCalculatorView = pathLower.includes('/about/traveltimecalculator');

        const contextPayload = {
            path: currentUrl,
            isSystemView: isSystemView, 
            isMap: pathLower.includes('/game/map'),
            isAllianceView: isAllianceView,
            isCalculatorView: isCalculatorView,
            systemId: sysId,
            mapX: currentMapX,
            mapY: currentMapY,
            playerName: verifiedPlayerName 
        };
        
        try {
            window.parent.postMessage({ type: 'GAME_CONTEXT', payload: contextPayload }, window.location.origin);
        } catch (e) {
            // Was a bare catch {}. The parent frame can legitimately be gone (the tab is
            // closing) so this must not throw, but a persistent failure here means the
            // dashboard has stopped receiving context and should not be invisible.
            console.warn('[Spy] Could not post context to the parent frame:', e.message);
        }

        const currentFullUrl = window.location.href; 
        if (currentFullUrl !== lastScrapedUrl) {
            lastScrapedUrl = currentFullUrl;

            if (isSystemView && sysId && !simulatedSystemId) {
                import('../scrapers/system-parser.js')
                    .then(module => module.scrapeSystem(sysId))
                    .catch(err => console.error(err));
            }

            if (isPlayerView && targetPlayerId) {
                import('../scrapers/player-parser.js')
                    .then(module => module.scrapePlayer(targetPlayerId))
                    .catch(err => console.error(err));
            }

            if (isAllianceView) {
                import('../scrapers/alliance-parser.js')
                    .then(module => module.scrapeAlliance())
                    .catch(err => console.error(err));
            }

            if (isCalculatorView) {
                import('../scrapers/galaxy-parser.js')
                    .then(module => module.scrapeGalaxy())
                    .catch(err => console.error(err));
            }

            if (pathLower.includes('/game/trade/agreements')) {
                import('../scrapers/trade-agreements-parser.js')
                    .then(module => module.scrapeTradeAgreements())
                    .catch(err => console.error(err));
            } else if (pathLower.includes('/game/trade')) {
                import('../scrapers/trade-parser.js')
                    .then(module => module.scrapeTradePrices())
                    .catch(err => console.error(err));
                import('../scrapers/trade-inventory-parser.js')
                    .then(module => module.scrapeTradeInventory())
                    .catch(err => console.error(err));
            }
        }
    }

    sendContext();

    // These two were already patched, but only to catch map coordinate changes; the
    // 200 ms interval was what noticed every other navigation. They now drive the view
    // hooks as well, which is what let the interval go.
    //
    // extractCoords() is still called first because it updates currentMapX/currentMapY,
    // which sendContext() reads.
    const originalReplaceState = history.replaceState;
    history.replaceState = function (state, title, url) {
        originalReplaceState.apply(this, arguments);
        if (url && typeof url === 'string') extractCoords(url);
        onNavigate();
    };

    const originalPushState = history.pushState;
    history.pushState = function (state, title, url) {
        originalPushState.apply(this, arguments);
        if (url && typeof url === 'string') extractCoords(url);
        onNavigate();
    };

    function updateTabTitle() {
        try {
            const currentUrl = window.location.pathname + window.location.search;
            const pathLower = currentUrl.toLowerCase();
            let title = 'Alliance Hub';

            if (pathLower.includes('/game/map/solarsystem') || pathLower.includes('/game/system')) {
                const header = document.querySelector('h5, h4, h3');
                if (header) {
                    const clone = header.cloneNode(true);
                    clone.querySelectorAll('.aw-synced, .badge').forEach(el => el.remove());
                    const sysName = clone.innerText
                        .replace(/Solar System/i, '')
                        .replace(/System View/i, '')
                        .replace(/Planets at/i, '') 
                        .trim();
                    title = `AW - ${sysName}`;
                } else {
                    const match = pathLower.match(/solarsystem\/(\d+)/) || pathLower.match(/\/system\/(\d+)/);
                    title = match ? `AW System #${match[1]}` : 'AW System';
                }
            } else if (pathLower.includes('/game/news/privatemessages')) {
                title = 'AW Messages';
            } else if (
                pathLower.includes('/game/planets/planet/') || 
                pathLower.includes('/game/planets/spendpoints/') || 
                pathLower.includes('/game/planets/spendmultiplepoints/') || 
                pathLower.includes('/game/planets/changeautoproduce/')
            ) {
                const header = document.querySelector('h3, h4, h5');
                if (header) {
                    const clone = header.cloneNode(true);
                    clone.querySelectorAll('.aw-synced, .badge').forEach(el => el.remove());
                    const planetDetails = clone.innerText
                        .replace(/Manage Planet/i, '')
                        .replace(/Spend Points on/i, '')
                        .replace(/Spend Multiple Points on/i, '')
                        .replace(/Change Auto Produce/i, '')
                        .replace(/Planet/i, '') 
                        .trim();
                    title = `AW ${planetDetails}`;
                } else {
                    title = 'AW Planet View';
                }
            } else if (pathLower.includes('/game/players/profile/')) {
                const nameLink = document.querySelector('th[colspan="2"] a[href^="/Game/Players/Profile/"]');
                if (nameLink) {
                    title = `AW ${nameLink.innerText.trim()}`;
                } else {
                    title = 'AW Player Profile';
                }
            } else if (pathLower.includes('/game/map')) {
                title = 'AW Map';
            } else if (pathLower.includes('/game/news')) {
                title = 'AW News';
            } else if (pathLower.includes('/game/planets')) {
                title = 'AW Planets';
            } else if (pathLower.includes('/game/science')) {
                title = 'AW Science';
            } else if (pathLower.includes('/game/fleets') || pathLower.includes('/game/fleet')) {
                title = 'AW Fleet';
            } else if (pathLower.includes('/game/trade')) {
                title = 'AW Trade';
            } else if (pathLower.includes('/game/alliance')) {
                title = 'AW Alliance';
            } else if (pathLower.includes('/game/players')) {
                title = 'AW Players';
            }

            if (document.title !== title) document.title = title;
            
            if (window.parent && window.parent !== window) {
                try {
                    if (window.parent.document && window.parent.document.title !== title) {
                        window.parent.document.title = title;
                    }
                } catch (securityErr) { /* Safely swallow cross-origin blocks */ }
            }
        } catch (err) {
            console.error('[Spy] Title synchronization error:', err);
        }
    }

    // ─── VIEW HOOKS ───────────────────────────────────────────────────────────
    // This used to be a setInterval(..., 200) running for the entire life of the game
    // frame: five passes per second, forever, each one cloning a node and reading
    // innerText, reading offsetLeft/offsetTop, and on the map iterating every
    // .map-planet — all layout-forcing. The same lesson is already recorded in
    // public/userscripts/redzone-qol.user.js, where a loop like this was removed for
    // causing hangs; it never made it back here.
    //
    // Nothing in that loop needed polling. Two events cover it:
    //   • navigation — history.pushState/replaceState (already patched below for
    //     coordinates, now driving everything) plus popstate and hashchange;
    //   • content appearing after navigation — a MutationObserver, which sees every DOM
    //     change rather than sampling for one five times a second.
    //
    // There is no interval left at all.

    let lastUrl = viewToken();

    // Our own injections mutate the DOM. Without this guard the observer would react to
    // its own output and spin.
    let injecting = false;

    function runViewHooks() {
        if (injecting) return;
        injecting = true;
        spyStats.viewPasses++;
        try {
            const pathLower = viewToken().toLowerCase();

            if (pathLower.includes('/game/map')) {
                injectMapIndicators();
            }
            if (pathLower.includes('/game/news')) {
                initAllianceNewsAlerts();
                initNewsIncomingTools();
                initNewsBattleEvents().catch(err => console.error('[News] battle-events scrape failed:', err.message));
            }
            if (pathLower.includes('/game/planets')) {
                initPlanetPopTimers();
            }
            if (pathLower.includes('/game/science')) {
                initScienceCultureCalc();
                initScienceTimers();
                initScienceLevelCalculator();
                initColonizeLaunchWindows().catch(err => console.error('[Spy] colonize launch windows failed:', err.message));
            }
            if (pathLower.includes('/game/planets/planet/')) {
                initStarbaseTimer();
                initAutoProduceFinishDates();
            }
	    if (pathLower.includes('/game/fleets')) {
                initFleetTimers();
            }
            if (pathLower.includes('/game/players/profile/')) {
                initProfilePLGrowth();
                initProfileHubIntel().catch(err => console.error('[Spy] profile hub-intel injection failed:', err.message));
            }

            // Ungated — every AW page that renders a [TAG] link uses the exact same DOM
            // pattern, so this runs everywhere rather than being gated to one path.
            initAllianceRelationIcons().catch(err => console.error('[Spy] alliance relation icons failed:', err.message));

            updateTabTitle();
        } catch (err) {
            console.error('[Spy] View hook failed:', err);
        } finally {
            // Release on the next frame: the hooks above append nodes synchronously, and
            // the observer callback for those appends is delivered afterwards. Clearing
            // the flag immediately would let our own output trigger another pass.
            requestAnimationFrame(() => { injecting = false; });
        }
    }

    function onNavigate() {
        const currentUrl = viewToken();
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            spyStats.navigations++;
            invalidateLayoutCache();
            sendContext();
        }
        runViewHooks();
    }

    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    // A resize changes pixel geometry without changing the URL, so the cached map scale
    // has to go even though the view did not.
    window.addEventListener('resize', () => { invalidateLayoutCache(); scheduleViewHooks(); });

    // Debounced observer. The game renders asynchronously, so the interesting DOM arrives
    // some time after the navigation event; a trailing debounce lets a burst of mutations
    // settle into one pass.
    let hookTimer = null;
    function scheduleViewHooks(delay = 150) {
        clearTimeout(hookTimer);
        hookTimer = setTimeout(() => { hookTimer = null; onNavigate(); }, delay);
    }

    const observer = new MutationObserver((records) => {
        if (injecting) { spyStats.mutationsIgnored++; return; }
        // Ignore mutations that are only our own markers being added or removed.
        const OURS = /^(aw-|awt-|custom-)/;
        const relevant = records.some(r => {
            if (r.type === 'attributes') return r.attributeName !== 'data-hub-tagged';
            const nodes = [...r.addedNodes, ...r.removedNodes];
            if (nodes.length === 0) return true;
            return nodes.some(n => !(n.classList && [...n.classList].some(c => OURS.test(c))));
        });
        if (!relevant) { spyStats.mutationsIgnored++; return; }
        spyStats.mutationBursts++;
        scheduleViewHooks();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // First pass for the view we loaded into.
    runViewHooks();

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;

        if (data.type === 'INJECT_TACTICAL_OVERLAYS') {
            const { plans, planets: apiPlanets } = data.payload; 
            
            // Clear out indicators and legacy components cleanly to avoid duplication
            document.querySelectorAll('.aw-hub-indicator, .awt-persistent-pill').forEach(el => el.remove());
            document.querySelectorAll('#solarSystem tr').forEach(row => { row.style.borderLeft = ''; });

            if (!document.querySelector('link[href*="font-awesome"]')) {
                const faLink = document.createElement('link');
                faLink.rel = 'stylesheet';
                faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
                document.head.appendChild(faLink);
            }

            const pathLower = (window.location.pathname + window.location.search).toLowerCase();
            const systemMatch = pathLower.match(/solarsystem\/(\d+)/) || pathLower.match(/\/system\/(\d+)/);
            const currentSystemIdStr = systemMatch ? systemMatch[1] : simulatedSystemId;
            const systemIdInt = currentSystemIdStr ? parseInt(currentSystemIdStr, 10) : null;

            const rows = document.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
            rows.forEach(row => {
                const firstCell = row.querySelector('td');
                if (!firstCell) return;
                
                const planetId = row.getAttribute('data-planet-id');
                const planetIndex = parseInt(firstCell.innerText.trim(), 10);
                if (isNaN(planetIndex)) return;

                const ownerLink = row.querySelectorAll('td')[3]?.querySelector('a[href^="/Game/Players/Profile/"]');
                const rowPlayerName = ownerLink ? ownerLink.innerText.trim().toLowerCase() : null;
                const isAlliedPlanet = rowPlayerName && alliedPlayerNamesCache.has(rowPlayerName);

                const isSieged = row.classList.contains('siege');
                const isFriendlySiege = row.classList.contains('friendly-siege');
                
                const actionCell = row.querySelectorAll('td')[4];
                if (!actionCell) return;
                
                const incomingAttack = !!actionCell.querySelector('.bi-rocket-takeoff-fill.indicator-incoming');
                const alliedTransit = !!actionCell.querySelector('.bi-rocket-takeoff-fill.indicator-incoming-friendly');
                const hostileOrbit = !!actionCell.querySelector('.bi-rocket-fill.indicator-incoming');

                let indicatorHTML = '';
                let borderColor = '';
                let titleParts = []; 
                let homeIconHtml = ''; 
                let bestGuardedHtml = ''; 

                // --- 1. CORE & CANDIDATE HOME PLANET MATCHING RULES ENGINE ---
                if (apiPlanets && Array.isArray(apiPlanets) && systemIdInt) {
                    const matchedPlanetData = apiPlanets.find(ap => ap.planet_index === planetIndex);
                    
                    if (matchedPlanetData) {
                        // Adjusted home colors: Main is Solid White, Probable alternatives are 50% White
                        if (matchedPlanetData.home_system_id === systemIdInt && matchedPlanetData.home_planet_index === planetIndex) {
                            homeIconHtml = '<i class="fa fa-house-fire ms-1 me-1" title="CRITICAL: Primary Home Base" style="font-size: 1em; vertical-align: middle; color: #ffffff !important;"></i>';
                        } else if (matchedPlanetData.possible_homes) {
                            try {
                                const options = JSON.parse(matchedPlanetData.possible_homes || '[]');
                                const isPossibleHome = options.some(opt => opt.system_id === systemIdInt && opt.planet_index === planetIndex);
                                if (isPossibleHome) {
                                    homeIconHtml = '<i class="fa fa-house-fire ms-1 me-1" style="color: #ffffff !important; opacity: 0.50; font-size: 0.85em; vertical-align: middle;" title="TACTICAL ALERT: Potential Home Swap Base"></i>';
                                }
                            } catch (err) {
                                console.error("[UI Error] Failed parsing candidate home targets:", err);
                            }
                        }

                        if (matchedPlanetData.guard_cv) {
                            // Styled: Light grey background, no border, black text
                            bestGuardedHtml = `<span class="badge ms-1 me-1" title="RANKINGS ALERT: Top 50 Best Guarded Planet" style="background: #e2e8f0 !important; color: #1e293b !important; border: none !important; font-size: 0.85em; padding: 2px 6px; vertical-align: middle; font-weight: bold;"><i class="fa-solid fa-shield-cat me-1"></i> ${matchedPlanetData.guard_cv}</span>`;
                        }
                    }
                }

                // --- 2. SUB-TABLE ROSTER TARGET INTERCEPTORS ---
                const collapseRow = document.querySelector(`.fleetsPlanet${planetId}`);
                let actualSiegerName = 'Ally';
                let enemySiegerName = 'Enemy'; 
                let attackingEnemyName = '';
                let movingAllyName = '';

                if (collapseRow) {
                    const subRows = collapseRow.querySelectorAll('tbody tr');
                    let subSectionMode = ''; 

                    subRows.forEach(r => {
                        if (r.classList.contains('head') || r.querySelector('th')) {
                            const headerText = r.innerText.trim().toLowerCase();
                            if (headerText.includes('incoming') || headerText.includes('inc')) {
                                subSectionMode = 'incoming';
                            } else if (headerText.includes('orbit')) {
                                subSectionMode = 'orbit';
                            }
                            return;
                        }

                        const pLink = r.querySelector('a[href^="/Game/Players/Profile/"]');
                        if (pLink) {
                            const parsedName = pLink.innerText.trim();
                            const isAlly = alliedPlayerNamesCache.has(parsedName.toLowerCase());

                            if (r.classList.contains('siege')) {
                                if (isAlly) actualSiegerName = parsedName;
                                else enemySiegerName = parsedName;
                            }

                            if (subSectionMode === 'incoming') {
                                if (!isAlly && !attackingEnemyName) attackingEnemyName = parsedName;
                                else if (isAlly && !movingAllyName) movingAllyName = parsedName;
                            } else if (subSectionMode === 'orbit') {
                                if (isAlly && actualSiegerName === 'Ally' && isFriendlySiege) actualSiegerName = parsedName;
                                if (!isAlly && enemySiegerName === 'Enemy' && isSieged) enemySiegerName = parsedName;
                            } else {
                                if (isAlly && actualSiegerName === 'Ally' && isFriendlySiege) actualSiegerName = parsedName;
                                if (!isAlly && enemySiegerName === 'Enemy' && isSieged) enemySiegerName = parsedName;
                                if (!isAlly && !attackingEnemyName && incomingAttack) attackingEnemyName = parsedName;
                            }
                        }
                    });
                }

                // --- 3. COMBAT OVERLAY MULTI-STACK ENGINE (WHITE PILLS, RED/GREEN TEXT) ---
                if (isSieged) {
                    const siegeLabel = enemySiegerName !== 'Enemy' ? `${enemySiegerName}` : 'Siege';
                    indicatorHTML += `<span class="badge ms-2 text-nowrap" style="background-color: #e0e0e0 !important; color: #dc3545 !important; font-weight: bold; border: 1px solid #dc3545 !important; font-size: 0.7em; padding: 2px 6px; vertical-align: middle;"><i class="fa-solid fa-person me-1"></i>${siegeLabel}</span>`;
                    borderColor = '#b17608';
                    titleParts.push(`Enemy Siege by ${enemySiegerName}`);
                }

                if (isFriendlySiege) {
                    indicatorHTML += `<span class="badge ms-2 text-nowrap" style="background-color: #e0e0e0 !important; color: #07832c !important; font-weight: bold; border: 1px solid #07832c !important; font-size: 0.7em; padding: 2px 6px; vertical-align: middle;"><i class="fa-solid fa-person me-1"></i>${actualSiegerName}</span>`;
                    if (!borderColor || borderColor === '#ffc107') borderColor = '#07832c';
                    titleParts.push(`Allied Siege by ${actualSiegerName}`);
                }

                if (incomingAttack) {
                    const attackLabel = attackingEnemyName ? `${attackingEnemyName}` : 'Attack';
                    indicatorHTML += `<span class="badge ms-2 text-nowrap" style="background-color: #e0e0e0 !important; color: #dc3545 !important; font-weight: bold; border: 1px solid #dc3545 !important; font-size: 0.7em; padding: 2px 6px; vertical-align: middle;"><i class="fa-solid fa-person-rifle me-1"></i>${attackLabel}</span>`;
                    borderColor = '#dc3545'; 
                    titleParts.push(`Hostile Inbound: ${attackingEnemyName || 'Enemy'}`);
                }

                if (hostileOrbit && isAlliedPlanet && !isSieged) {
                    indicatorHTML += '<span class="badge ms-2 text-nowrap" style="background-color: #e0e0e0 !important; color: #dc3545 !important; font-weight: bold; border: 1px solid #dc3545 !important; font-size: 0.7em; padding: 2px 6px; vertical-align: middle;"><i class="fa-solid fa-skull-crossbones me-1"></i>Hostile</span>';
                    if (!borderColor) borderColor = '#dc3545';
                    titleParts.push('Hostile Fleet in Orbit');
                }

                if (alliedTransit) {
                    const transitLabel = movingAllyName ? `${movingAllyName}` : 'Ally moving';
                    indicatorHTML += `<span class="badge ms-2 text-nowrap" style="background-color: #e0e0e0 !important; color: #07832c !important; font-weight: bold; border: 1px solid #07832c !important; font-size: 0.7em; padding: 2px 6px; vertical-align: middle;"><i class="fa-solid fa-person-walking-arrow-right me-1"></i>${transitLabel}</span>`;
                    if (!borderColor) borderColor = '#ffc107';
                    titleParts.push(`Allied Transit: ${movingAllyName || 'Ally'}`);
                }

                const planetPlans = plans.filter(p => p.planet_index === planetIndex);
                if (planetPlans.length > 0 && !indicatorHTML) { 
                    borderColor = '#f8f9fa';
                    if (planetPlans.length === 1) {
                        indicatorHTML = `<span class="badge bg-light text-dark border ms-2">Plan</span>`;
                        titleParts.push(`Intel Note: ${planetPlans[0].note} (${planetPlans[0].author})`);
                    } else {
                        indicatorHTML = planetPlans.map((p, idx) => 
                            `<span class="badge bg-light text-dark border ms-1" style="font-size: 8px; padding: 1px 3px; cursor: help;" title="[Plan ${idx + 1}] ${p.note} (${p.author})">P${idx + 1}</span>`
                        ).join('');
                    }
                }

                // --- 4. DOM INJECTION ---
                if (indicatorHTML || homeIconHtml || bestGuardedHtml) {
                    if (borderColor) row.style.borderLeft = `3px solid ${borderColor}`;
                    
                    const indicator = document.createElement('span');
                    indicator.className = 'aw-hub-indicator';
                    indicator.style.cursor = 'help';
                    if (titleParts.length > 0) indicator.title = titleParts.join(' | ');
                    
                    indicator.innerHTML = homeIconHtml + bestGuardedHtml + indicatorHTML;
                    firstCell.appendChild(indicator);
                }
            });
        }
    });
}
