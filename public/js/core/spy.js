export function initSpy() {
    let currentMapX = null;
    let currentMapY = null;
    let verifiedPlayerName = null;

    async function backgroundIdentityCheck() {
        if (verifiedPlayerName) return; 
        try {
            console.log("[Alliance Tools] Running silent identity check...");
            const response = await fetch('/Game/Players');
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const nameNode = doc.querySelector('th span a[href^="/Game/Players/Profile/"]');
            
            if (nameNode) {
                verifiedPlayerName = nameNode.innerText.trim();
                console.log(`[Alliance Tools] Target locked: ${verifiedPlayerName}`);
                sendContext(); 
            }
        } catch (error) {
            console.error("[Alliance Tools] Identity check failed", error);
        }
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

        const isSystemView = pathLower.includes('/game/map/solarsystem') || pathLower.includes('/game/system');
        let sysId = null;
        if (isSystemView) {
            const match = pathLower.match(/solarsystem\/(\d+)/) || pathLower.match(/\/system\/(\d+)/);
            if (match) {
                sysId = match[1];
            } else {
                const urlParams = new URLSearchParams(window.location.search);
                sysId = urlParams.get('id') || urlParams.get('system');
            }
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
            isCalculatorView: isCalculatorView, // <-- Added here
            systemId: sysId,
            mapX: currentMapX,
            mapY: currentMapY,
            playerName: verifiedPlayerName 
        };
        
        // Beam it to Wrapper
        window.parent.postMessage({ type: 'GAME_CONTEXT', payload: contextPayload }, window.location.origin);

        // NOW we can safely read from the Payload to trigger scrapers
        if (contextPayload.isSystemView && contextPayload.systemId) {
            import('../scrapers/system-parser.js')
                .then(module => module.scrapeSystem(contextPayload.systemId))
                .catch(err => console.error("[Spy] Error loading system parser:", err));
        }

        if (isPlayerView && targetPlayerId) {
            import('../scrapers/player-parser.js')
                .then(module => module.scrapePlayer(targetPlayerId))
                .catch(err => console.error("[Spy] Error loading player parser:", err));
        }

        if (contextPayload.isAllianceView) {
            import('../scrapers/alliance-parser.js')
                .then(module => module.scrapeAlliance())
                .catch(err => console.error("[Spy] Error loading alliance parser:", err));
        }

        if (contextPayload.isCalculatorView) {
            import('../scrapers/galaxy-parser.js')
                .then(module => module.scrapeGalaxy())
                .catch(err => console.error("[Spy] Error loading galaxy parser:", err));
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
    }, 500);

    // --- RECEIVE DATA FROM WRAPPER ---
    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;

        // Tactical Overlay Injection (DOM-Based)
        if (data.type === 'INJECT_TACTICAL_OVERLAYS') {
            const { plans } = data.payload; // We only need plans from the DB now
            
            // Clear existing Hub overlays
            document.querySelectorAll('.aw-hub-indicator').forEach(el => el.remove());
            document.querySelectorAll('#solarSystem tr').forEach(row => { row.style.borderLeft = ''; });

            // Hardcode your alliance tag here so the script knows who is an ally vs enemy
            const myAllianceTag = 'YELW'; 

            const rows = document.querySelectorAll('#solarSystem > tbody > tr[data-planet-id]');
            
            rows.forEach(row => {
                const firstCell = row.querySelector('td');
                if (!firstCell) return;
                
                const planetIndex = parseInt(firstCell.innerText.trim(), 10);
                if (isNaN(planetIndex)) return;

                // 1. Identify Alliance Status
                const ownerLink = row.querySelectorAll('td')[3]?.querySelector('a[href^="/Game/Alliance/"]');
                const rowAllyTag = ownerLink ? ownerLink.innerText.trim() : null;
                const isAlliedPlanet = rowAllyTag === myAllianceTag;

                // 2. Parse the pure DOM for 100% accurate status
                const isSieged = row.classList.contains('siege');
                const actionHtml = row.querySelectorAll('td')[4]?.innerHTML || ''; 
                
                const incomingAttack = actionHtml.includes('Incoming hostile fleet') || actionHtml.includes('Hostile fleet incoming');
                const hostileOrbit = actionHtml.includes('Hostile fleet in orbit');
                const alliedTransit = actionHtml.includes('Incoming allied') || actionHtml.includes('Allied fleet');

                // 3. Build the indicators based on priority
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

                // Check Plans (Lowest visual priority)
                const plan = plans.find(p => p.planet_index === planetIndex);
                if (plan && !indicatorHTML) { 
                    indicatorHTML = `<span class="badge bg-light text-dark border ms-2">Plan</span>`;
                    borderColor = '#f8f9fa';
                    titleText = `Intel Note: ${plan.note} (${plan.author})`;
                }

                // Inject if an action was found
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