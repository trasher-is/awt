// public/js/core/su-spend-buttons.js — one-tap Supply Unit spend on the planet page.
//
// The first hub feature that performs a game action for a member, so what is pinned here
// is mostly the boundary: it acts only on a tap, posts only the game's own Supply Unit form
// to the Spend Points page, and never reaches the game except through gameFetch. The form
// fields match the markup recorded from the live page on 2026-09-28.
//
// Run with: node src/utils/su-spend-buttons.test.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('su-spend-buttons.test.js');

const src = fs.readFileSync(path.join(__dirname, '../../public/js/core/su-spend-buttons.js'), 'utf8');
const code = src.replace(/^import .*$/gm, '').replace(/^export \{.*\};?$/gm, '');
const api = new Function('forceTradeInventorySync', `${code}\nreturn { supplyUnitSpendBody, unitsFor, SU_BUILDINGS };`)(async () => {});

// 1. The request body is exactly what the game's own form posts.
const body = api.supplyUnitSpendBody({ units: 2, building: 'Robotic Factory', token: 'tok123' });
ok('posts SupplyUnitsToUse, __Invariant, SpendTo, UseSupplyUnit and the anti-forgery token',
    body.get('SupplyUnitsToUse') === '2' && body.get('__Invariant') === 'SupplyUnitsToUse' && body.get('SpendTo') === 'Robotic Factory'
    && body.get('UseSupplyUnit') === 'true' && body.get('__RequestVerificationToken') === 'tok123' && [...body.keys()].length === 5, body.toString());
ok('a building name with a space is encoded the way a browser form would', body.toString().includes('SpendTo=Robotic+Factory'), body.toString());

// 2. How many a tap spends.
ok('+1 spends one', api.unitsFor('one', 5) === 1);
ok('+All spends everything held', api.unitsFor('all', 5) === 5);
ok('nothing held, nothing spent', api.unitsFor('all', 0) === 0 && api.unitsFor('one', 0) === 0);

// 3. Only the four buildings the game's Supply Unit form offers — no starbase, no ships.
ok('buttons only for the four buildings', api.SU_BUILDINGS.join() === 'Hydroponic Farm,Robotic Factory,Galactic Cybernet,Research Lab', api.SU_BUILDINGS);

// 4. The boundaries, by source scan (comments stripped so explanations cannot trip them).
const bare = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const gameCalls = [...bare.matchAll(/gameFetch\(\s*([^,)]+)/g)].map(m => m[1].trim());
ok('every game request goes through gameFetch, to the Spend Points url only', gameCalls.length === 2 && gameCalls.every(a => a === 'url'), gameCalls);
ok('that url is this planet\'s Spend Points page', /const url = `\/Game\/Planets\/SpendPoints\/\$\{planetId\}`/.test(bare));
const bareFetches = [...bare.matchAll(/(?<![\w.])fetch\(\s*['"`]([^'"`]+)/g)].map(m => m[1]);
ok('its only plain fetch is to the hub, never the game', bareFetches.length === 1 && bareFetches[0].startsWith('/hub-api/'), bareFetches);
const spendCalls = (bare.match(/(?<!function )\bspend\(/g) || []).length;
ok('the spend is called once, inside a click handler', /addEventListener\('click'[\s\S]*await spend\(/.test(bare) && spendCalls === 1, spendCalls);
ok('no timers or loops that could spend without a tap', !/setInterval|setTimeout\(\s*spend|while\s*\(/.test(bare));
ok('never clicks or submits the game\'s own buttons or forms', !/\.click\s*\(|\.submit\s*\(|requestSubmit/.test(bare));
ok('one POST per tap', (bare.match(/method: 'POST'/g) || []).length === 1);

if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('All checks passed');
