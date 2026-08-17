#!/usr/bin/env node
// Run the empire build simulator from the terminal.
//
//   node scripts/sim-empire.js --race speed=4,science=3,culture=1,attack=-4,defence=-4 \
//        --targets HF=12,RF=13,GC=13,RL=13 --science social=10,energy=40 --colony-ships 3
//
// Every flag is optional; see public/js/utils/empire-model.js DEFAULTS for what is assumed.
// This is an operator tool — not part of the app, not run automatically.

const path = require('path');
const E = require(path.join(__dirname, '..', 'public', 'js', 'utils', 'empire-model.js'));

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
        out[key] = next; i++;
    }
    return out;
}

// "HF=12,RF=13" -> { HF: 12, RF: 13 }
const pairs = (s, cast = Number) => {
    const o = {};
    for (const part of String(s).split(',')) {
        if (!part.trim()) continue;
        const [k, v] = part.split('=');
        o[k.trim()] = cast(v);
    }
    return o;
};

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    console.log(`
Empire build simulator — how long a target build takes, given a race.

  --days N                  default 60
  --tick MINUTES            default 60 (use 5 to match the game's hosting cycle)
  --race k=v,...            growth science culture production speed attack defence
                            plus startupLab=1 trader=1
  --targets HF=12,RF=13,... building levels EVERY planet should reach
  --mode balanced|priority  how production points are allocated (default balanced)
  --order RF,GC,HF,RL       priority order / tie-break
  --science social=10,energy=40   ordered research plan
  --science-overflow FIELD  what to research after the plan (else output is wasted)
  --colony-ships N          ships sent per new colony (1, or 3+; 2 is wasteful)
  --max-planets N           cap planet count below culture level
  --tr 0.8                  trade rate as a fraction
  --economy-bonus           add the +5% join-cohort bonus (additive to TR)
  --artifact "Memory Jar 3"
  --artifact-from-day N
  --culture-formula gc|gc+1
  --distance N              system distance to new colonies (0 = same system)
  --json                    dump the full result as JSON
`);
    process.exit(0);
}

const cfg = {};
if (args.days) cfg.days = Number(args.days);
if (args.tick) cfg.tickMinutes = Number(args.tick);
if (args.race) {
    const r = pairs(args.race);
    cfg.race = {};
    for (const [k, v] of Object.entries(r)) {
        cfg.race[k] = (k === 'startupLab' || k === 'trader') ? !!v : v;
    }
}
if (args.targets) cfg.targets = pairs(args.targets);
if (args.mode) cfg.buildMode = args.mode;
if (args.order) cfg.buildOrder = String(args.order).split(',').map(s => s.trim());
if (args.science) {
    cfg.sciencePlan = String(args.science).split(',').filter(Boolean).map(part => {
        const [field, level] = part.split('=');
        return { field: field.trim(), level: Number(level) };
    });
}
if (args['colony-ships']) cfg.colonyShips = Number(args['colony-ships']);
if (args['max-planets']) cfg.maxPlanets = Number(args['max-planets']);
if (args.tr) cfg.tradeRate = Number(args.tr);
if (args['economy-bonus']) cfg.economyBonus = true;
if (args.artifact && args.artifact !== true) cfg.artifact = args.artifact;
if (args['artifact-from-day']) cfg.artifactFromDay = Number(args['artifact-from-day']);
if (args['culture-formula']) cfg.cultureFormula = args['culture-formula'];
if (args['science-overflow'] && args['science-overflow'] !== true) cfg.scienceOverflow = args['science-overflow'];
if (args.distance) cfg.colonyRoute = { systemDistance: Number(args.distance) };

const res = E.simulate(cfg);

if (args.json) {
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
}

const n = x => Math.round(x).toLocaleString();
const c = res.config;
const cost = E.targetCostPP(c.targets, res.final.planets);

