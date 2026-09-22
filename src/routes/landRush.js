// GET /hub-api/intel/land-rush — how much unclaimed galaxy is left, and how long it lasts.
//
// The analysis lives in src/utils/land-rush.js, with the reasoning for why a snapshot count
// of free planets is not by itself an honest number. This file is the three queries that
// feed it plus the shaping of one response.
//
// Mounted from src/routes/api.js as its own router rather than as another handful of
// handlers in intel.js, because intel.js is already 990 lines and because a new file is a
// file set no other branch is touching.

const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { ownAllianceTags } = require('../utils/friendly-alliance-tags');
const landRush = require('../utils/land-rush');

const router = express.Router();

// planet_events stores the type by id; the ids are seeded rows, not constants, so the id
// is looked up by name. A hardcoded 1 would keep working right up until someone reseeds
// the table in a different order and the panel silently starts counting population drops.
function ownerChangeTypeId() {
    const row = db.prepare(`SELECT id FROM event_types WHERE name = 'OWNER_CHANGE'`).get();
    return row ? row.id : null;
}

// A planet the hub last saw with no owner, and WHEN it last saw it. population_observed_at
// is the more precise of the two when a scan recorded it; updated_at is the fallback.
const FREE_PLANETS_SQL = `
    SELECT system_id, planet_index,
           COALESCE(population_observed_at, updated_at) AS observed_at
    FROM planets
    WHERE owner_id IS NULL
`;

// Colonisations only: an OWNER_CHANGE with no previous owner. A conquest moves a planet
// between two owners and does not consume free land, so counting it here would inflate the
// rate at which the galaxy is filling up. old_value arrives as NULL or as an empty string
// depending on how the row was written, and both mean "nobody held it".
const COLONISATIONS_SQL = `
    SELECT pe.system_id, pe.timestamp, a.tag AS alliance_tag
    FROM planet_events pe
    LEFT JOIN players p ON p.id = pe.new_value
    LEFT JOIN alliances a ON a.id = p.alliance_id
    WHERE pe.event_type_id = ?
      AND (pe.old_value IS NULL OR pe.old_value = '')
    ORDER BY pe.timestamp
`;

const CONQUESTS_SQL = `
    SELECT COALESCE(ao.tag, '') AS from_tag, COALESCE(an.tag, '') AS to_tag, COUNT(*) AS planets
    FROM planet_events pe
    LEFT JOIN players po ON po.id = pe.old_value
    LEFT JOIN alliances ao ON ao.id = po.alliance_id
    LEFT JOIN players pn ON pn.id = pe.new_value
    LEFT JOIN alliances an ON an.id = pn.alliance_id
    WHERE pe.event_type_id = ?
      AND pe.old_value IS NOT NULL AND pe.old_value <> ''
      AND pe.timestamp >= datetime('now', ?)
    GROUP BY from_tag, to_tag
    ORDER BY planets DESC
`;

// Where "near us" is measured from: the centre of the planets our own alliance holds.
// Null when the hub does not yet know which alliance is ours or holds no indexed planets —
// the frontier then comes back without distances rather than with distances from nowhere.
function ourCentre() {
    const tags = [...ownAllianceTags()];
    if (!tags.length) return null;
    const placeholders = tags.map(() => '?').join(',');
    const row = db.prepare(`
        SELECT AVG(s.x) AS x, AVG(s.y) AS y, COUNT(*) AS planets
        FROM planets pl
        JOIN players p ON p.id = pl.owner_id
        JOIN alliances a ON a.id = p.alliance_id
        JOIN systems s ON s.id = pl.system_id
        WHERE UPPER(a.tag) IN (${placeholders}) AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).get(...tags.map(t => String(t).toUpperCase()));
    if (!row || !row.planets || !Number.isFinite(row.x) || !Number.isFinite(row.y)) return null;
    return { x: row.x, y: row.y, planets: row.planets, tags };
}

router.get('/intel/land-rush', requireAuth, (req, res) => {
    // A value that is not a positive integer is not clamped into range, it is ignored: a
    // caller asking for -4 hours of freshness has not asked for one hour, they have sent
    // nonsense, and answering nonsense with a plausible number is how a wrong answer gets
    // believed.
    const posInt = (raw, fallback, max) => {
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 1 ? Math.min(max, n) : fallback;
    };
    const windowDays = posInt(req.query.days, 7, 30);
    const freshHours = posInt(req.query.freshHours, 72, 720);
    const limit = posInt(req.query.limit, 40, 200);

    try {
        const now = Date.now();
        const typeId = ownerChangeTypeId();
        if (typeId === null) {
            return res.status(500).json({ success: false, error: 'OWNER_CHANGE event type is missing from this database' });
        }

        const free = db.prepare(FREE_PLANETS_SQL).all();
        const colonisations = db.prepare(COLONISATIONS_SQL).all(typeId);
        const systems = db.prepare(`SELECT id, name, x, y FROM systems`).all();
        const conquests = db.prepare(CONQUESTS_SQL).all(typeId, `-${windowDays} days`);
        const origin = ourCentre();

        const freshness = landRush.freshnessBuckets(free, { now });
        const withinHorizon = landRush.freeWithin(free, freshHours, { now });
        const rate = landRush.claimRate(colonisations, { now, windowDays });
        const frontier = landRush.systemFrontier(free, colonisations, systems, { now, windowDays, origin });

        // One drift per alliance that has been colonising, so "who is moving, and which way"
        // is answerable without asking the panel to re-slice the event list.
        const tags = [...new Set(colonisations.map(c => c.alliance_tag).filter(Boolean))];
        const drift = tags.map(tag => {
            const moved = landRush.expansionDrift(colonisations.filter(c => c.alliance_tag === tag), systems,
                { now, windowDays: Math.max(4, windowDays * 2) });
            return moved ? { tag, ...moved } : null;
        }).filter(Boolean).sort((a, b) => b.late.claims - a.late.claims);

        res.json({
            success: true,
            generatedAt: now,
            windowDays,
            freshHours,
            free: {
                total: freshness.total,
                withinHorizon,
                buckets: freshness.buckets,
                older: freshness.older.planets,
                unknown: freshness.unknown,
            },
            rate,
            // Two projections on purpose: everything the hub believes is free, and only what
            // it has actually looked at recently. The gap between them IS the uncertainty,
            // and showing one number would hide it.
            projection: {
                onEverythingKnownFree: landRush.projectExhaustion(freshness.total, rate.claimsPerDay, { now }),
                onRecentlyConfirmed: landRush.projectExhaustion(withinHorizon, rate.claimsPerDay, { now }),
            },
            frontier: frontier.slice(0, limit),
            frontierSystems: frontier.length,
            contested: landRush.contestedSystems(frontier).slice(0, limit),
            drift,
            conquests,
            origin: origin ? { x: origin.x, y: origin.y, planets: origin.planets, tags: origin.tags } : null,
        });
    } catch (err) {
        console.error('[API] Land rush failed:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

module.exports = router;
