import { initPlanetPopTimers, initScienceCultureCalc, initAllianceNewsAlerts, initStarbaseTimer } from './page-injections.js';

// DELETE THIS DEAD BLOCK ENTIRELY - IT IS MISSING THE WINDOW LOAD EVENT
window.addEventListener('load', () => {
    if (window.location.pathname.includes('/Game/Planets')) initPlanetPopTimers();
    if (window.location.pathname.includes('/Game/Science')) initScienceCultureCalc();
    if (window.location.pathname.includes('Game/Planets/Planet/')) initStarbaseTimer();
});

export function initSpy() {
    let currentMapX = null;
    let currentMapY = null;
    let verifiedPlayerName = null;
    let knownSysIdsCache = null;
    let alliedSysIdsCache = null; 
    let alliedPlayerNamesCache = new Set();
    let isFetchingSystems = false;
    let simulatedSystemId = null;
    
    // NEW: Tracker to prevent duplicate scraper executions on the same page
    let lastScrapedUrl = null;

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

                if (typeof window.parent.toggleSidebar === 'function') {
                    const sidebar = window.parent.document.getElementById('sidebar');
                    if (sidebar && !sidebar.classList.contains('expanded')) window.parent.toggleSidebar();
                    
                    if (typeof window.parent.closeSystemDatabasePanel === 'function') window.parent.closeSystemDatabasePanel();
                    if (typeof window.parent.closePlanetDatabasePanel === 'function') window.parent.closePlanetDatabasePanel();
                    if (typeof window.parent.closeFleetDatabasePanel === 'function') window.parent.closeFleetDatabasePanel();
                    if (typeof window.parent.closeDatabasePanel === 'function') window.parent.closeDatabasePanel();
                }
            }, { capture: true }); 

            if (knownSysIdsCache.has(sysId)) {
    const icon = node.querySelector('img') || node; 
    
    let isBaseSystemForTarget = false;
    let isInsideTargetVisionField = false;

    if (window.activeSearchedPlayerVision && window.allSystemsCoordsCacheMap) {
        const currentSystemLocation = window.allSystemsCoordsCacheMap[sysId];
        
        // FIX 2: Strict sanitation checking on coordinate types to ensure neither is null
        if (currentSystemLocation && currentSystemLocation.x !== null && currentSystemLocation.y !== null) {
            const { range, targetSystems } = window.activeSearchedPlayerVision;

            isBaseSystemForTarget = targetSystems.some(ts => String(ts.id) === String(sysId));

            isInsideTargetVisionField = targetSystems.some(ts => {
                if (ts.x === null || ts.y === null) return false; // Fail-safe
                const horizontalDelta = currentSystemLocation.x - ts.x;
                const verticalDelta = currentSystemLocation.y - ts.y;
                const mathematicalDistance = Math.sqrt(horizontalDelta * horizontalDelta + verticalDelta * verticalDelta);
                return mathematicalDistance <= range;
            });
        }
    }

    if (isBaseSystemForTarget) {
        icon.style.boxShadow = '0 0 18px 6px #f59e0b, inset 0 0 10px #f59e0b';
        icon.style.borderRadius = '50%';
        icon.style.border = '2px solid #f59e0b';
        icon.style.backgroundColor = 'rgba(245, 158, 11, 0.4)';
        span.style.color = '#fbbf24';
        span.style.fontWeight = 'bold';
    } else if (isInsideTargetVisionField) {
        // FIX 3: Clean, high-contrast white dashed tracking boundary ring for the vision field
        icon.style.boxShadow = '0 0 12px 4px #ffffff, inset 0 0 8px #ffffff';
        icon.style.borderRadius = '50%';
        icon.style.border = '2px dashed #ffffff';
        icon.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
        span.style.color = '#ffffff';
        span.style.fontWeight = '500';
    } else if (alliedSysIdsCache.has(sysId)) {
        icon.style.boxShadow = '0 0 15px 5px #22c55e, inset 0 0 10px #22c55e';
        icon.style.borderRadius = '50%';
        icon.style.border = '2px solid #22c55e';
        icon.style.backgroundColor = 'rgba(34, 197, 94, 0.4)';
        span.style.color = '#4ade80';
        span.style.fontWeight = 'bold';
    } else {
        // Explicit layout fallback states resets
        icon.style.boxShadow = '0 0 4px 1px rgba(34, 197, 94, 0.3)';
        icon.style.borderRadius = '50%';
        icon.style.border = '1px solid rgba(34, 197, 94, 0.5)';
        span.style.color = 'rgba(74, 222, 128, 0.7)'; 
        span.style.fontWeight = 'normal';
    }
}
        });
    }

    async function backgroundIdentityCheck() {
        if (verifiedPlayerName) return; 
        try {
            const response = await fetch('/Game/Players');
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
        
        // Always send UI context to the wrapper...
        window.parent.postMessage({ type: 'GAME_CONTEXT', payload: contextPayload }, window.location.origin);

        // ...But ONLY trigger scrapers if we actually navigated to a new URL
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
        }
    }

    sendContext();

    const originalReplaceState = history.replaceState;
    history.replaceState = function(state, title, url) {
        originalReplaceState.apply(this, arguments);
        if (url && typeof url === 'string') {
            if (extractCoords(url)) sendContext();
        }
    };

    const originalPushState = history.pushState;
    history.pushState = function(state, title, url) {
        originalPushState.apply(this, arguments);
        if (url && typeof url === 'string') {
            if (extractCoords(url)) sendContext();
        }
    };

    function updateTabTitle() {
        try {
            const currentUrl = window.location.pathname + window.location.search;
            const pathLower = currentUrl.toLowerCase();
            let title = 'Alliance Hub';

            if (pathLower.includes('/game/map/solarsystem') || pathLower.includes('/game/system')) {
                // System View: Extract name and coords safely, stripping "Planets at"
                const header = document.querySelector('h5, h4, h3');
                if (header) {
                    const clone = header.cloneNode(true);
                    clone.querySelectorAll('.aw-synced, .badge').forEach(el => el.remove());
                    const sysName = clone.innerText
                        .replace(/Solar System/i, '')
                        .replace(/System View/i, '')
                        .replace(/Planets at/i, '') // Strips out the annoying prefix text
                        .trim();
                    title = `AW - ${sysName}`;
                } else {
                    const match = pathLower.match(/solarsystem\/(\d+)/) || pathLower.match(/\/system\/(\d+)/);
                    title = match ? `AW System #${match[1]}` : 'AW System';
                }
            } else if (pathLower.includes('/game/news/privatemessages')) {
                // Private Messages specific override
                title = 'AW Messages';
            } else if (
                pathLower.includes('/game/planets/planet/') || 
                pathLower.includes('/game/planets/spendpoints/') || 
                pathLower.includes('/game/planets/spendmultiplepoints/') || 
                pathLower.includes('/game/planets/changeautoproduce/')
            ) {
                // Individual Planet Focus & Action views
                const header = document.querySelector('h3, h4, h5');
                if (header) {
                    const clone = header.cloneNode(true);
                    clone.querySelectorAll('.aw-synced, .badge').forEach(el => el.remove());
                    const planetDetails = clone.innerText
                        .replace(/Manage Planet/i, '')
                        .replace(/Spend Points on/i, '')
                        .replace(/Spend Multiple Points on/i, '')
                        .replace(/Change Auto Produce/i, '')
                        .replace(/Planet/i, '') // Clean up extra game title padding text
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

            // Sync frame document title
            if (document.title !== title) document.title = title;
            
            // Sync parent extension wrapper tab title
            if (window.parent && window.parent.document && window.parent.document.title !== title) {
                window.parent.document.title = title;
            }
        } catch (err) {
            console.error('[Spy] Title synchronization error:', err);
        }
    }

    let lastUrl = window.location.pathname + window.location.search;
    setInterval(() => {
        const currentUrl = window.location.pathname + window.location.search;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            sendContext();
        }

        // Active UI Injector Loop (Fires reliably on hard loads and inner frame shifts)
        if (currentUrl.toLowerCase().includes('/game/map')) {
            injectMapIndicators();
        }
        if (currentUrl.includes('/Game/News')) {
            initAllianceNewsAlerts();
        }

        updateTabTitle();
    }, 200);

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;

        if (data.type === 'HIGHLIGHT_PLAYER_VISION') {
            const { range, systems } = data.payload;
            window.activeSearchedPlayerVision = { range, targetSystems: systems };
            
            document.querySelectorAll('.map-planet').forEach(el => el.removeAttribute('data-hub-tagged'));
            injectMapIndicators();
        } 
        // Clear lifecycle execution loop
        else if (data.type === 'CLEAR_PLAYER_VISION') {
            window.activeSearchedPlayerVision = null;
            document.querySelectorAll('.map-planet').forEach(el => el.removeAttribute('data-hub-tagged'));
            injectMapIndicators();
        }

        if (data.type === 'INJECT_TACTICAL_OVERLAYS') {
            const { plans } = data.payload; 
            
            document.querySelectorAll('.aw-hub-indicator').forEach(el => el.remove());
            document.querySelectorAll('#solarSystem tr').forEach(row => { row.style.borderLeft = ''; });

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

                // Correctly capture both types of sieges from the row classes
                const isSieged = row.classList.contains('siege');
                const isFriendlySiege = row.classList.contains('friendly-siege');
                
                const actionCell = row.querySelectorAll('td')[4];
                const actionHtml = actionCell ? actionCell.innerHTML : ''; 
                
                const incomingAttack = actionHtml.includes('Incoming hostile fleet') || actionHtml.includes('Hostile fleet incoming');
                const hostileOrbit = actionHtml.includes('Hostile fleet in orbit');
                
                // Fixed: Added specific checks for 'Incoming friendly fleet' and the takeoff icon class
                const alliedTransit = actionHtml.includes('Incoming allied') || 
                                      actionHtml.includes('Allied fleet') || 
                                      actionHtml.includes('Incoming friendly fleet') ||
                                      actionHtml.includes('bi-rocket-takeoff-fill');

                let indicatorHTML = '';
                let borderColor = '';
                let titleText = '';

                // Evaluate status indicators by technical priority
                if (isSieged) {
                    indicatorHTML = '<span class="badge bg-purple ms-2" style="background-color: #b17608; color: white;">Siege</span>';
                    borderColor = '#b17608';
                    titleText = 'Enemy Siege Detected';
                } else if (isFriendlySiege) {
                    // Scrape the sieging player's name out of the linked collapsed panel row
                    const collapseRow = document.querySelector(`.fleetsPlanet${planetId}`);
                    const siegerLink = collapseRow?.querySelector('a[href^="/Game/Players/Profile/"]');
                    const siegerName = siegerLink ? siegerLink.innerText.trim() : 'Ally';

                    indicatorHTML = `<span class="badge ms-2" style="background-color: #07832c; color: white;">${siegerName} sieging</span>`;
                    borderColor = '#07832c'; 
                    titleText = `Allied Siege by ${siegerName}`;
                } else if (incomingAttack) {
                    indicatorHTML = '<span class="badge bg-danger ms-2">Attack</span>';
                    borderColor = '#dc3545';
                    titleText = 'Incoming Enemy Fleet';
                } else if (hostileOrbit && isAlliedPlanet) {
                    indicatorHTML = '<span class="badge bg-danger ms-2">Hostile</span>';
                    borderColor = '#dc3545';
                    titleText = 'Hostile Fleet in Orbit';
                } else if (alliedTransit) {
                    indicatorHTML = '<span class="badge bg-warning text-dark ms-2">Ally moving</span>';
                    borderColor = '#ffc107'; 
                    titleText = 'Allied Fleet Transit';
                }

                const planetPlans = plans.filter(p => p.planet_index === planetIndex);
                if (planetPlans.length > 0 && !indicatorHTML) { 
                    borderColor = '#f8f9fa';
                    if (planetPlans.length === 1) {
                        indicatorHTML = `<span class="badge bg-light text-dark border ms-2">Plan</span>`;
                        titleText = `Intel Note: ${planetPlans[0].note} (${planetPlans[0].author})`;
                    } else {
                        indicatorHTML = planetPlans.map((p, idx) => 
                            `<span class="badge bg-light text-dark border ms-1" style="font-size: 8px; padding: 1px 3px; cursor: help;" title="[Plan ${idx + 1}] ${p.note} (${p.author})">P${idx + 1}</span>`
                        ).join('');
                        titleText = ''; 
                    }
                }

                if (indicatorHTML) {
                    row.style.borderLeft = `3px solid ${borderColor}`;
                    const indicator = document.createElement('span');
                    indicator.className = 'aw-hub-indicator';
                    indicator.style.cursor = 'help';
                    indicator.title = titleText;
                    indicator.innerHTML = indicatorHTML;
                    firstCell.appendChild(indicator);
                }
            });
        }
    });
}