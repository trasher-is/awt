import { initPlanetPopTimers, initScienceCultureCalc, initAllianceNewsAlerts, initStarbaseTimer, initScienceTimers, initScienceLevelCalculator, initProfilePLGrowth } from './page-injections.js';

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

    function calculateMapScaleFromOffset() {
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

        // --- GEOMETRIC RADAR CIRCLE INJECTION ENGINE ---
        if (window.activeSearchedPlayerVision) {
            const { range, originSystemId } = window.activeSearchedPlayerVision;
            if (originSystemId && range > 0) {
                const existingCircle = document.querySelector('.custom-vision-circle');
                let shouldDraw = true;

                if (existingCircle) {
                    if (existingCircle.getAttribute('data-origin-id') === String(originSystemId) && 
                        existingCircle.getAttribute('data-range') === String(range)) {
                        shouldDraw = false; 
                    } else {
                        existingCircle.remove();
                    }
                }

                if (shouldDraw) {
                    let originNode = null;
                    const allNodes = document.querySelectorAll('.map-planet');
                    for (let node of allNodes) {
                        const span = node.querySelector('span');
                        const m = span?.innerText.match(/\[(\d+)\]/);
                        if (m && String(m[1]) === String(originSystemId)) {
                            originNode = node;
                            break;
                        }
                    }

                    if (originNode) {
                        const scale = calculateMapScaleFromOffset();
                        if (scale) {
                            const radiusPx = range * scale;
                            const diameterPx = radiusPx * 2;
                            const circle = document.createElement('div');
                            
                            circle.className = 'custom-vision-circle';
                            circle.setAttribute('data-origin-id', String(originSystemId));
                            circle.setAttribute('data-range', String(range));
                            
                            circle.style.position = 'absolute';
                            circle.style.width = `${diameterPx}px`;
                            circle.style.height = `${diameterPx}px`;
                            circle.style.backgroundColor = 'rgba(255, 255, 255, 0.10)';
                            circle.style.border = '1px dashed rgba(255, 255, 255, 0.3)';
                            circle.style.borderRadius = '50%';
                            circle.style.pointerEvents = 'none';
                            circle.style.zIndex = '1';
                            
                            // FIXED: Shifted horizontal midpoint center to 8px inside the leftmost square box boundary
                            const h = originNode.offsetHeight || 0;
                            const centerX = originNode.offsetLeft + 14;
                            const centerY = originNode.offsetTop + (h / 2);
                            
                            circle.style.left = `${centerX - radiusPx}px`;
                            circle.style.top = `${centerY - radiusPx}px`;
                            
                            originNode.parentElement.appendChild(circle);
                        }
                    }
                }
            }
        } else {
            document.querySelector('.custom-vision-circle')?.remove();
        }

        // --- ALLIANCE COLLECTIVE VISION CIRCLES ENGINE ---
        if (window.activeAllianceVision && window.activeAllianceVision.length > 0) {
            const scale = calculateMapScaleFromOffset();
            
            const unTaggedNodes = document.querySelectorAll('.map-planet:not([data-hub-tagged="true"])');
            if (unTaggedNodes.length > 0) {
                document.querySelectorAll('.custom-alliance-vision-circle').forEach(el => el.remove());
            }

            if (scale) {
                window.activeAllianceVision.forEach(vis => {
                    const existingCircle = document.querySelector(`.custom-alliance-vision-circle[data-player-id="${vis.playerId}"]`);
                    if (existingCircle) return;

                    let originNode = null;
                    const allNodes = document.querySelectorAll('.map-planet');
                    for (let node of allNodes) {
                        const span = node.querySelector('span');
                        const m = span?.innerText.match(/\[(\d+)\]/);
                        if (m && String(m[1]) === String(vis.originSystemId)) {
                            originNode = node;
                            break;
                        }
                    }

                    if (originNode) {
                        // FIX: Add 1 extra square scale to the radius calculation
                        const radiusPx = vis.range * scale;
                        const diameterPx = radiusPx * 2;
                        const circle = document.createElement('div');
                        
                        circle.className = 'custom-alliance-vision-circle';
                        circle.setAttribute('data-player-id', String(vis.playerId));
                        
                        circle.style.position = 'absolute';
                        circle.style.width = `${diameterPx}px`;
                        circle.style.height = `${diameterPx}px`;
                        circle.style.backgroundColor = 'transparent'; 
                        circle.style.border = '1px dashed rgb(255, 255, 255)'; 
                        circle.style.borderRadius = '50%';
                        circle.style.pointerEvents = 'none';
                        circle.style.zIndex = '1';
                        
                        const h = originNode.offsetHeight || 0;
                        // FIX: Changed from +8 to +13 to nudge the center 5px to the right
                        const centerX = originNode.offsetLeft + 14;
                        const centerY = originNode.offsetTop + (h / 2);
                        
                        circle.style.left = `${centerX - radiusPx}px`;
                        circle.style.top = `${centerY - radiusPx}px`;
                        
                        originNode.parentElement.appendChild(circle);
                    }
                });
            }
        } else {
            document.querySelectorAll('.custom-alliance-vision-circle').forEach(el => el.remove());
        }

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
                let isBaseSystemForTarget = false;

                if (window.activeSearchedPlayerVision && window.activeSearchedPlayerVision.targetSystems) {
                    isBaseSystemForTarget = window.activeSearchedPlayerVision.targetSystems.some(ts => String(ts.id) === String(sysId));
                }

                if (isBaseSystemForTarget) {
                    // FIXED: Removed box-glow modifications entirely
                    icon.style.boxShadow = '';
                    icon.style.borderRadius = '';
                    icon.style.border = '';
                    icon.style.backgroundColor = '';
                    
                    // FIXED: System name text label configuration transformed to white and scaled up +2px
                    span.style.color = '#ffffff';
                    span.style.fontSize = '14px'; 
                    span.style.fontWeight = 'bold';
                    span.style.textShadow = '0 0 6px rgba(0, 0, 0, 1), 0 0 2px rgba(0, 0, 0, 1)';
                } else {
                    // FIXED: Green alliance highlights removed entirely. Default tracking profiles applied here.
                    icon.style.boxShadow = '0 0 4px 1px rgba(34, 197, 94, 0.3)';
                    icon.style.borderRadius = '50%';
                    icon.style.border = '1px solid rgba(34, 197, 94, 0.5)';
                    span.style.color = 'rgba(74, 222, 128, 0.7)'; 
                    span.style.fontWeight = 'normal';
                    span.style.fontSize = ''; 
                    span.style.textShadow = '';
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
        
        try {
            window.parent.postMessage({ type: 'GAME_CONTEXT', payload: contextPayload }, window.location.origin);
        } catch (e) {}

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

    let lastUrl = window.location.pathname + window.location.search;
    setInterval(() => {
        const currentUrl = window.location.pathname + window.location.search;
        const pathLower = currentUrl.toLowerCase();

        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            sendContext();
        }

        if (pathLower.includes('/game/map')) {
            injectMapIndicators();
        }
        if (pathLower.includes('/game/news')) {
            initAllianceNewsAlerts();
        }
        if (pathLower.includes('/game/planets')) {
            initPlanetPopTimers();
        }
        if (pathLower.includes('/game/science')) {
            initScienceCultureCalc();
            initScienceTimers();
            initScienceLevelCalculator();
        }
        if (pathLower.includes('/game/planets/planet/')) {
            initStarbaseTimer();
        }
        if (pathLower.includes('/game/players/profile/')) {
            initProfilePLGrowth();
        }

        updateTabTitle();
    }, 200);

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;

        if (data.type === 'SHOW_ALLIANCE_VISION') {
            window.activeAllianceVision = data.payload.visions;
            document.querySelectorAll('.custom-alliance-vision-circle').forEach(el => el.remove());
            injectMapIndicators();
        } 
        else if (data.type === 'CLEAR_ALLIANCE_VISION') {
            window.activeAllianceVision = null;
            document.querySelectorAll('.custom-alliance-vision-circle').forEach(el => el.remove());
            injectMapIndicators();
        }

        if (data.type === 'HIGHLIGHT_PLAYER_VISION') {
            const { range, systems, originSystemId } = data.payload;
            window.activeSearchedPlayerVision = { range, targetSystems: systems, originSystemId };
            document.querySelectorAll('.map-planet').forEach(el => el.removeAttribute('data-hub-tagged'));
            injectMapIndicators();
        } 
        else if (data.type === 'CLEAR_PLAYER_VISION') {
            window.activeSearchedPlayerVision = null;
            document.querySelectorAll('.map-planet').forEach(el => el.removeAttribute('data-hub-tagged'));
            document.querySelector('.custom-vision-circle')?.remove();
            injectMapIndicators();
        }

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