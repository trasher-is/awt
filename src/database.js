const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'awt.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

    try {
        db.exec(`ALTER TABLE players ADD COLUMN eco_bonus INTEGER DEFAULT 0`);
        console.log("[DB] Added eco_bonus column to players table.");
    } catch (e) {}

    try {
        db.exec(`ALTER TABLE players ADD COLUMN joined TEXT`);
        console.log("[DB] Added joined column to players table.");
    } catch (e) {}

    try {
        db.exec(`ALTER TABLE players ADD COLUMN logins INTEGER DEFAULT 0`);
        console.log("[DB] Added logins column to players table.");
    } catch (e) {}

    try {
        db.exec(`ALTER TABLE player_logins ADD COLUMN total_logins INTEGER DEFAULT 0`);
        console.log("[DB] Added total_logins column to player_logins table.");
    } catch (e) {}

    // Safely inject the new idle_time column if it doesn't exist
    try {
        db.exec(`ALTER TABLE players ADD COLUMN idle_time TEXT`);
        console.log("[DB] Added idle_time column to players table.");
    } catch (e) {
        // If it throws an error, the column already exists, so we just ignore it.
    }

    // Safely inject the discord_name column if it doesn't exist
    try {
        db.exec(`ALTER TABLE app_users ADD COLUMN discord_name TEXT`);
        console.log("[DB] Added discord_name column to app_users table.");
    } catch (e) {
        // Ignored
    }

    try {
        db.exec(`ALTER TABLE players ADD COLUMN has_intel INTEGER DEFAULT 0`);
        console.log("[DB] Added has_intel column to players table.");
    } catch (e) {
        // Ignored: Column already exists
    }

    try {
        db.exec(`ALTER TABLE players ADD COLUMN intel_updated_at TEXT`);
        console.log("[DB] Added intel_updated_at column to players table.");
    } catch (e) {}

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
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(owner_id) REFERENCES players(id) ON DELETE CASCADE
        )
    `);

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
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
        )
    `);

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
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // --- CREATE DEFAULT ADMIN IF DB IS EMPTY ---
    const userCount = db.prepare(`SELECT COUNT(*) as count FROM app_users`).get();
    if (userCount.count === 0) {
        const bcrypt = require('bcryptjs');
        const defaultPassword = bcrypt.hashSync('Shaltibarshchiai67', 10);
        db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES (?, ?, ?)`).run('admin', defaultPassword, 'admin');
        console.log("[DB] Default admin account created (Username: admin | Password: Shaltibarshchiai67)");
    }

    console.log("[DB] Schema initialized successfully.");
}

initDatabase();

module.exports = db;