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
}