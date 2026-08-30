const { resolveBombardmentCredit } = require('./news-battle-matching');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('news-battle-matching.test.js');

ok('direction "killed" credits the scraping player (they were the attacker)',
    JSON.stringify(resolveBombardmentCredit({ other_player_id: 99, direction: 'killed' }, 1)) ===
    JSON.stringify({ credited_player_id: 1, otherPlayerId: 99 }));

ok('direction "lost" credits the other player (the scraping player was the defender)',
    JSON.stringify(resolveBombardmentCredit({ other_player_id: 99, direction: 'lost' }, 1)) ===
    JSON.stringify({ credited_player_id: 99, otherPlayerId: 1 }));

ok('no other_player_id means no credit can be resolved',
    resolveBombardmentCredit({ other_player_id: null, direction: 'killed' }, 1) === null);

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
