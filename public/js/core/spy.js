export function initSpy() {
    let currentMapX = null;
    let currentMapY = null;

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

        const context = {
            path: currentUrl,
            isSystemView: pathLower.includes('/game/system'), 
            isMap: pathLower.includes('/game/map'),
            systemId: null,
            mapX: currentMapX,
            mapY: currentMapY
        };

        if (context.isSystemView) {
            const urlParams = new URLSearchParams(window.location.search);
            context.systemId = urlParams.get('id') || urlParams.get('system');
            if (!context.systemId) {
                const match = pathLower.match(/\/game\/system\/(\d+)/);
                if (match) context.systemId = match[1];
            }
        }

        window.parent.postMessage({ type: 'GAME_CONTEXT', payload: context }, window.location.origin);
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