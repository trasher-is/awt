const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.AWT_DB_PATH || path.join(__dirname, '..', 'awt.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Wait up to 10s for a contended write lock instead of throwing SQLITE_BUSY immediately
// (e.g. PM2 restart overlap, backups, or a long galaxy-sync transaction).
db.pragma('busy_timeout = 10000');

// SQLite has no "ADD COLUMN IF NOT EXISTS", so every additive migration below is a
// plain ALTER that is expected to fail once the column exists. "duplicate column name"
// is therefore the ONLY error worth ignoring: swallowing everything else would hide a
// locked, full or corrupt database behind a schema that is quietly missing columns,
// and the failure would only surface much later as an INSERT against a column that
// was never added.
function addColumn(table, column, definition) {
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`[DB] Added ${column} column to ${table} table.`);
    } catch (e) {
        if (/duplicate column name/i.test(e.message)) return;
        throw new Error(`[DB] Migration failed on ${table}.${column}: ${e.message}`);
    }
}

function initDatabase() {
    // 1. Admin Control
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            is_active INTEGER DEFAULT 1
        )
    `);

    // 2. Alliances
    db.exec(`
        CREATE TABLE IF NOT EXISTS alliances (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            tag TEXT COLLATE NOCASE,
            leader_id INTEGER,
            ranking INTEGER,
            points_update INTEGER,
            points_current INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    addColumn('alliances', 'full_name', 'TEXT');
    addColumn('alliances', 'member_count', 'INTEGER');

    // 3. Players (Flat Table)
    db.exec(`
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE,
            alliance_id INTEGER,
            
            -- Constants
            country TEXT,
            local_time TEXT,
            origin_system INTEGER,
            race_growth INTEGER DEFAULT 0,
            race_science INTEGER DEFAULT 0,
            race_culture INTEGER DEFAULT 0,
            race_production INTEGER DEFAULT 0,
            race_speed INTEGER DEFAULT 0,
            race_attack INTEGER DEFAULT 0,
            race_defense INTEGER DEFAULT 0,
            race_trader INTEGER DEFAULT 0,
            race_sul INTEGER DEFAULT 0,
            
            -- Variables (Core)
            level INTEGER DEFAULT 0,
            science_level INTEGER DEFAULT 0,
            culture_level INTEGER DEFAULT 0,
            points INTEGER DEFAULT 0,
            ranking INTEGER,
            
            -- Variables (Economy & Output)
            astro_dollars INTEGER DEFAULT 0,
            production_points INTEGER DEFAULT 0,
            production_rate INTEGER DEFAULT 0,
            science_rate INTEGER DEFAULT 0,
            culture_rate INTEGER DEFAULT 0,
            
            -- Variables (Infrastructure & Limits)
            total_planets INTEGER DEFAULT 0,
            total_population INTEGER DEFAULT 0,
            total_farms INTEGER DEFAULT 0,
            total_factories INTEGER DEFAULT 0,
            total_labs INTEGER DEFAULT 0,
            total_cybernetics INTEGER DEFAULT 0,
            cv_used INTEGER DEFAULT 0,
            cv_limit INTEGER DEFAULT 0,
            
            -- Variables (Sciences)
            biology INTEGER DEFAULT 0,
            economy INTEGER DEFAULT 0,
            energy INTEGER DEFAULT 0,
            mathematics INTEGER DEFAULT 0,
            physics INTEGER DEFAULT 0,
            social INTEGER DEFAULT 0,
            
            -- Variables (Trade & Misc)
            trade_revenue INTEGER DEFAULT 0,
            trade_partners TEXT, -- Stored as a JSON array of player IDs: e.g., '[42, 89, 103]'
            artefact TEXT,
            
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(alliance_id) REFERENCES alliances(id) ON DELETE SET NULL
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS player_name_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            old_name TEXT NOT NULL,
            changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
        )
    `);

    addColumn('players', 'eco_bonus', 'INTEGER DEFAULT 0');
    addColumn('players', 'joined', 'TEXT');
    addColumn('players', 'logins', 'INTEGER DEFAULT 0');
    // Safely inject the new idle_time column if it doesn't exist
    addColumn('players', 'idle_time', 'TEXT');
    addColumn('app_users', 'discord_name', 'TEXT');
    // Numeric Discord user id (snowflake) for real @mentions. Backfilled automatically
    // when a linked user runs any bot command — see discord_bot messageCreate handler.
    addColumn('app_users', 'discord_id', 'TEXT');
    addColumn('players', 'has_intel', 'INTEGER DEFAULT 0');
    addColumn('players', 'intel_updated_at', 'TEXT');
    addColumn('players', 'home_planet_id', 'INTEGER');
    addColumn('players', 'home_system_id', 'INTEGER');
    addColumn('players', 'home_planet_index', 'INTEGER');
    addColumn('players', 'possible_homes', 'TEXT');
    addColumn('players', 'is_active_player', 'INTEGER');
    addColumn('players', 'last_activity_at', 'DATETIME');
    addColumn('players', 'last_login_at', 'DATETIME');
    addColumn('players', 'resigned_at', 'DATETIME');
    addColumn('players', 'number_of_battles', 'INTEGER');
    addColumn('players', 'battle_luckiness', 'REAL');
    addColumn('players', 'multi_status', 'TEXT');
    addColumn('players', 'is_top_permanent_ranker', 'INTEGER');
    addColumn('players', 'has_supporter_badge', 'INTEGER');
    addColumn('players', 'supporter_type', 'TEXT');
    addColumn('players', 'last_api_scan_at', 'DATETIME');

    // NOTE: the migrations for player_logins.total_logins and fleets.arrival_at used to
    // sit here, above the CREATE TABLE statements for those two tables. On a fresh
    // database they therefore failed with "no such table", the error was swallowed, and
    // the table was then created without the column — leaving the first boot of a new
    // install with a schema that INSERTs in routes/sync.js reference but that does not
    // exist. Only a second start repaired it. Both columns are now part of the base
    // CREATE TABLE below, with the ALTER kept immediately after it for databases that
    // predate them.

    // 4. Map & Systems
    db.exec(`
        CREATE TABLE IF NOT EXISTS systems (
            id INTEGER PRIMARY KEY,
            name TEXT,
            x INTEGER,
            y INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // --- NEW TABLE: RANKINGS AUTOMATION BLOCK (BEST GUARDED) ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS best_guarded (
            game_planet_id INTEGER PRIMARY KEY,
            cv TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS planets (
            game_planet_id INTEGER UNIQUE,
            system_id INTEGER,
            planet_index INTEGER,
            owner_id INTEGER,
            population INTEGER DEFAULT 0,
            starbase INTEGER DEFAULT 0,
            
            -- High-performance "boolean" flags (0=False, 1=True)
            is_ally INTEGER DEFAULT 0,
            has_fleet INTEGER DEFAULT 0,
            is_sieged INTEGER DEFAULT 0,
            
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (system_id, planet_index),
            FOREIGN KEY(system_id) REFERENCES systems(id) ON DELETE CASCADE,
            FOREIGN KEY(owner_id) REFERENCES players(id) ON DELETE SET NULL
        )
    `);

    addColumn('systems', 'full_name', 'TEXT');
    addColumn('systems', 'info', 'TEXT');
    addColumn('systems', 'population_level', 'INTEGER');
    addColumn('systems', 'is_in_vision', 'INTEGER');
    addColumn('planets', 'name', 'TEXT');

    // 4.5 Alliance Meta-Data (Planning)
    db.exec(`
        CREATE TABLE IF NOT EXISTS planet_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            system_id INTEGER,
            planet_index INTEGER,
            author_id INTEGER, 
            note TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(system_id) REFERENCES systems(id) ON DELETE CASCADE,
            FOREIGN KEY(author_id) REFERENCES app_users(id) ON DELETE SET NULL
        )
    `);

    // 5. Fleets
    db.exec(`
        CREATE TABLE IF NOT EXISTS fleets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_fleet_id INTEGER, 
            owner_id INTEGER,
            system_id INTEGER,
            planet_index INTEGER,
            destination_system_id INTEGER,
            destination_planet_index INTEGER,
            transports INTEGER DEFAULT 0,
            colony_ships INTEGER DEFAULT 0,
            destroyers INTEGER DEFAULT 0,
            cruisers INTEGER DEFAULT 0,
            battleships INTEGER DEFAULT 0,
            combat_value INTEGER DEFAULT 0,
            arrival_time DATETIME,
            -- Absolute (UTC ISO) landing time for in-flight fleets, computed browser-side
            -- at scrape time. arrival_time above is the raw scraped string.
            arrival_at TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(owner_id) REFERENCES players(id) ON DELETE CASCADE
        )
    `);

    // For databases created before arrival_at was part of the CREATE above.
    addColumn('fleets', 'arrival_at', 'TEXT');

    // 6. History Logs & Event Types
    db.exec(`
        CREATE TABLE IF NOT EXISTS event_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )
    `);

    // Pre-populate the event types dictionary
    db.exec(`
        INSERT OR IGNORE INTO event_types (id, name) VALUES 
        (1, 'OWNER_CHANGE'),
        (2, 'POP_DROP'),
        (3, 'BATTLE'),
        (4, 'SIEGE')
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS planet_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            system_id INTEGER NOT NULL,
            planet_index INTEGER NOT NULL,
            event_type_id INTEGER NOT NULL,
            old_value INTEGER,
            new_value INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(system_id) REFERENCES systems(id) ON DELETE CASCADE,
            FOREIGN KEY(event_type_id) REFERENCES event_types(id)
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS player_logins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            total_logins INTEGER DEFAULT 0,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
        )
    `);

    // For databases created before total_logins was part of the CREATE above.
    addColumn('player_logins', 'total_logins', 'INTEGER DEFAULT 0');

    // Alliance Admin Broadcasts System (Updated for Custom Time Strings)
    db.exec(`
        CREATE TABLE IF NOT EXISTS alliance_broadcasts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT DEFAULT 'Attention!!!',
            message TEXT NOT NULL,
            author_name TEXT NOT NULL,
            display_time TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // --- NEW TABLE: ALLIANCE MEMBER DETAILED METRICS ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS alliance_member_stats (
            player_id INTEGER PRIMARY KEY,
            planets_text TEXT,
            next_culture_at DATETIME,
            science_rate TEXT,
            culture_rate TEXT,
            production_rate TEXT,
            astro_dollars TEXT,
            production_points TEXT,
            artefact TEXT,
            level_text TEXT,
            cv_limit_text TEXT,
            economy INTEGER,
            energy INTEGER,
            mathematics INTEGER,
            physics INTEGER,
            population INTEGER,
            hoarded_au INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // A$ value of artifacts + supply units a member is holding (scraped from their
    // /Game/Trade inventory). Added here so existing DBs pick it up too.
    addColumn('alliance_member_stats', 'hoarded_au', 'INTEGER DEFAULT 0');

    // --- SYSTEM TAKEOVER CAMPAIGN TABLE ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS planet_takeovers (
            system_id INTEGER,
            planet_index INTEGER,
            assigned_name TEXT,
            pipeline_status INTEGER DEFAULT 1, -- 1=Recon/Targets, 2=Breaking, 3=Cleared/Ready, 4=Secured
            target_arrival_time TEXT,          -- User-chosen local completion time (HH:MM:SS)
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (system_id, planet_index)
        )
    `);

    // --- COLLABORATIVE TRADE AGREEMENTS ---
    // Lifecycle: proposed -> confirmed -> done. pair_key is the lowercased, sorted
    // "a|b" so each unordered pair is unique regardless of who proposed it.
    db.exec(`
        CREATE TABLE IF NOT EXISTS trade_agreements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pair_key TEXT NOT NULL UNIQUE,
            player_a TEXT NOT NULL,
            player_b TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'proposed',
            initiator TEXT,
            is_admin_set INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // --- GENERIC KEY/VALUE SETTINGS STORE ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // --- DISCORD INCOMING ALERT TRACKING ---
    // Maps a game attacking-fleet id to the Discord message announcing it, so the
    // News-page "send to Discord" button can EDIT the existing alert (updated attacker
    // intel) instead of spamming a new one each time. channel_id is stored so we send
    // fresh if the configured incoming channel changed since the original post.
    db.exec(`
        CREATE TABLE IF NOT EXISTS incoming_alerts (
            fleet_id INTEGER PRIMARY KEY,
            channel_id TEXT,
            message_id TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Comma-joined sorted names of defenders who could arrive in time at the last announce.
    // When this set GAINS someone (fleet built / TT recalc), we post a reply that pings
    // the defenders — edits alone never notify anyone.
    addColumn('incoming_alerts', 'last_ontime', 'TEXT');

    // Incoming alerts keyed by the attack identity (system:planet:attacker) rather than a
    // game fleet id, so the auto-posted webhook message and the News-page "announce" both
    // edit the SAME Discord message for a given incoming.
    db.exec(`
        CREATE TABLE IF NOT EXISTS incoming_msgs (
            alert_key TEXT PRIMARY KEY,
            channel_id TEXT,
            message_id TEXT,
            last_ontime TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Newline-joined names of defenders who clicked "I cover this" (on the News panel or
    // the Discord alert button). Rendered as a "Covering:" line on the incoming message so
    // everyone can see who has defence on the way.
    addColumn('incoming_msgs', 'covering', 'TEXT');

    // Personal task/reminder notes (per-user, private). due_at is optional — a note with
    // no due date is a plain checklist item; one with a due date participates in the
    // overdue/red styling, the sidebar countdown badge, and (if remind_15 is set) the
    // 15-minutes-before Discord mention reminder.
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            due_at TEXT,
            remind_15 INTEGER DEFAULT 0,
            reminded_at TEXT,
            done INTEGER DEFAULT 0,
            done_at TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(owner_id) REFERENCES app_users(id) ON DELETE CASCADE
        )
    `);

    // Who assigned the note — set to the creator's own id for a normal personal note, or
    // to a teammate's id when a note was created "for" someone else. A note shared with N
    // recipients is stored as N independent rows (one per owner_id), all sharing the same
    // author_id, so each recipient's copy/reminder/done-state is fully independent while
    // still showing "from <author>" on the ones that weren't self-authored.
    addColumn('user_notes', 'author_id', 'INTEGER');

    // Shared, login-gated planning notes for the redzone (rz.*) proxy — one note per
    // planet, visible to everyone who entered the shared password. Keyed by the game's
    // own global planet id (data-planet-id). Not per-user: it's a communal scratchpad, so
    // no owner column. See src/routes/rzhub.js.
    db.exec(`
        CREATE TABLE IF NOT EXISTS rz_plans (
            planet_id INTEGER PRIMARY KEY,
            text TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // --- DISCORD TIMERS ---
    // !timer used to be a bare setTimeout in process memory, so a restart or a deploy
    // silently dropped every pending one. Rows here are polled by the same minute-
    // resolution scheduler that already drives note reminders, which also means a timer
    // that came due while the bot was down fires on the next tick instead of vanishing.
    db.exec(`
        CREATE TABLE IF NOT EXISTS discord_timers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            label TEXT,
            due_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            fired_at DATETIME
        )
    `);

    // --- DISCORD ACCOUNT LINK CODES ---
    // !link could previously claim any unlinked Hub account by name, proving nothing.
    // A code is minted in the Hub panel, where the person is already authenticated, and
    // spent in Discord — so the pairing is only possible for someone who holds both.
    // Codes are single-use and short-lived; used/expired rows are swept on read.
    db.exec(`
        CREATE TABLE IF NOT EXISTS discord_link_codes (
            code TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            used_at DATETIME,
            used_by_discord_id TEXT
        )
    `);

    // --- SHARED ROUTE PLANS ---
    // A planned multi-leg fleet movement (start -> jump -> target), visible to the rest
    // of the alliance. Same attribution model as planet_plans and rz_plans: the author is
    // recorded, and only the author or an admin may change or delete a row.
    db.exec(`
        CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
            title TEXT,
            note TEXT,
            planned_start_at DATETIME,
            energy INTEGER DEFAULT 0,
            race_speed INTEGER DEFAULT 0,
            is_alliance_move INTEGER DEFAULT 0,
            biology INTEGER DEFAULT 0,
            visibility TEXT DEFAULT 'alliance',
            expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // One row per hop. leg_index is 0-based and dense; travel_seconds is computed
    // server-side from the shared formula at save time so every viewer sees the same
    // number regardless of their own energy or race.
    db.exec(`
        CREATE TABLE IF NOT EXISTS route_legs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
            leg_index INTEGER NOT NULL,
            from_system_id INTEGER,
            from_planet_index INTEGER,
            to_system_id INTEGER,
            to_planet_index INTEGER,
            travel_seconds INTEGER DEFAULT 0,
            distance REAL DEFAULT 0,
            bio_needed INTEGER DEFAULT 0
        )
    `);

    // --- INDEXES ---
    // Every query below filters on a non-primary-key column that had no index, so each
    // one was a full table scan. planet_events and player_logins are append-only history
    // and grow without bound, so the cost climbs with the age of the install.
    // planets(system_id) is deliberately absent: it is already the leftmost column of
    // that table's primary key.
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_planets_owner        ON planets(owner_id);
        CREATE INDEX IF NOT EXISTS idx_fleets_owner         ON fleets(owner_id);
        CREATE INDEX IF NOT EXISTS idx_fleets_system        ON fleets(system_id);
        CREATE INDEX IF NOT EXISTS idx_planet_events_sys    ON planet_events(system_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_player_logins_player ON player_logins(player_id);
        CREATE INDEX IF NOT EXISTS idx_players_alliance     ON players(alliance_id);
        CREATE INDEX IF NOT EXISTS idx_planet_plans_system  ON planet_plans(system_id, planet_index);
        CREATE INDEX IF NOT EXISTS idx_discord_timers_due   ON discord_timers(fired_at, due_at);
        CREATE INDEX IF NOT EXISTS idx_link_codes_user      ON discord_link_codes(user_id);
        CREATE INDEX IF NOT EXISTS idx_routes_author        ON routes(author_id);
        CREATE INDEX IF NOT EXISTS idx_routes_expires       ON routes(expires_at);
        CREATE INDEX IF NOT EXISTS idx_route_legs_route     ON route_legs(route_id, leg_index);
    `);

    // --- ROUND ARCHIVE ---
    // "Nuke data" wipes the round so the next one starts clean, which is right: the map
    // reshuffles and last round's coordinates are worse than none. But a player id is
    // stable for the life of an account and people rename between rounds, so the wipe was
    // also destroying the only way to tell that Chewie used to be Elfenlied.
    //
    // These tables hold what is still true a round later — who somebody was — and nothing
    // else. Fleets, planet ownership and events describe a map that no longer exists.
    // See src/utils/round-archive.js.
    db.exec(`
        CREATE TABLE IF NOT EXISTS rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT,
            note TEXT,
            player_count INTEGER DEFAULT 0,
            system_count INTEGER DEFAULT 0,
            archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS round_players (
            round_id INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            name TEXT,
            alliance_tag TEXT,
            points INTEGER,
            level INTEGER,
            planet_count INTEGER DEFAULT 0,
            PRIMARY KEY (round_id, player_id),
            FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE
        )
    `);

    // No foreign key to players(id): the whole point is that these rows outlive the row
    // they were copied from. A reference would be deleted with it.
    db.exec(`
        CREATE TABLE IF NOT EXISTS round_systems (
            round_id INTEGER NOT NULL,
            system_id INTEGER NOT NULL,
            name TEXT,
            x INTEGER,
            y INTEGER,
            PRIMARY KEY (round_id, system_id),
            FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_round_players_player ON round_players(player_id);
        CREATE INDEX IF NOT EXISTS idx_round_players_name   ON round_players(name);
        CREATE INDEX IF NOT EXISTS idx_round_systems_system ON round_systems(system_id);
    `);

    // --- BATTLE REPORTS (game REST API ingest) ---
    // One row per game battle report, keyed by the game's own report id so re-syncs are
    // idempotent (INSERT OR IGNORE — see src/utils/battle-reports.js). att_/def_ mirror
    // the API's firstParty/secondParty. `announced` tracks which rows have already been
    // posted to Discord, so a re-sync never re-announces. Included in the admin round
    // wipe (src/routes/admin.js): reports describe battles on a map that no longer
    // exists once the round resets.
    db.exec(`
        CREATE TABLE IF NOT EXISTS battle_reports (
            id INTEGER PRIMARY KEY,
            started_at TEXT,
            is_public INTEGER,
            winner TEXT,
            conquered_planet INTEGER,
            killed_population INTEGER,
            random_number REAL,

            att_alliance_id INTEGER,
            att_alliance_tag TEXT,
            att_player_id INTEGER,
            att_player_name TEXT,
            att_has_won INTEGER,
            att_luckiness REAL,
            att_combat_value INTEGER,
            att_survived_cv INTEGER,
            att_lost_cv INTEGER,
            att_pct_cv_lost REAL,
            att_xp_gained INTEGER,
            att_level_gained INTEGER,

            def_alliance_id INTEGER,
            def_alliance_tag TEXT,
            def_player_id INTEGER,
            def_player_name TEXT,
            def_has_won INTEGER,
            def_luckiness REAL,
            def_combat_value INTEGER,
            def_survived_cv INTEGER,
            def_lost_cv INTEGER,
            def_pct_cv_lost REAL,
            def_xp_gained INTEGER,
            def_level_gained INTEGER,

            announced INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    addColumn('battle_reports', 'att_destroyers', 'INTEGER');
    addColumn('battle_reports', 'att_destroyers_lost', 'INTEGER');
    addColumn('battle_reports', 'att_cruisers', 'INTEGER');
    addColumn('battle_reports', 'att_cruisers_lost', 'INTEGER');
    addColumn('battle_reports', 'att_battleships', 'INTEGER');
    addColumn('battle_reports', 'att_battleships_lost', 'INTEGER');
    addColumn('battle_reports', 'att_transports', 'INTEGER');
    addColumn('battle_reports', 'att_transports_lost', 'INTEGER');
    addColumn('battle_reports', 'att_colony_ships', 'INTEGER');
    addColumn('battle_reports', 'att_colony_ships_lost', 'INTEGER');
    addColumn('battle_reports', 'att_starbases', 'INTEGER');
    addColumn('battle_reports', 'att_starbases_lost', 'INTEGER');
    addColumn('battle_reports', 'def_destroyers', 'INTEGER');
    addColumn('battle_reports', 'def_destroyers_lost', 'INTEGER');
    addColumn('battle_reports', 'def_cruisers', 'INTEGER');
    addColumn('battle_reports', 'def_cruisers_lost', 'INTEGER');
    addColumn('battle_reports', 'def_battleships', 'INTEGER');
    addColumn('battle_reports', 'def_battleships_lost', 'INTEGER');
    addColumn('battle_reports', 'def_transports', 'INTEGER');
    addColumn('battle_reports', 'def_transports_lost', 'INTEGER');
    addColumn('battle_reports', 'def_colony_ships', 'INTEGER');
    addColumn('battle_reports', 'def_colony_ships_lost', 'INTEGER');
    addColumn('battle_reports', 'def_starbases', 'INTEGER');
    addColumn('battle_reports', 'def_starbases_lost', 'INTEGER');
    addColumn('battle_reports', 'win_chance', 'REAL');
    addColumn('battle_reports', 'ship_detail_scraped_at', 'DATETIME');

    // --- STARBASE ORDER AUDIT ---
    // One row per starbase-order geometry PUT confirmed through the hub. This is an
    // operations record of who sent what, and when — that stays true across rounds, so
    // unlike battle_reports it deliberately SURVIVES the round wipe (same reasoning as
    // the rounds/round_* archive) and carries no FK to systems or planets. The actor FK
    // follows the planet_plans attribution model: SET NULL, never lose the row.
    db.exec(`
        CREATE TABLE IF NOT EXISTS starbase_order_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            system_id INTEGER,
            planet_index INTEGER,
            range REAL,
            angle1 REAL,
            angle2 REAL,
            actor_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
            actor_game_name TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // The battle-report sync asks for MAX(started_at) on every pull, and the audit log
    // is read back per actor.
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_battle_reports_started ON battle_reports(started_at);
        CREATE INDEX IF NOT EXISTS idx_starbase_audit_actor   ON starbase_order_audit(actor_user_id);
    `);

    // --- CREATE DEFAULT ADMIN IF DB IS EMPTY ---
    const userCount = db.prepare(`SELECT COUNT(*) as count FROM app_users`).get();
    if (userCount.count === 0) {
        const bcrypt = require('bcryptjs');
        // Generated per install instead of hardcoded. The previous literal was committed
        // to this file, so it was a published credential for every deployment that ever
        // ran it — and it was printed to stdout too, which put it in the pm2 log as well.
        // ADMIN_BOOTSTRAP_PASSWORD lets an automated setup pin it instead.
        const generated = process.env.ADMIN_BOOTSTRAP_PASSWORD || crypto.randomBytes(12).toString('base64url');
        db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES (?, ?, ?)`)
            .run('admin', bcrypt.hashSync(generated, 10), 'admin');
        console.log('[DB] Default admin account created. Username: admin');
        console.log(`[DB] One-time password: ${generated}`);
        console.log('[DB] Change it in the admin panel now — it is not stored anywhere else.');
    }

    console.log("[DB] Schema initialized successfully.");
}

initDatabase();

module.exports = db;