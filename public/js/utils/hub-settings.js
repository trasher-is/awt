// What a member can switch on or off in the hub, and the rules for remembering it.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// The hub adds a lot to the game's own pages and a lot of tools to its sidebar, and not
// every member wants all of it: members asked to lose the Supply Unit buttons and the
// building hints on the planet page, and a few tools (Battle Calc, Road to TA, Build Order,
// Empire Simulator) are not ready for everyone. This file is the ONE list of what can be
// switched, with each item's default; the Settings panel is drawn from it, the sidebar and
// the game-page hooks consult it, and the server validates against it.
//
// What is stored is only the DIFFERENCE from the defaults (same idea as column-prefs.js),
// so an extra added in a later release follows its own default instead of being forced on
// or off by a stale blob, and a member who never opened Settings stores nothing at all.
//
// What is NOT here, on purpose: anything the alliance relies on for shared data — the map
// and system sidebar, the News-page incoming-fleet tools, the background scans. Those are
// not preferences. And Settings itself, Link Discord and Logout can never be hidden.
//
// LOADING: same dual Node/browser pattern as column-prefs.js/travel-model.js.
//   • Node:    require('../../public/js/utils/hub-settings.js')
//   • Browser: import '../utils/hub-settings.js';  then read globalThis.AWHubSettings
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWHubSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ─── SIDEBAR TOOLS ────────────────────────────────────────────────────────
    // `button` is the id of the sidebar button in Wrapper.html. Switching a tool off hides
    // that button; the tool's panel and data are untouched.
    const tool = (key, label, icon, button, extra) => Object.assign({ kind: 'tool', key: `tool.${key}`, label, icon, button, defaultOn: true }, extra);
    const OFF = { defaultOn: false };

    const TOOLS = [
        tool('defence', 'Defence', 'fa-shield-halved', 'open-defence-btn'),
        tool('galaxyDashboard', 'Galaxy Dashboard', 'fa-gauge-high', 'open-galaxy-dashboard-btn'),
        tool('warRoom', 'War Room', 'fa-bomb', 'open-war-room-btn'),
        tool('allianceStats', 'Alliance Stats', 'fa-chess', 'open-alliance-stats-btn'),
        tool('tradeAgreements', 'Trade Agreements', 'fa-handshake', 'open-trade-agreements-btn'),
        tool('roadToTa', 'Road to TA', 'fa-road', 'open-road-to-ta-btn', Object.assign({ note: 'Experimental' }, OFF)),
        tool('sleepMap', 'Sleep Map', 'fa-moon', 'open-sleep-map-btn'),
        tool('players', 'Players', 'fa-hand-fist', 'open-players-db-btn'),
        tool('systems', 'Systems', 'fa-meteor', 'open-systems-db-btn'),
        tool('planets', 'Planets', 'fa-globe', 'open-planets-db-btn'),
        tool('fleets', 'Fleets', 'fa-crow', 'open-fleets-db-btn'),
        tool('fleetLocations', 'Fleet Locations', 'fa-crosshairs', 'open-fleet-locations-btn'),
        tool('battleCalc', 'Battle Calc', 'fa-explosion', 'open-battle-calc-btn', Object.assign({ note: 'Experimental' }, OFF)),
        tool('battleReports', 'Battle Reports', 'fa-file-medical', 'open-battle-reports-btn'),
        tool('travelCalc', 'Travel Calc', 'fa-route', 'open-travel-calc-btn'),
        tool('buildOrder', 'Build Order', 'fa-diagram-project', 'open-build-order-btn', OFF),
        tool('empireSim', 'Empire Simulator', 'fa-chart-line', 'open-empire-sim-btn', OFF),
        tool('routePlanner', 'Route Planner', 'fa-map-location-dot', 'open-route-planner-btn'),
        tool('galaxyArchive', 'Galaxy Archive', 'fa-satellite-dish', 'open-galaxy-map-btn'),
    ];

    // ─── GAME-PAGE EXTRAS ─────────────────────────────────────────────────────
    // Each one is a single hook in spy.js's view-hook pass (public/js/core/spy.js), gated by
    // its key; a test pins that every key here is gated there and the other way round.
    const GROUPS = [
        { id: 'planet', label: 'Planet page' },
        { id: 'planets', label: 'Planets list' },
        { id: 'science', label: 'Science page' },
        { id: 'fleets', label: 'Fleets and launching' },
        { id: 'systems', label: 'Systems and news' },
        { id: 'profiles', label: 'Profiles and rankings' },
        { id: 'everywhere', label: 'Every page' },
    ];

    const inject = (key, group, label, description) => ({ kind: 'inject', key: `inject.${key}`, group, label, description, defaultOn: true });

    const INJECTIONS = [
        inject('suButtons', 'planet', 'Supply Unit buttons', '+1 SU and +All SU on each building row. One tap spends once.'),
        inject('buildingHints', 'planet', 'Building value hints', 'The “~ PP cheaper” and “SU ↓%” chips beside each building.'),
        inject('starbaseTimer', 'planet', 'Starbase timer', 'Time left drawn on the Starbase progress bar.'),
        inject('autoProduceDates', 'planet', 'Auto Produce finish dates', 'The real finish time of every queued item, not just the first.'),

        inject('popTimers', 'planets', 'Population timers', 'Time left and finish date on each planet’s population bar.'),

        inject('cultureLookahead', 'science', 'Culture look-ahead', 'How long until each of the next three Culture levels.'),
        inject('scienceTimers', 'science', 'Research queue dates', 'A finish date beside each queued research.'),
        inject('scienceCalculator', 'science', 'Science level calculator', 'Pick a science and a target level for the total time and finish date.'),
        inject('colonizeWindows', 'science', 'Colonization launch windows', 'The earliest safe launch time for each planned target.'),
        inject('socialHint', 'science', 'Social marker', 'A triangle by Social when planets sit at the population cap.'),
        inject('economyMilestone', 'science', 'Economy price-drop countdown', 'The next Economy level that really lowers ship prices.'),
        inject('bioThreats', 'science', 'Biology threat pills', 'Red and yellow pills counting players 6+ Biology above you.'),

        inject('fleetTimers', 'fleets', 'Fleet arrival countdown', 'Time remaining, counted to the real landing tick.'),
        inject('launchEta', 'fleets', 'Launch-picker ETAs', 'Arrival time for each fleet in the “Select a fleet” popup.'),
        inject('launchDossier', 'fleets', 'Launch target intel', 'What the hub knows about the target, under the launch form.'),
        inject('launchPlanLinks', 'fleets', 'Launch plan links', 'Your planned targets as one-tap fills on the launch form.'),

        inject('systemPlan', 'systems', 'System plan note', 'The admins’ standing note on a system page.'),
        inject('newsBroadcasts', 'systems', 'Alliance broadcasts', 'Alliance announcements at the top of the News page.'),

        inject('profilePlGrowth', 'profiles', 'Player Level growth ETA', 'When the next Player Level lands, on profiles.'),
        inject('profileIntel', 'profiles', 'Profile activity and intel', 'Login heatmap and last-known intel. Also hides the Supporter promo.'),
        inject('ecoBonusJoined', 'profiles', 'Eco Bonus join dates', 'A “joined” column on the Eco Bonus ranking.'),

        inject('localTimestamps', 'everywhere', 'Ranking times in your time zone', 'Shows ranking timestamps on your own clock.'),
        inject('allianceIcons', 'everywhere', 'Alliance relation icons', 'An icon after the [TAG] of allied and war alliances.'),
    ];

    const ALL = Object.freeze([...TOOLS, ...INJECTIONS].map(Object.freeze));
    const BY_KEY = new Map(ALL.map(item => [item.key, item]));

    const isBool = v => v === true || v === false;
    const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

    /** What an item does when nothing is stored for it. Unknown keys: false. */
    function defaultFor(key) {
        const item = BY_KEY.get(key);
        return item ? item.defaultOn : false;
    }

    /**
     * Keep only what is worth storing: known keys, boolean values, and only those that
     * differ from the default. Anything else (a key a later release removed, a corrupt
     * value) is dropped rather than carried forever.
     */
    function sanitizeOverrides(raw) {
        const out = {};
        if (!isPlainObject(raw)) return out;
        for (const item of ALL) {
            const v = raw[item.key];
            if (isBool(v) && v !== item.defaultOn) out[item.key] = v;
        }
        return out;
    }

    /** Read a stored JSON string back; null, junk or the wrong shape is "nothing stored". */
    function parseStored(text) {
        if (typeof text !== 'string' || !text) return {};
        try { return sanitizeOverrides(JSON.parse(text)); } catch (err) { return {}; }
    }

    /**
     * Apply a batch of {key: boolean} to the stored overrides. Unknown keys are ignored;
     * setting a key to its default removes it. The caller has already checked the shape —
     * see invalidChanges.
     */
    function applyChanges(overrides, changes) {
        const next = sanitizeOverrides(overrides);
        if (!isPlainObject(changes)) return next;
        for (const item of ALL) {
            const v = changes[item.key];
            if (!isBool(v)) continue;
            if (v === item.defaultOn) delete next[item.key];
            else next[item.key] = v;
        }
        return next;
    }

    /** Why a `changes` payload is unusable, or null. Unknown keys are fine; wrong types are not. */
    function invalidChanges(changes) {
        if (!isPlainObject(changes)) return 'changes must be an object of {key: true|false}';
        for (const [key, value] of Object.entries(changes)) {
            if (!isBool(value)) return `"${key}" must be true or false`;
        }
        return null;
    }

    /**
     * Is this switched on? An unknown key reads as ON: a typo in a call site must never
     * quietly remove a feature (the tests pin that every key a call site uses exists).
     */
    function isEnabled(key, overrides) {
        if (!BY_KEY.has(key)) return true;
        const v = overrides ? overrides[key] : undefined;
        return isBool(v) ? v : BY_KEY.get(key).defaultOn;
    }

    /** Every catalogue key mapped to its effective true/false. */
    function resolve(overrides) {
        const out = {};
        for (const item of ALL) out[item.key] = isEnabled(item.key, overrides);
        return out;
    }

    return { TOOLS, INJECTIONS, GROUPS, ALL, defaultFor, sanitizeOverrides, parseStored, applyChanges, invalidChanges, isEnabled, resolve };
});
