import { initPlanetPopTimers, initScienceCultureCalc } from './page-injections.js';

window.addEventListener('load', () => {
    if (window.location.pathname.includes('/Game/Planets')) initPlanetPopTimers();
    if (window.location.pathname.includes('/Game/Science')) initScienceCultureCalc();
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
                
                if (alliedSysIdsCache.has(sysId)) {
                    icon.style.boxShadow = '0 0 15px 5px #22c55e, inset 0 0 10px #22c55e';
                    icon.style.borderRadius = '50%';
                    icon.style.border = '2px solid #22c55e';
                    icon.style.backgroundColor = 'rgba(34, 197, 94, 0.4)';
                    span.style.color = '#4ade80';
                    span.style.fontWeight = 'bold';
                } else {
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

    let lastUrl = window.location.pathname + window.location.search;
    setInterval(() => {
        const currentUrl = window.location.pathname + window.location.search;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            sendContext();
        }

        if (currentUrl.toLowerCase().includes('/game/map')) {
            injectMapIndicators();
        }
    }, 200);

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;

        if (data.type === 'INJECT_TACTICAL_OVERLAYS') {
            const { plans } = data.payload; 
            
            document.querySelectorAll('.aw-hub-indicator').forEach(el => el.remove());
            document.querySelectorAll('#solarSystem tr').forEach(row => { row.style.borderLeft = ''; });

            const rows = document.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
            
            rows.forEach(row => {
                const firstCell = row.querySelector('td');
                if (!firstCell) return;
                
                const planetIndex = parseInt(firstCell.innerText.trim(), 10);
                if (isNaN(planetIndex)) return;

                const ownerLink = row.querySelectorAll('td')[3]?.querySelector('a[href^="/Game/Players/Profile/"]');
                const rowPlayerName = ownerLink ? ownerLink.innerText.trim().toLowerCase() : null;
                
                const isAlliedPlanet = rowPlayerName && alliedPlayerNamesCache.has(rowPlayerName);

                const isSieged = row.classList.contains('siege');
                const actionHtml = row.querySelectorAll('td')[4]?.innerHTML || ''; 
                
                const incomingAttack = actionHtml.includes('Incoming hostile fleet') || actionHtml.includes('Hostile fleet incoming');
                const hostileOrbit = actionHtml.includes('Hostile fleet in orbit');
                const alliedTransit = actionHtml.includes('Incoming allied') || actionHtml.includes('Allied fleet');

                let indicatorHTML = '';
                let borderColor = '';
                let titleText = '';

                if (isSieged && isAlliedPlanet) {
                    indicatorHTML = '<span class="badge bg-purple ms-2" style="background-color: #800080; color: white;">Siege</span>';
                    borderColor = '#800080';
                    titleText = 'Enemy Siege Detected';
                } else if (isSieged && !isAlliedPlanet) {
                    indicatorHTML = '<span class="badge ms-2" style="background-color: #fd7e14; color: white;">ASiege</span>';
                    borderColor = '#fd7e14'; 
                    titleText = 'Allied Siege';
                } else if (incomingAttack) {
                    indicatorHTML = '<span class="badge bg-danger ms-2">Attack</span>';
                    borderColor = '#dc3545';
                    titleText = 'Incoming Enemy Fleet';
                } else if (hostileOrbit && isAlliedPlanet) {
                    indicatorHTML = '<span class="badge bg-danger ms-2">Hostile</span>';
                    borderColor = '#dc3545';
                    titleText = 'Hostile Fleet in Orbit';
                } else if (alliedTransit) {
                    indicatorHTML = '<span class="badge bg-warning text-dark ms-2">Transit</span>';
                    borderColor = '#ffc107'; 
                    titleText = 'Allied Fleet Detected';
                }

                const plan = plans.find(p => p.planet_index === planetIndex);
                if (plan && !indicatorHTML) { 
                    indicatorHTML = `<span class="badge bg-light text-dark border ms-2">Plan</span>`;
                    borderColor = '#f8f9fa';
                    titleText = `Intel Note: ${plan.note} (${plan.author})`;
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