console.log('');
console.log(`Race     ${Object.entries(c.race).filter(([, v]) => v).map(([k, v]) => `${k} ${v === true ? 'yes' : (v > 0 ? '+' + v : v)}`).join('  ') || 'all zero'}`);
console.log(`Targets  ${Object.entries(c.targets).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('  ')}  (${n(cost.perPlanet)} PP per planet)`);
console.log(`Plan     ${c.sciencePlan.map(s => `${s.field} ${s.level}`).join(' → ')}`);
console.log(`Spending ${c.buildMode}, ${c.colonyShips} colony ship${c.colonyShips === 1 ? '' : 's'} per colony, ${c.days} days at ${c.tickMinutes}min ticks`);
console.log('');

for (const w of res.warnings) console.log(`  ! ${w}`);
if (res.warnings.length) console.log('');

console.log(`── Day-by-day ${'─'.repeat(60)}`);
console.log('  day  planets   pop    PP/h   sci/h  cult  unspent PP   PP still needed');
for (const h of res.history) {
    if (h.day % 5 !== 0 && h.day !== c.days) continue;
    console.log(
        `  ${String(h.day).padStart(3)}  ${String(h.planets).padStart(7)}  ${String(h.pop).padStart(4)}  ` +
        `${n(h.ppRate).padStart(6)}  ${n(h.sciRate).padStart(6)}  ${String(h.cultureLevel).padStart(4)}  ` +
        `${n(h.pp).padStart(10)}  ${n(h.remainingBuildPP).padStart(15)}`
    );
}

console.log('');
console.log(`── Day ${c.days} ${'─'.repeat(66)}`);
const f = res.final;
console.log(`  planets            ${f.planets} (culture ${f.cultureLevel})`);
console.log(`  total population   ${f.totalPop}  (cap ${f.popCap}/planet at social ${f.science.social})`);
console.log(`  PP/h               ${n(f.ppRate)}`);
console.log(`  sci/h              ${n(f.sciRate)}`);
console.log(`  science            ${Object.entries(f.science).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('  ') || 'none'}`);
console.log(`  PP spent           ${n(f.spent.buildings)} buildings, ${n(f.spent.colonyShips)} colony ships`);
console.log(`  unspent PP         ${n(f.unspentPP)}  = ${n(f.fleetIfSpent.battleships)} battleships / ` +
    `${n(f.fleetIfSpent.cruisers)} cruisers / ${n(f.fleetIfSpent.destroyers)} destroyers at economy ${f.fleetIfSpent.economy}`);
console.log(`  first caught up    ${res.firstCaughtUpDay ? 'day ' + res.firstCaughtUpDay : `never — ${n(f.remainingBuildPP)} PP still needed`}`);
console.log(`  caught up on day ${c.days}  ${res.caughtUpAtEnd ? 'yes' : `no — ${n(f.remainingBuildPP)} PP short`}`);
if (f.scienceWasted > 0) {
    console.log(`  science wasted     ${n(f.scienceWasted)} points after the plan ran out (set --science-overflow)`);
}
console.log(`  score (floor)      ${f.scoreFloor}  (population + science only; player level not simulated)`);
console.log('');

const byBuilding = {};
for (const p of f.buildings) {
    for (const [b, lvl] of Object.entries(p.buildings)) {
        if (!c.targets[b]) continue;
        byBuilding[b] = byBuilding[b] || [];
        byBuilding[b].push(lvl);
    }
}
console.log(`── Where the planets actually got to ${'─'.repeat(43)}`);
for (const [b, levels] of Object.entries(byBuilding)) {
    const min = Math.min(...levels), max = Math.max(...levels);
    const done = levels.filter(l => l >= c.targets[b]).length;
    console.log(`  ${b.padEnd(3)} target ${String(c.targets[b]).padStart(2)}   reached ${String(min).padStart(2)}-${String(max).padStart(2)}   ${done}/${levels.length} planets done`);
}
console.log('');
