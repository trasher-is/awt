#!/usr/bin/env node
// Dev helper: fire a fake "incoming attack" at the webhook and print the assembled alert.
//
// Usage:
//   node test-incoming.js                      # auto-pick a real defender + target, preview only
//   node test-incoming.js --minutes 45         # impact in 45 min (default 90)
//   node test-incoming.js --system 1234        # force a target system id
//   node test-incoming.js --defender Name      # force a defender name
//   node test-incoming.js --cv 50000 --tr 0    # attacker CV / TR
//   node test-incoming.js --live               # actually post to Discord (omit = preview)
//
// Requires the server to be running (PORT env or 3000).

const db = require('./src/database');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const hasFlag = (name) => process.argv.includes('--' + name);

const PORT = process.env.PORT || 3000;
const minutes = parseInt(arg('minutes', '90'), 10);
const cv = parseInt(arg('cv', '40000'), 10);
const tr = parseInt(arg('tr', '0'), 10);
const live = hasFlag('live');

// --- Pick a defender whose alliance has defenders, and a target system ---
let defenderName = arg('defender', null);
let allianceId = null;

if (defenderName) {
    const row = db.prepare('SELECT alliance_id FROM players WHERE name = ? COLLATE NOCASE').get(defenderName);
    allianceId = row ? row.alliance_id : null;
} else {
    // Alliance with the most home-build defenders, then any member as the target.
    const best = db.prepare(`
        SELECT p.alliance_id AS aid, COUNT(*) c
        FROM alliance_member_stats ams
        JOIN players p ON p.id = ams.player_id
        JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system) AND s.x IS NOT NULL
        WHERE p.alliance_id IS NOT NULL
        GROUP BY p.alliance_id ORDER BY c DESC LIMIT 1
    `).get();
    if (best) {
        allianceId = best.aid;
        const def = db.prepare('SELECT name FROM players WHERE alliance_id = ? LIMIT 1').get(allianceId);
        defenderName = def ? def.name : 'TestDefender';
    } else {
        defenderName = 'TestDefender';
    }
}

let systemId = parseInt(arg('system', '0'), 10);
let systemName = 'TestSystem';
if (systemId) {
    const s = db.prepare('SELECT name FROM systems WHERE id = ?').get(systemId);
    systemName = (s && s.name) || 'TestSystem';
} else {
    const s = db.prepare('SELECT id, name FROM systems WHERE x IS NOT NULL AND y IS NOT NULL LIMIT 1').get();
    systemId = s ? s.id : 1;
    systemName = (s && s.name) || 'TestSystem';
}

const planetIndex = 4;
const arrivalUnix = Math.floor(Date.now() / 1000) + minutes * 60;
const tag = 'HNU';

// Mirror the in-game forwarder's message shape.
const content =
    `**Incoming**: **Bloknat** [${tag}] (${cv.toLocaleString()}CV, ${tr.toLocaleString()}TR) ` +
    `attacking **${defenderName}** on [${systemId}] ${systemName} #${planetIndex}. ` +
    `Fleet: 5,000 Destroyers, 800 Cruisers, 120 Battleships arriving <t:${arrivalUnix}:R>`;

const payload = { content };

(async () => {
    const url = `http://localhost:${PORT}/api/game-notifications${live ? '' : '?preview=1'}`;
    console.log(`\n→ POST ${url}`);
    console.log(`  defender=${defenderName} alliance_id=${allianceId} target=[${systemId}] ${systemName} #${planetIndex} impact_in=${minutes}min\n`);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (live) {
            console.log('Live mode — server responded:', await res.text());
            console.log('Check your configured incoming Discord channel.');
            return;
        }
        const data = await res.json();
        console.log('matched attack:', data.matched);
        console.log('\n================ ASSEMBLED ALERT ================\n');
        console.log(data.message || '(no message — parse failed)');
        console.log('\n================================================\n');
    } catch (err) {
        console.error('Request failed (is the server running on port ' + PORT + '?):', err.message);
    }
})();
