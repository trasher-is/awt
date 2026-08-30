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

ok('direction "lost" with no other_player_id means no credit can be resolved (defender needs to know who attacked)',
    resolveBombardmentCredit({ other_player_id: null, direction: 'lost' }, 1) === null);

// Regression test: a real News-page "You killed N population" row (self-bombing) carries
// NO player-profile link at all — confirmed against a live example. The scraping player
// must still get population credit even though the opponent is unknown; only the
// battle_reports cross-reference (which needs otherPlayerId) is skipped, not the credit.
ok('direction "killed" with no other_player_id still credits the scraping player (real self-bombing News rows have no opponent link)',
    JSON.stringify(resolveBombardmentCredit({ other_player_id: null, direction: 'killed' }, 1)) ===
    JSON.stringify({ credited_player_id: 1, otherPlayerId: null }));

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
