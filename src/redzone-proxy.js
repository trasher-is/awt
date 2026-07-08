// Open, login-free reverse proxy for redzone.astrowars.games — a faster-paced variant
// of the game. Served on its own subdomain (rz.<host>) so the game's absolute-path
// assets/links/fetches all resolve within that host (a subpath mount would leak them to
// the root astrowars proxy). All it does beyond forwarding: strip framing/CSP headers and
// inject the standalone QoL userscript so the population/science/culture timers and the
// science calculator work with no extension, no bookmarklet, and no awt login.
//
// The injected script is loaded by ABSOLUTE URL from the main host (not the rz host),
// because on the rz host every path is proxied to redzone — a relative /userscripts/...
// would 404 against redzone. CSP is stripped just above, so the cross-origin <script>
// load is allowed.
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const SCRIPT_URL = process.env.PROXY_DOMAIN
    ? `https://${process.env.PROXY_DOMAIN}/userscripts/redzone-qol.user.js`
    : '/userscripts/redzone-qol.user.js';

const redzoneProxy = createProxyMiddleware({
    target: process.env.REDZONE_TARGET_URL || 'https://redzone.astrowars.games',
    changeOrigin: true,
    selfHandleResponse: true,
    on: {
        proxyReq: (proxyReq, req) => {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            proxyReq.setHeader('X-Forwarded-For', clientIp);
            proxyReq.setHeader('X-Real-IP', clientIp);
        },
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
            // Let the game render inside a normal tab and allow our injected script.
            res.removeHeader('x-frame-options');
            res.removeHeader('X-Frame-Options');
            res.removeHeader('content-security-policy');
            res.removeHeader('Content-Security-Policy');

            const contentType = proxyRes.headers['content-type'];
            if (contentType && contentType.includes('text/html')) {
                const html = responseBuffer.toString('utf8');
                const scriptTag = `<script src="${SCRIPT_URL}"></script>\n</body>`;
                return html.replace('</body>', scriptTag);
            }
            return responseBuffer;
        })
    }
});

module.exports = redzoneProxy;
