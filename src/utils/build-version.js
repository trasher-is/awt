// A fingerprint of the client-side assets this process is serving, so an open hub tab can
// notice it is running code the server has since replaced.
//
// Why this exists (2026-09-13): the hub is designed to be left open for hours — the galaxy
// auto-seed only runs from an open tab. But ES modules are fetched once, at page load, and
// live in memory for the life of that page, so a deploy reached nobody until each member
// happened to reload. Confirmed live: a fix shipped and verified server-side sat inert for
// hours because every syncing tab was still running the previous build's JavaScript, and
// the only symptom was data that quietly refused to change shape. See version-watch.js.
//
// Hashes CONTENT, not mtimes: a redeploy of identical files (a restart, a re-pull that
// rewrites timestamps) must not look like a new build and bounce everyone's tab. Computed
// once, on first call — the files cannot change under a running process without a restart,
// and a restart re-runs this anyway.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLIENT_ASSET_EXTENSIONS = new Set(['.js', '.html', '.css']);
// Vendored libraries are served too, but they only change when package contents do, and
// walking them costs more than it tells us. Dotted names cover .git/.cache and friends.
const SKIP_DIRS = new Set(['node_modules', 'lib']);

function listAssets(rootDir) {
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (CLIENT_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
        }
    };
    walk(rootDir);
    return found;
}

// Exported unmemoized for tests; callers in the app should use buildVersion() below.
function computeBuildVersion(rootDir) {
    const hash = crypto.createHash('sha1');
    for (const file of listAssets(rootDir)) {
        // The path goes in too, so moving a file between directories counts as a change
        // even when every byte of every file is the same as before.
        hash.update(path.relative(rootDir, file).split(path.sep).join('/'));
        try { hash.update(fs.readFileSync(file)); } catch (err) { hash.update('unreadable'); }
    }
    return hash.digest('hex').slice(0, 12);
}

let cached = null;
function buildVersion() {
    if (cached === null) cached = computeBuildVersion(path.join(__dirname, '..', '..', 'public'));
    return cached;
}

module.exports = { buildVersion, computeBuildVersion };
