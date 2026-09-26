// public/js/utils/ta-schedule-model.js — the Schedule tab's real-clock trade-agreement plan.
// Synthetic members only. Pinned: who pays and when, that nothing goes live except at the
// trade cycle after acceptance, that offers are not sent so early they would expire, that a
// member's money is never spent twice, and that each activation's TR% feeds later income.
//
// Run with: node src/utils/ta-schedule-model.test.js

const M = require('../../public/js/utils/ta-schedule-model.js');
const RoadToTA = require('../../public/js/utils/road-to-ta-model.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('ta-schedule-model.test.js');

const H = 3600e3;
const NOW = Date.parse('2026-09-26T09:03:00Z');   // 11:03 Berlin (CEST)
const member = (name, saved, rate, extra = {}) => ({ name, saved, rate, pop10: 6, tr: 6, trader: false, ...extra });

// 1. Both can pay right now: live at the next cycle after acceptance, i.e. 12:00 Berlin (+5 min).
let r = M.plan({ now: NOW, members: [member('Ann', 25000, 100), member('Bob', 30000, 100)], pairs: [['Ann', 'Bob']] });
let s = r.steps[0];
ok('affordable now: sent and accepted now', s.sendAt === Math.ceil(NOW / 300e3) * 300e3 && s.acceptAt === s.sendAt, s);
ok('goes live at the next Berlin trade cycle after acceptance (+5 min recalculation)',
    s.activeAt === Date.parse('2026-09-26T10:05:00Z') && s.cycleAt === Date.parse('2026-09-26T10:00:00Z'), new Date(s.activeAt).toISOString());
ok('that is exactly what AWRoadToTA says', s.activeAt === RoadToTA.nextTradeActivation(s.acceptAt));

// 2. Accepting ON a cycle boundary counts for the next one.
r = M.plan({ now: Date.parse('2026-09-26T10:00:00Z'), members: [member('Ann', 25000, 0), member('Bob', 25000, 0)], pairs: [['Ann', 'Bob']] });
ok('an acceptance exactly at a cycle waits for the next cycle', r.steps[0].activeAt === Date.parse('2026-09-26T16:05:00Z'), new Date(r.steps[0].activeAt).toISOString());

// 3. A Trader always accepts, and pays nothing for it.
r = M.plan({ now: NOW, members: [member('Tra', 0, 1000, { trader: true }), member('Pay', 20000, 10)], pairs: [['Tra', 'Pay']] });
s = r.steps[0];
ok('the Trader is the acceptor', s.acceptor === 'Tra' && s.sender === 'Pay' && s.acceptorIsTrader, s);
ok('so the Trader with no money does not hold it up', s.acceptAt === s.sendAt, s);

// 4. Neither can pay yet: 10k short at 1,000 A$/h each is 10h, and the acceptor pays later.
r = M.plan({ now: NOW, members: [member('Ann', 10000, 1000), member('Bob', 15000, 1000)], pairs: [['Ann', 'Bob']] });
s = r.steps[0];
ok('the one who can pay first sends', s.sender === 'Bob' && Math.abs(s.sendAt - (NOW + 5 * H)) < 5 * 60e3, [s.sender, (s.sendAt - NOW) / H]);
ok('the acceptor accepts once they can pay too', Math.abs(s.acceptAt - (NOW + 10 * H)) < 5 * 60e3, (s.acceptAt - NOW) / H);
ok('and it goes live at the cycle after that', s.activeAt === RoadToTA.nextTradeActivation(s.acceptAt));

// 5. Acceptor far behind: the sender is not told to send days early, or the offer expires.
r = M.plan({ now: NOW, members: [member('Rich', 50000, 100), member('Poor', 0, 200)], pairs: [['Rich', 'Poor']] });
s = r.steps[0];
ok('the acceptor needs 100h to afford it', Math.abs(s.acceptAt - (NOW + 100 * H)) < 5 * 60e3, (s.acceptAt - NOW) / H);
ok('so the offer is sent within 2 days of acceptance, not now', s.acceptAt - s.sendAt < 48 * H && s.sendAt > NOW + 50 * H, (s.acceptAt - s.sendAt) / H);

// 6. One member in two agreements pays twice, in order, never with the same money.
// Partners have no population-10 planets, so no TR% boost shortens the second wait.
r = M.plan({ now: NOW, members: [member('Hub', 20000, 1000), member('X', 40000, 0, { pop10: 0 }), member('Y', 40000, 0, { pop10: 0 })], pairs: [['Hub', 'X'], ['Hub', 'Y']] });
const hubPays = r.steps.flatMap(st => [st.sender === 'Hub' ? st.sendAt : null, st.acceptor === 'Hub' ? st.acceptAt : null]).filter(x => x !== null).sort((a, b) => a - b);
ok('the second payment waits for the second 20k to be earned (~20h)', hubPays.length === 2 && hubPays[1] - hubPays[0] >= 20 * H - 5 * 60e3, hubPays.map(t => (t - NOW) / H));

// 7. Each activation raises later income by the partner's population-10 count. A pays
// 20k to accept C's offer now; then A must earn another 20k to send to Trader B. With C at
// 50 population-10 planets, A's income is 1.5x from the first cycle on, so that takes ~13h
// instead of ~20h.
const scenario = cPop10 => M.plan({ now: NOW, members: [
    member('A', 20000, 1000, { tr: 0 }), member('B', 0, 0, { trader: true, pop10: 0 }), member('C', 40000, 0, { pop10: cPop10 }),
], pairs: [['A', 'C'], ['A', 'B']] });
const boosted = scenario(50), flat = scenario(0);
const toB = res => res.steps.find(st => st.acceptor === 'B');
const withC = st => [st.sender, st.acceptor].includes('C');
ok('the same order in both cases: C first, then B', withC(boosted.steps[0]) && withC(flat.steps[0]) && toB(boosted) && toB(flat), [boosted.steps, flat.steps]);
ok('without a boost the second 20k takes ~20h', Math.abs((toB(flat).sendAt - NOW) / H - 20) < 0.2, (toB(flat).sendAt - NOW) / H);
ok('with a +50% TR partner it takes clearly less (~13-14h)', (toB(boosted).sendAt - NOW) / H < 14.5, (toB(boosted).sendAt - NOW) / H);
const gainOf = (st, who) => (st.sender === who ? st.senderGain : st.acceptorGain);
ok('each side gains the OTHER side\'s population-10 count', gainOf(boosted.steps[0], 'A') === 50 && gainOf(boosted.steps[0], 'C') === 6, boosted.steps[0]);

// 8. Nothing to live on: reported, not given a date.
r = M.plan({ now: NOW, members: [member('Broke', 0, 0), member('Also', 0, 0)], pairs: [['Broke', 'Also']] });
ok('an agreement nobody can fund is listed as unfunded', r.steps.length === 0 && r.unfunded.length === 1, r);

// 9. Unknown member.
r = M.plan({ now: NOW, members: [member('Ann', 30000, 1)], pairs: [['Ann', 'Ghost']] });
ok('a member with no data is reported as missing', r.missing.includes('Ghost') && r.steps.length === 0, r);

// 10. More money means the same or earlier dates, never later.
const base = [member('A', 5000, 300), member('B', 8000, 250), member('C', 2000, 280, { trader: true }), member('D', 1000, 260)];
const pairs = [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D'], ['C', 'D']];
const poorer = M.plan({ now: NOW, members: base, pairs });
const richer = M.plan({ now: NOW, members: base.map(m => ({ ...m, saved: m.saved + 10000 })), pairs });
ok('extra savings never push the last agreement later', richer.finish <= poorer.finish, [(poorer.finish - NOW) / H, (richer.finish - NOW) / H]);
ok('and more TR%-days are delivered', M.trDays(richer, NOW + 30 * 24 * H) >= M.trDays(poorer, NOW + 30 * 24 * H));
ok('every step goes live on a trade cycle', poorer.steps.every(st => st.activeAt === RoadToTA.nextTradeActivation(st.acceptAt)));
ok('nobody accepts before the offer is sent', poorer.steps.every(st => st.acceptAt >= st.sendAt));

if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('All checks passed');
