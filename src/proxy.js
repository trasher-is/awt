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
    </style>
</head>
<body class="d-flex flex-column h-100">
<main b-b4pfdex4p1="" role="main" class="flex-shrink-0 pb-3 pt-3 custom-centered-layout w-100">
    <div b-b4pfdex4p1="" class="container-fluid">
        <div class="row">
            <div class="col-md-12">
                <div class="alert alert-secondary text-center mb-3 shadow-sm">
                    Out of vision range — showing the hub's last recorded data for this system.
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
                <h5 id="synthetic-system-heading">
                    <a class="me-2" href="/Game/Map"><i class="bi bi-geo-alt"></i></a>
                    System #${systemId}
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
                            <tr><td colspan="5" class="text-center py-4 text-muted">Loading...</td></tr>
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
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">No data available for this system.</td></tr>';
                return;
            }

            if (data.system) {
                const heading = document.getElementById('synthetic-system-heading');
                const name = data.system.full_name || data.system.name || ('System #' + ${JSON.stringify(systemId)});
                heading.innerHTML = '<a class="me-2" href="/Game/Map"><i class="bi bi-geo-alt"></i></a>'
                    + name + ' [' + ${JSON.stringify(systemId)} + '] (' + data.system.x + '/' + data.system.y + ')';
            }

            const maxIndex = Math.max(
                ...data.planets.map(p => p.planet_index),
                ...data.plans.map(p => p.planet_index),
                ...data.fleets.map(f => f.planet_index),
                0
            );

            if (maxIndex === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No planets recorded for this system.</td></tr>';
                return;
            }

            for (let i = 1; i <= maxIndex; i++) {
                const planet = data.planets.find(p => p.planet_index === i);
                const fleets = data.fleets.filter(f => f.planet_index === i);

                const tr = document.createElement('tr');
                if (planet && planet.id) {
                    tr.setAttribute('data-planet-id', planet.id);
                }

                tr.innerHTML = '<td>' + i + '</td>';

                if (planet) {
                    tr.innerHTML += '<td>' + planet.population.toLocaleString() + '</td>';
                    tr.innerHTML += '<td>' + planet.starbase + '</td>';
                    const tagStr = planet.alliance_tag ? ' [' + planet.alliance_tag + ']' : '';
                    tr.innerHTML += '<td><span>' + (planet.owner_name || 'Unoccupied') + tagStr + '</span></td>';
                } else {
                    tr.innerHTML += '<td>-</td><td>-</td><td><span class="text-muted">Unknown</span></td>';
                }

                let actionTd = '<td class="copy-none">';
                if (fleets.length > 0) {
                    actionTd += '<i class="bi bi-rocket-fill me-2 text-warning"></i> ' + fleets.length + ' fleet(s)';
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
            document.getElementById('synthetic-intel-body').innerHTML = '<tr><td colspan="5" class="text-center text-danger">Failed to load system data.</td></tr>';
        }
    }
    window.addEventListener('DOMContentLoaded', loadCachedIntel);
</script>
<script type="module" src="/hub-assets/js/main.js"></script>
</body>
    `;
}

// The hub's own session cookie. express-session is mounted in server.js without a `name`
// option, so it uses the library default.
const HUB_SESSION_COOKIE = 'connect.sid';

// The proxied game pages are served from the hub's origin, which means the browser attaches
// EVERY cookie it holds for that origin — including the hub's own session cookie, signed
// with SESSION_SECRET. http-proxy-middleware forwards inbound headers untouched, so that
// cookie was being handed to the game server on every proxied request: an asset, a page, a
// scrape, all of them. The game has no use for it and holding it is a liability for whoever
// runs that server as much as for us.
//
// Strip ours by name and forward the rest verbatim — the game's own session cookie lives
// under the same origin and must still get through, or the member is logged out.
function stripHubCookie(cookieHeader) {
    if (!cookieHeader) return null;
    const kept = cookieHeader
        .split(';')
        .filter(part => part.split('=')[0].trim() !== HUB_SESSION_COOKIE)
        .map(part => part.trim())
        .filter(Boolean);
    return kept.join('; ');
}

const proxyOptions = {
    target: process.env.TARGET_URL || 'https://astrowars.games',
    changeOrigin: true,
    selfHandleResponse: true,
    on: {
        proxyReq: (proxyReq, req, res) => {
            const cookies = stripHubCookie(req.headers.cookie);
            if (cookies) proxyReq.setHeader('Cookie', cookies);
            else proxyReq.removeHeader('Cookie');

            // Internal marker for the rate gate in server.js. The game has no reason to
            // learn how this tool is built.
            proxyReq.removeHeader('X-AWT-Automated');

            // The inbound X-Forwarded-For is supplied by the caller. Echoing it verbatim
            // let anyone present an arbitrary address to the game, so a rate limit or ban
            // upstream would land on whoever's IP they chose. Append the address we
            // actually observed rather than replacing the chain with theirs, and take
            // X-Real-IP from req.ip, which Express derives using the app's trust proxy
            // setting instead of from a raw header.
            const observed = req.socket.remoteAddress || '';
            const forwarded = req.headers['x-forwarded-for'];
            proxyReq.setHeader('X-Forwarded-For', forwarded ? `${forwarded}, ${observed}` : observed);
            proxyReq.setHeader('X-Real-IP', req.ip || observed);
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
// Exposed so src/utils/game-traffic.test.js can check the cookie rule directly rather
// than by reading the source and hoping.
module.exports.stripHubCookie = stripHubCookie;
module.exports.HUB_SESSION_COOKIE = HUB_SESSION_COOKIE;