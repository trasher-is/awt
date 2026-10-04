// Live side of the Defence panel (2026-10-04): who is looking at an attack right now, and
// pushing changes (defence choices, cover claims) to everyone looking, without a refresh.
//
// Server-Sent Events: one long-lived GET per open panel (GET /hub-api/defence/stream?key=),
// kept in memory. That is enough because the hub is ONE process (pm2 fork mode) — a second
// process would need a shared bus. A panel watches one attack at a time; switching attack
// reconnects with the new key.
//
// Behind nginx: the response carries "X-Accel-Buffering: no" so nginx passes each event
// through at once instead of buffering it, and a comment line every 25 s keeps idle
// connections under the usual 60 s proxy read timeout.

const HEARTBEAT_MS = 25 * 1000;

const clients = new Set();   // { res, key, name }

function send(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ }
}

// Everyone with a panel open on this attack, each name once, sorted.
function viewers(key) {
    const names = new Set();
    for (const c of clients) if (c.key === key && c.name) names.add(c.name);
    return [...names].sort((a, b) => a.localeCompare(b));
}

function broadcast(key, event, data) {
    for (const c of clients) if (c.key === key) send(c.res, event, data);
}

const broadcastViewers = key => broadcast(key, 'viewers', { key, viewers: viewers(key) });

/**
 * Hold `res` open as an event stream for attack `key`, watched by `name`. `initial` is a
 * list of [event, data] sent to this client first (the current plan, so a fresh panel
 * does not wait for the next change).
 */
function attach(req, res, key, name, initial = []) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const client = { res, key, name };
    clients.add(client);
    for (const [event, data] of initial) send(res, event, data);
    broadcastViewers(key);
    const close = () => {
        if (!clients.delete(client)) return;
        broadcastViewers(key);
    };
    req.on('close', close);
    res.on('error', close);
    return client;
}

const heartbeat = setInterval(() => {
    for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (e) { /* closed */ } }
}, HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

// For tests.
function _reset() { clients.clear(); }
const _count = () => clients.size;

module.exports = { attach, viewers, broadcast, broadcastViewers, _reset, _count };
