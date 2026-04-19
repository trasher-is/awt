require('dotenv').config();
const express = require('express');
const path = require('path');

// Import our new database connection (runs the schema init)
const db = require('./src/database'); 

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Global Middleware
app.use(express.json({ limit: '50mb' }));
app.use('/assets', express.static(path.join(__dirname, 'public')));

// 2. Placeholder for API (We'll move this to its own file later)
app.get('/api/health', (req, res) => res.json({ status: 'active', db: 'connected' }));

// 3. Proxy Middleware (The heart of the game injection)
// We require it here; it must be the last route.
const proxyMiddleware = require('./src/proxy');
app.use('/', proxyMiddleware);

app.listen(PORT, () => {
    console.log(`[Core] Alliance Intelligence Hub v2 online on port ${PORT}`);
});