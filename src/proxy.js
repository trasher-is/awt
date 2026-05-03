const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const proxyOptions = {
    target: process.env.TARGET_URL || 'https://redzone.astrowars.games',
    changeOrigin: true,
    selfHandleResponse: true, // This tells the proxy to let us modify the HTML before sending it to the user
    
    on: {
        // --- 1. THE REQUEST INTERCEPTOR (Protecting Player IPs) ---
        proxyReq: (proxyReq, req, res) => {
            // Grab the real IP of the user making the request
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            
            // Force the game server to see the player's real IP, NOT your VPS IP
            proxyReq.setHeader('X-Forwarded-For', clientIp);
            proxyReq.setHeader('X-Real-IP', clientIp);
        },

        // --- 2. THE RESPONSE INTERCEPTOR (Iframe & Script Injection) ---
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
            // Strip out the security headers that block iframes
            res.removeHeader('x-frame-options');
            res.removeHeader('X-Frame-Options'); 
            res.removeHeader('content-security-policy');
            res.removeHeader('Content-Security-Policy');

            // Check if the response is an HTML page (ignore images, CSS, etc.)
            const contentType = proxyRes.headers['content-type'];
            if (contentType && contentType.includes('text/html')) {
                
                // Convert the raw data buffer into a readable HTML string
                let html = responseBuffer.toString('utf8');
                
                // Inject the scraper script right before the body closes
                const scriptTag = `<script type="module" src="/hub-assets/js/main.js"></script>\n</body>`;
                html = html.replace('</body>', scriptTag);
                
                return html;
            }

            // If it's not HTML, just return the data untouched
            return responseBuffer;
        })
    }
};

module.exports = createProxyMiddleware(proxyOptions);