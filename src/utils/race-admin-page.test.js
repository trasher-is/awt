// Race evidence lists every stored estimate, so it lives on /admin/race rather than at the
// bottom of Command Center. Static checks only: no server, DB or browser.
const fs = require('fs');
const path = require('path');
let failed = 0;
function ok(name, condition) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`); }
}
const read = file => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
const admin = read('public/Admin.html'), page = read('public/RaceAdmin.html'), server = read('server.js');
const script = '/hub-assets/js/ui/race-admin.js';

ok('Command Center no longer loads the race section', !admin.includes(script) && !admin.includes('loadRaceAdmin'));
ok('Command Center links to the race page', admin.includes('href="/admin/race"'));
ok('race page loads the race section once the admin check passes',
    page.includes(script) && /data\.role === 'admin'[\s\S]*loadRaceAdmin/.test(page));
ok('race page has a <main> for the section to append to', /<main[^>]*>/.test(page));
ok('race page route is admin-only and registered before the proxy catch-all',
    /app\.get\('\/admin\/race', requireAuth,[\s\S]*?role !== 'admin'[\s\S]*?RaceAdmin\.html/.test(server)
    && server.indexOf("app.get('/admin/race'") < server.indexOf("app.use('/', requireAuth"));

console.log(`race-admin-page.test.js: ${failed} failures`);
process.exitCode = failed ? 1 : 0;
