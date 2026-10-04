// The Defence panel's warning must never open the panel by itself (2026-10-04).
//
// Members play on phones, where an opening panel covers the whole game. The live warning
// is a blinking sidebar button and a slim, dismissible banner; the panel opens only from
// a tap: the sidebar button, the banner, or a Discord link the member followed. This scans
// the source so a later change cannot quietly add an auto-open.
//
// Run with: node src/utils/defence-panel-ui.test.js

const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('defence-panel-ui.test.js');

const src = read('public/js/ui/defence.js');
const calls = [...src.matchAll(/openDefencePanel\(/g)].map(m => {
    const line = src.slice(0, m.index).split('\n').length;
    return { line, text: src.split('\n')[line - 1].trim() };
}).filter(c => !/export async function openDefencePanel/.test(c.text));
ok('openDefencePanel is called in exactly two places in defence.js', calls.length === 2, calls);
ok('one is the banner tap', calls.some(c => /dataset\.key/.test(c.text)), calls);
ok('the other is the ?defence= link the member followed', /get\('defence'\)[\s\S]{0,80}if \(key\) \{\s*openDefencePanel\(key\)/.test(src));
ok('the poll never opens anything', !/openDefencePanel/.test(src.slice(src.indexOf('async function poll'), src.indexOf('export function initDefenceWatch'))));
ok('the sidebar button opens it on click', /getElementById\('open-defence-btn'\)\?\.addEventListener\('click', \(\) => openDefencePanel\(\)\)/.test(read('public/js/ui/dashboard.js')));
ok('every localStorage access is guarded', (src.match(/localStorage\./g) || []).length === (src.match(/try \{[^\n]*localStorage\./g) || []).length);
// Blinking is for attacks the member has not seen yet; the count pill stays while any is live.
ok('blinking follows UNSEEN attacks only', /const blink = unseen\.length > 0;/.test(src) && /toggle\('awt-defence-alarm', blink\)/.test(src));
ok('opening the panel marks every live attack seen', /markSeen\(liveAttacks\.map\(a => a\.key\)\)/.test(src.slice(src.indexOf('export async function openDefencePanel'))));
ok('closing the banner marks that attack seen', /if \(key\) markSeen\(\[key\]\)/.test(src));
ok('the pill shows every live attack, seen or not', /el\.textContent = live\.length \? String\(live\.length\) : ''/.test(src));
ok('the banner only names unseen attacks', /const next = unseen\[0\]/.test(src));
ok('the live stream is closed with the panel', /function closePanel\(\) \{[\s\S]{0,200}closeStream\(\)/.test(src));
const wrapper = read('public/Wrapper.html');
ok('Wrapper has one Defence button and one banner', (wrapper.match(/id="open-defence-btn"/g) || []).length === 1 && (wrapper.match(/id="defence-banner"/g) || []).length === 1);
ok('the banner can be dismissed', /id="defence-banner-close"/.test(wrapper));

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
