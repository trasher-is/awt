const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { calcTravelSeconds, formatTime } = require('../utils/travel-calc');
const { postEmbed, defuseMentions } = require('../utils/discord-post');

const router = express.Router();

const MAX_LEGS = 6;             // start -> jump -> ... -> target; more than this is a campaign, not a route
const DEFAULT_TTL_DAYS = 7;     // a route with no planned start expires after this
const KEEP_AFTER_ARRIVAL_H = 24; // ...one with a planned start lingers this long past arrival

// Legs are computed on the server so that everyone sees the same numbers. The travel
// formula lives in src/utils/travel-calc.js; the biology requirement uses the same rule
// as the !dist command (bio needed = ceil of the vector distance between the systems).
function bioNeededFor(distance) {
    return Math.ceil(distance);
}

function loadSystems(ids) {
    if (!ids.length) return new Map();
    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, name, x, y FROM systems WHERE id IN (${marks})`).all(...ids);
    return new Map(rows.map(r => [r.id, r]));
}

/**
 * Turn a list of waypoints into legs with distance, travel time and biology requirement.
 * waypoints: [{ systemId, planetIndex }, ...] — at least two.
 * Returns { legs, totalSeconds, error }.
 */
function buildLegs(waypoints, { energy, raceSpeed, isAllianceMove, biology }) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) {
        return { error: 'A route needs at least a start and a target.' };
    }
    if (waypoints.length > MAX_LEGS + 1) {
        return { error: `A route can have at most ${MAX_LEGS} legs.` };
    }

    const ids = [...new Set(waypoints.map(w => parseInt(w.systemId, 10)).filter(Boolean))];
    const systems = loadSystems(ids);

    for (const w of waypoints) {
        const sys = systems.get(parseInt(w.systemId, 10));
        if (!sys) return { error: `System #${w.systemId} is not in the database — scan it in-game first.` };
        if (sys.x == null || sys.y == null) return { error: `System #${w.systemId} has no coordinates recorded yet.` };
    }

    const legs = [];
    let totalSeconds = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        const sa = systems.get(parseInt(a.systemId, 10));
        const sb = systems.get(parseInt(b.systemId, 10));
        const ap = Math.max(1, parseInt(a.planetIndex, 10) || 1);
        const bp = Math.max(1, parseInt(b.planetIndex, 10) || 1);

        const dx = sb.x - sa.x, dy = sb.y - sa.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const seconds = calcTravelSeconds(sa.x, sa.y, ap, sb.x, sb.y, bp, energy, raceSpeed, isAllianceMove);
        const bioNeeded = bioNeededFor(distance);

        totalSeconds += seconds;
        legs.push({
            legIndex: i,
            from: { systemId: sa.id, systemName: sa.name, planetIndex: ap, x: sa.x, y: sa.y },
            to: { systemId: sb.id, systemName: sb.name, planetIndex: bp, x: sb.x, y: sb.y },
            distance: Math.round(distance * 100) / 100,
            travelSeconds: seconds,
            travelTime: formatTime(seconds),
            bioNeeded,
            // Warning, not a block: intel on your own biology can be stale, and the
            // planner is also used to sketch routes for later.
            outOfReach: biology > 0 && bioNeeded > biology
        });
    }
    return { legs, totalSeconds };
}

// Attach arrival timestamps to each leg, given a planned departure.
function withSchedule(legs, plannedStartAt) {
    const startMs = plannedStartAt ? Date.parse(plannedStartAt) : NaN;
    if (isNaN(startMs)) return legs.map(l => ({ ...l, departsAt: null, arrivesAt: null }));
    let cursor = startMs;
    return legs.map(l => {
        const departsAt = new Date(cursor).toISOString();
        cursor += l.travelSeconds * 1000;
        return { ...l, departsAt, arrivesAt: new Date(cursor).toISOString() };
    });
}

