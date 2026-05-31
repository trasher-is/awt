const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

function generateSyntheticPage(systemId) {
    return `
<!DOCTYPE html>
<html lang="en" class="h-100">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <meta name="description" content="Massive multiplayer space strategy build up game. Playable mobile on android and iOS or in browser.">
    <title>Astro Wars - Shared System Intel</title>
    <link rel="stylesheet" href="/lib/bootstrap/dist/css/bootstrap.css" />
    <link rel="stylesheet" href="/css/site.css" />
    <link rel="stylesheet" href="/css/astrowars.css" />
    <link rel="stylesheet" href="/lib/sortable/dist/sortable.min.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.min.css">
    <style>
        /* Avoid overlapping or covering by floating sidebars by centering the main body content */
        main.custom-centered-layout {
            max-width: 1140px;
            margin: 0 auto !important;
            float: none !important;
            padding-left: 20px;
            padding-right: 20px;
        }
        .out-of-range-alert {
            background-color: rgba(127, 29, 29, 0.9) !important;
            color: #fca5a5 !important;
            border: 1px solid #f87171 !important;
        }
    </style>
</head>
<body class="d-flex flex-column h-100">
<main b-b4pfdex4p1="" role="main" class="flex-shrink-0 pb-3 pt-3 custom-centered-layout w-100">
    <div b-b4pfdex4p1="" class="container-fluid">
        <div class="row">
            <div class="col-md-12">
                <div class="alert out-of-range-alert text-center fw-bold mb-3 shadow-sm">
                    ⚠️ OUT OF VISION RANGE — SYSTEM INSIGHTS RENDERED FROM ALLIANCE CACHE RECORDINGS
                </div>
                <table class="table navigation">
                    <tbody>
                    <tr>
                        <td><a class="ignore-highlight" href="/"><i class="bi bi-house-fill"></i></a></td>
                        <td><a href="/Game/News">News</a></td>
                        <td class="highlight"><a href="/Game/Map">Map</a></td>
                        <td><a href="/Game/Planets"><span class="d-sm-none">Pln</span><span class="d-none d-sm-inline">Planets</span></a></td>
                        <td><a href="/Game/Science"><span class="d-sm-none">Sci</span><span class="d-none d-sm-inline">Science</span></a></td>
                        <td><a href="/Game/Fleets"><span class="d-sm-none">Flt</span><span class="d-none d-sm-inline">Fleet</span></a></td>
                        <td><a href="/Game/Trade"><span class="d-sm-none">Trd</span><span class="d-none d-sm-inline">Trade</span></a></td>
                        <td><a href="/Game/Alliance"><span class="d-sm-none">Ally</span><span class="d-none d-sm-inline">Alliance</span></a></td>
                        <td><a href="/Game/Players"><span class="d-sm-none">Ply</span><span class="d-none d-sm-inline">Player</span></a></td>
                    </tr>
                    </tbody>
                </table>
            </div>
        </div>
        <div class="row">
            <div class="col-md-12 text-center">
                <h5>
                    <a class="me-2" href="/Game/Map"><i class="bi bi-geo-alt"></i></a>
                    Planets at Cached Coordinate Matrix: [ System Index Reference #${systemId} ]
                    <span class="badge bg-danger ms-2" style="font-size: 0.6em; vertical-align: middle;"><i class="bi bi-cloud-slash"></i> Offline Mode</span>
                </h5>
            </div>
        </div>
        <div class="row">
            <div class="col-md-12">
                <div class="overflow-auto">
                    <table class="table" id="solarSystem">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th><span class="d-sm-none">Pop</span><span class="d-none d-sm-inline">Population</span></th>
                                <th><span class="d-sm-none">SB</span><span class="d-none d-sm-inline">Starbase</span></th>
                                <th>Owner</th>
                                <th class="copy-none"><span class="d-none d-sm-inline">Action / Active Tactical Units</span></th>
                            </tr>
                        </thead>
                        <tbody id="synthetic-intel-body">
                            <tr><td colspan="5" class="text-center py-4 text-muted">Pulling archived registry maps from alliance array storage...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</main>

<script src="/lib/jquery/dist/jquery.min.js"></script>
<script src="/lib/bootstrap/dist/js/bootstrap.bundle.min.js"></script>
<script src="/js/site.js"></script>

<script>
    async function loadCachedIntel() {
        try {
            const response = await fetch('/hub-api/intel/system/${systemId}');
            const data = await response.json();
            const tbody = document.getElementById('synthetic-intel-body');
            tbody.innerHTML = '';

            if (!data.success) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">No shared data matches this system index coordinate.</td></tr>';
                return;
            }

            const maxIndex = Math.max(
                ...data.planets.map(p => p.planet_index),
                ...data.plans.map(p => p.planet_index),
                ...data.fleets.map(f => f.planet_index),
                0
            );

            if (maxIndex === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No mapped planet entries or operations tracked in history logs for this layout.</td></tr>';
                return;
            }

            for (let i = 1; i <= maxIndex; i++) {
                const planet = data.planets.find(p => p.planet_index === i);
                const fleets = data.fleets.filter(f => f.planet_index === i);

                const tr = document.createElement('tr');
                if (planet && planet.id) {
                    tr.setAttribute('data-planet-id', planet.id);
                }
                
                // Serves only the row identifier coordinate block. No embedded badges here anymore.
                tr.innerHTML = '<td>' + i + '</td>';

                if (planet) {
                    tr.innerHTML += '<td>' + planet.population.toLocaleString() + '</td>';
                    tr.innerHTML += '<td>' + planet.starbase + '</td>';
                    const tagStr = planet.alliance_tag ? ' [' + planet.alliance_tag + ']' : '';
                    tr.innerHTML += '<td><span>' + (planet.owner_name || 'Unoccupied') + tagStr + '</span></td>';
                } else {
                    tr.innerHTML += '<td>-</td><td>-</td><td><span class="text-muted">No Scan History</span></td>';
                }

                let actionTd = '<td class="copy-none">';
                if (fleets.length > 0) {
                    actionTd += '<i class="bi bi-rocket-fill me-2 text-warning"></i> ' + fleets.length + ' Recorded Fleets';
                    fleets.forEach(f => {
                        actionTd += '<div class="small text-muted" style="font-size: 11px; padding-left: 15px;">• ' + (f.owner_name || 'Unknown') + ' (TR:' + f.transports + ' BS:' + f.battleships + ')</div>';
                    });
                } else {
                    actionTd += '<span class="text-muted">-</span>';
                }
                actionTd += '</td>';
                tr.innerHTML += actionTd;

                tbody.appendChild(tr);
            }
        } catch (err) {
            document.getElementById('synthetic-intel-body').innerHTML = '<tr><td colspan="5" class="text-center text-danger">Intel pipeline connection timeout.</td></tr>';
        }
    }
    window.addEventListener('DOMContentLoaded', loadCachedIntel);
</script>
<script type="module" src="/hub-assets/js/main.js"></script>
</body>
    `;
}

