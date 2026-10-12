// The profile's Hub Intel card with a partner hub's report in the mix (docs/peer-sharing.md):
// the newer of ours and the partner's is shown, the other named underneath, and a partner's
// report is captioned as not ours.
//
// Run with:  node src/utils/profile-partner-intel.test.js
//
// Same approach as profile-buildings-card.test.js: page-injections.js is browser-only ESM, so
// buildIntelCard and olderIntelNote are lifted out of the source text and evaluated with the
// card builders they call stubbed. If either moves, the extraction checks fail loudly.
//
// All names are invented.

const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (name, cond, detail) => {
    if (cond) console.log(`  ✅ ${name}`);
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'core', 'page-injections.js'), 'utf8');

console.log('── Lifting buildIntelCard out of page-injections.js ' + '─'.repeat(22));
const lift = sig => {
    const start = src.indexOf(sig);
    const end = src.indexOf('\n}\n', start);
    return start === -1 || end === -1 ? null : src.slice(start, end + 2);
};
const cardFn = lift('function buildIntelCard(p, partner = null) {');
const noteFn = lift('function olderIntelNote(what, at) {');
ok('buildIntelCard and olderIntelNote are where the test expects them', !!cardFn && !!noteFn);

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatSqliteUtc = ts => `when(${ts})`;
// The stub prints exactly what the real card would be built from.
const buildStaleIntelCard = p => `[CARD source=${p.intel_source || 'ours'} at=${p.intel_updated_at} phys=${p.physics} by=${p.intel_entered_by || '-'}]`;
const buildNoIntelCard = () => '[NO INTEL]';
const build = new Function('esc', 'formatSqliteUtc', 'buildStaleIntelCard', 'buildNoIntelCard',
    `${cardFn}\n${noteFn}\nreturn buildIntelCard;`)(esc, formatSqliteUtc, buildStaleIntelCard, buildNoIntelCard);

const ours = { has_intel: 1, intel_updated_at: '2026-10-05 12:00:00', physics: 10, intel_entered_by: 'SomeMember' };
const none = { has_intel: 0, intel_updated_at: null };
const partner = (at, physics = 20, name = 'Iron Wolves') => ({ sourceName: name, intelAt: at, data: { has_intel: 1, physics, intel_updated_at: '2099-01-01 00:00:00' } });

console.log('\n── Which report is shown ' + '─'.repeat(49));
ok('no partner report: our own card, unchanged', build(ours, null) === buildStaleIntelCard(ours));
ok('no partner report and no intel of ours: the no-intel card', build(none, null) === '[NO INTEL]');

const newer = build(ours, partner('2026-10-08 09:00:00'));
ok('a newer partner report is shown, captioned with the partner and the capped date',
    newer.startsWith('[CARD source=partner hub Iron Wolves at=2026-10-08 09:00:00 phys=20 by=-]'), newer);
ok('…and our older report is named underneath', /Older: Our own report from when\(2026-10-05 12:00:00\)/.test(newer), newer);

const older = build(ours, partner('2026-10-01 09:00:00'));
ok('an older partner report does not replace ours', older.startsWith('[CARD source=ours at=2026-10-05 12:00:00 phys=10'), older);
ok('…it is named underneath instead', /Older: Iron Wolves&#39;s report from when\(2026-10-01 09:00:00\)/.test(older), older);

const only = build(none, partner('2026-09-01 00:00:00'));
ok('with no intel of our own, any partner report is shown, with no "older" line', only.startsWith('[CARD source=partner hub Iron Wolves') && !/Older:/.test(only), only);

const same = build(ours, partner('2026-10-05 12:00:00'));
ok('a tie keeps our own report', same.startsWith('[CARD source=ours'), same);

console.log('\n── Partner text is escaped ' + '─'.repeat(47));
const xss = build(none, partner('2026-10-08 09:00:00', 1, '<img src=x onerror=alert(1)>'));
ok('a partner name cannot inject markup into the caption', !xss.includes('<img') && xss.includes('&lt;img'), xss);
const xssNote = build(ours, partner('2026-10-01 00:00:00', 1, '<b>x</b>'));
ok('…nor into the "older" line', !xssNote.includes('<b>') && xssNote.includes('&lt;b&gt;'), xssNote);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