function expiryFor(plannedStartAt, totalSeconds) {
    const startMs = plannedStartAt ? Date.parse(plannedStartAt) : NaN;
    if (!isNaN(startMs)) {
        return new Date(startMs + totalSeconds * 1000 + KEEP_AFTER_ARRIVAL_H * 3600 * 1000)
            .toISOString().replace('T', ' ').slice(0, 19);
    }
    return new Date(Date.now() + DEFAULT_TTL_DAYS * 86400 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);
}

// Routes rot fast — a plan for last Tuesday is noise. Sweep on read so the list is always
// current without needing a scheduler.
function purgeExpired() {
    try {
        const r = db.prepare(`DELETE FROM routes WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
        if (r.changes > 0) console.log(`[Routes] Removed ${r.changes} expired route(s).`);
    } catch (err) {
        console.error('[Routes] Expiry sweep failed:', err.message);
    }
}

function hydrate(routeRows) {
    if (!routeRows.length) return [];
    const ids = routeRows.map(r => r.id);
    const marks = ids.map(() => '?').join(',');
    const legs = db.prepare(`
        SELECT rl.*, sf.name AS from_system_name, sf.x AS from_x, sf.y AS from_y,
               st.name AS to_system_name,   st.x AS to_x,   st.y AS to_y
        FROM route_legs rl
        LEFT JOIN systems sf ON sf.id = rl.from_system_id
        LEFT JOIN systems st ON st.id = rl.to_system_id
        WHERE rl.route_id IN (${marks})
        ORDER BY rl.route_id, rl.leg_index
    `).all(...ids);

    const byRoute = new Map(ids.map(id => [id, []]));
    for (const l of legs) {
        byRoute.get(l.route_id).push({
            legIndex: l.leg_index,
            from: { systemId: l.from_system_id, systemName: l.from_system_name, planetIndex: l.from_planet_index, x: l.from_x, y: l.from_y },
            to: { systemId: l.to_system_id, systemName: l.to_system_name, planetIndex: l.to_planet_index, x: l.to_x, y: l.to_y },
            distance: l.distance,
            travelSeconds: l.travel_seconds,
            travelTime: formatTime(l.travel_seconds || 0),
            bioNeeded: l.bio_needed
        });
    }

    return routeRows.map(r => {
        // The reach warning is re-evaluated on read against the biology stored with the
        // route, so a shared route shows the same warning its author saw.
        const rl = (byRoute.get(r.id) || []).map(l => ({
            ...l,
            outOfReach: (r.biology || 0) > 0 && l.bioNeeded > r.biology
        }));
        const total = rl.reduce((s, l) => s + (l.travelSeconds || 0), 0);
        return {
            id: r.id,
            title: r.title,
            note: r.note,
            author: r.author_name || 'Unknown',
            authorId: r.author_id,
            plannedStartAt: r.planned_start_at,
            energy: r.energy,
            raceSpeed: r.race_speed,
            isAllianceMove: !!r.is_alliance_move,
            biology: r.biology,
            visibility: r.visibility,
            expiresAt: r.expires_at,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            totalSeconds: total,
            totalTime: formatTime(total),
            legs: withSchedule(rl, r.planned_start_at)
        };
    });
}

// --- PREVIEW: compute a route without saving it (the panel calls this as you type) ---
router.post('/routes/preview', requireAuth, (req, res) => {
    const { waypoints, energy, raceSpeed, isAllianceMove, biology, plannedStartAt } = req.body || {};
    const built = buildLegs(waypoints, {
        energy: parseInt(energy, 10) || 0,
        raceSpeed: parseInt(raceSpeed, 10) || 0,
        isAllianceMove: !!isAllianceMove,
        biology: parseInt(biology, 10) || 0
    });
    if (built.error) return res.status(400).json({ error: built.error });

    const legs = withSchedule(built.legs, plannedStartAt);
    res.json({
        success: true,
        legs,
        totalSeconds: built.totalSeconds,
        totalTime: formatTime(built.totalSeconds),
        arrivesAt: legs.length ? legs[legs.length - 1].arrivesAt : null
    });
});

// --- LIST: own routes plus everything shared with the alliance ---
router.get('/routes', requireAuth, (req, res) => {
    try {
        purgeExpired();
        const rows = db.prepare(`
            SELECT r.*, u.game_name AS author_name
            FROM routes r
            LEFT JOIN app_users u ON u.id = r.author_id
            WHERE r.visibility = 'alliance' OR r.author_id = ?
            ORDER BY COALESCE(r.planned_start_at, r.created_at) ASC
        `).all(req.session.userId);
        res.json({ success: true, routes: hydrate(rows) });
    } catch (err) {
        console.error('[DB Error] Failed to list routes:', err);
        res.status(500).json({ error: 'Failed to list routes' });
    }
});

router.get('/routes/:id', requireAuth, (req, res) => {
    try {
        const row = db.prepare(`
            SELECT r.*, u.game_name AS author_name
            FROM routes r LEFT JOIN app_users u ON u.id = r.author_id
            WHERE r.id = ?
        `).get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (row.visibility !== 'alliance' && row.author_id !== req.session.userId) {
            return res.status(403).json({ error: 'That route is private.' });
        }
        res.json({ success: true, route: hydrate([row])[0] });
    } catch (err) {
        console.error('[DB Error] Failed to load route:', err);
        res.status(500).json({ error: 'Failed to load route' });
    }
});

function writeRoute(routeId, body, authorId) {
    const energy = parseInt(body.energy, 10) || 0;
    const raceSpeed = parseInt(body.raceSpeed, 10) || 0;
    const biology = parseInt(body.biology, 10) || 0;
    const isAllianceMove = body.isAllianceMove ? 1 : 0;
    const visibility = body.visibility === 'private' ? 'private' : 'alliance';
    const plannedStartAt = body.plannedStartAt || null;

    const built = buildLegs(body.waypoints, { energy, raceSpeed, isAllianceMove: !!isAllianceMove, biology });
    if (built.error) return { error: built.error };

    const expiresAt = expiryFor(plannedStartAt, built.totalSeconds);
    const title = String(body.title || '').slice(0, 120) || null;
    const note = String(body.note || '').slice(0, 1000) || null;

    const tx = db.transaction(() => {
        let id = routeId;
        if (id) {
            db.prepare(`
                UPDATE routes SET title=?, note=?, planned_start_at=?, energy=?, race_speed=?,
                                  is_alliance_move=?, biology=?, visibility=?, expires_at=?,
                                  updated_at=CURRENT_TIMESTAMP
                WHERE id=?
            `).run(title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt, id);
            db.prepare(`DELETE FROM route_legs WHERE route_id = ?`).run(id);
        } else {
            const r = db.prepare(`
                INSERT INTO routes (author_id, title, note, planned_start_at, energy, race_speed,
                                    is_alliance_move, biology, visibility, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt);
            id = r.lastInsertRowid;
        }

        const ins = db.prepare(`
            INSERT INTO route_legs (route_id, leg_index, from_system_id, from_planet_index,
                                    to_system_id, to_planet_index, travel_seconds, distance, bio_needed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const l of built.legs) {
            ins.run(id, l.legIndex, l.from.systemId, l.from.planetIndex,
                    l.to.systemId, l.to.planetIndex, l.travelSeconds, l.distance, l.bioNeeded);
        }
        return id;
    });

    return { id: tx() };
}

router.post('/routes', requireAuth, (req, res) => {
    try {
        const out = writeRoute(null, req.body || {}, req.session.userId);
        if (out.error) return res.status(400).json({ error: out.error });
        res.json({ success: true, id: out.id });
    } catch (err) {
        console.error('[DB Error] Failed to save route:', err);
        res.status(500).json({ error: 'Failed to save route' });
    }
});

// Same rule as planet_plans: the author or an admin, nobody else. Orphaned rows (author
// deleted, so author_id is NULL) are editable by anyone so they can be cleaned up.
function mayModify(row, session) {
    return session.role === 'admin' || row.author_id === session.userId || row.author_id == null;
}

router.put('/routes/:id', requireAuth, (req, res) => {
    try {
        const row = db.prepare(`SELECT id, author_id FROM routes WHERE id = ?`).get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (!mayModify(row, req.session)) {
            return res.status(403).json({ error: 'That route belongs to someone else. Ask them or an admin to change it.' });
        }
        const out = writeRoute(row.id, req.body || {}, row.author_id);
        if (out.error) return res.status(400).json({ error: out.error });
        res.json({ success: true, id: row.id });
    } catch (err) {
        console.error('[DB Error] Failed to update route:', err);
        res.status(500).json({ error: 'Failed to update route' });
    }
});

router.delete('/routes/:id', requireAuth, (req, res) => {
    try {
        const row = db.prepare(`SELECT id, author_id FROM routes WHERE id = ?`).get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (!mayModify(row, req.session)) {
            return res.status(403).json({ error: 'That route belongs to someone else. Ask them or an admin to remove it.' });
        }
        db.prepare(`DELETE FROM route_legs WHERE route_id = ?`).run(row.id);
        db.prepare(`DELETE FROM routes WHERE id = ?`).run(row.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to delete route:', err);
        res.status(500).json({ error: 'Failed to delete route' });
    }
});

// --- ANNOUNCE: one click to the alliance Discord channel ---
router.post('/routes/:id/announce', requireAuth, async (req, res) => {
    try {
        const row = db.prepare(`
            SELECT r.*, u.game_name AS author_name
            FROM routes r LEFT JOIN app_users u ON u.id = r.author_id
            WHERE r.id = ?
        `).get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (row.visibility !== 'alliance' && row.author_id !== req.session.userId) {
            return res.status(403).json({ error: 'That route is private.' });
        }

        const route = hydrate([row])[0];
        const startLine = route.plannedStartAt
            ? `Departs <t:${Math.floor(Date.parse(route.plannedStartAt) / 1000)}:F> (<t:${Math.floor(Date.parse(route.plannedStartAt) / 1000)}:R>)`
            : 'No planned start time';

        const legLines = route.legs.map(l => {
            const from = `[${l.from.systemId}] ${defuseMentions(l.from.systemName || '?')} #${l.from.planetIndex}`;
            const to = `[${l.to.systemId}] ${defuseMentions(l.to.systemName || '?')} #${l.to.planetIndex}`;
            const eta = l.arrivesAt ? ` — arrives <t:${Math.floor(Date.parse(l.arrivesAt) / 1000)}:t>` : '';
            return `**${l.legIndex + 1}.** ${from} → ${to}\n\`${l.travelTime}\` · dist ${l.distance} · bio ${l.bioNeeded}${eta}`;
        }).join('\n');

        const embed = {
            title: `🗺️ ${defuseMentions(route.title || 'Planned route')}`,
            color: 0x8b5cf6,
            description: [
                `by **${defuseMentions(route.author)}**`,
                startLine,
                '',
                legLines,
                '',
                `**Total:** \`${route.totalTime}\`${route.isAllianceMove ? ' (allied move, halved)' : ''}`,
                route.note ? `\n${defuseMentions(route.note)}` : ''
            ].filter(Boolean).join('\n'),
            footer: { text: `Energy ${route.energy} · race speed ${route.raceSpeed >= 0 ? '+' : ''}${route.raceSpeed}` }
        };

        const result = await postEmbed('discord_announce_channel', embed);
        if (!result.ok) return res.status(502).json({ error: `Could not post to Discord: ${result.reason}` });
        res.json({ success: true, messageId: result.messageId });
    } catch (err) {
        console.error('[Routes] Announce failed:', err);
        res.status(500).json({ error: 'Announce failed' });
    }
});

module.exports = router;
module.exports.buildLegs = buildLegs;
module.exports.withSchedule = withSchedule;
module.exports.expiryFor = expiryFor;