const proxyOptions = {
    target: process.env.TARGET_URL || 'https://astrowars.games',
    changeOrigin: true,
    selfHandleResponse: true, 
    on: {
        proxyReq: (proxyReq, req, res) => {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            proxyReq.setHeader('X-Forwarded-For', clientIp);
            proxyReq.setHeader('X-Real-IP', clientIp);
        },
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
            res.removeHeader('x-frame-options');
            res.removeHeader('X-Frame-Options'); 
            res.removeHeader('content-security-policy');
            res.removeHeader('Content-Security-Policy');

            const systemMatch = req.url.match(/\/Game\/Map\/SolarSystem\/(\d+)/i);

            if (systemMatch && (proxyRes.statusCode === 302 || proxyRes.statusCode === 301)) {
                res.statusCode = 200;
                res.setHeader('content-type', 'text/html; charset=utf-8');
                res.removeHeader('location');
                res.removeHeader('Location');
                return generateSyntheticPage(systemMatch[1]);
            }

            const contentType = proxyRes.headers['content-type'];
            if (contentType && contentType.includes('text/html')) {
                let html = responseBuffer.toString('utf8');
                
                if (systemMatch && (html.includes('System not in range') || html.includes('vision range'))) {
                    res.setHeader('content-type', 'text/html; charset=utf-8');
                    return generateSyntheticPage(systemMatch[1]);
                }

                const scriptTag = `<script type="module" src="/hub-assets/js/main.js"></script>\n</body>`;
                html = html.replace('</body>', scriptTag);
                return html;
            }
            return responseBuffer;
        })
    }
};

module.exports = createProxyMiddleware(proxyOptions);