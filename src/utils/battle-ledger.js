// What an attack actually cost, according to the battles this hub has already recorded.
//
// ─── THE QUESTION THE BATTLE CALCULATOR DOES NOT ANSWER ───────────────────────
// !battle and the Battle Calc panel both run public/js/utils/battle-model.js: given two
// fleets and two sets of stats they say who wins. That is a fine question and it is nearly
// always the wrong one, because the hub's own archive says the winner is close to decided
// before anyone presses launch. Across the 968 recorded battles that carry both fleets'
// combat values, sorted by the attacker's CV over the defender's:
//
//     CV ratio      battles   attacker won   attacker's fleet lost
//     under 0.9        557          1.8 %          99.8 %
//     0.9 - 1.2         34         82.4 %          69.7 %
//     1.2 - 1.6         50         96.0 %          59.4 %
//     1.6 - 2.5        100        100.0 %          40.6 %
//     2.5 - 5          105        100.0 %          26.4 %
//     5 - 10            63        100.0 %          14.6 %
//     10 and over       59        100.0 %           3.3 %
//
// In the 327 battles recorded above 1.6x the attacker has never lost. "Will I win" is
// answered, and it was answered before anyone opened a calculator.
// What is not answered anywhere in this tool is the column on the right — the price — and
// that is the number that decides whether an attack was worth making, because the fleet
// you burn taking a planet is the fleet you do not have when someone comes for yours.
//
// So this module does not predict anything. It reports what happened, with the sample count
// next to it, and it refuses to answer where the archive is thin.
//
// ─── WHY NOT JUST TRUST THE MODEL ─────────────────────────────────────────────
// Because a model can be checked, and this one has never been. `costCurve()` is the check:
// the same archive that produced the table above is what a prediction has to agree with.
//
// One thing that check turned up, recorded here so nobody rediscovers it the hard way: the
// `win_chance` column on battle_reports is NOT a win chance. It is scraped from the battle
// report's "Victory" row (public/js/scrapers/battle-report-parser.js, whose own comment
// calls the cell "dice/win-chance"), and against the outcomes it is worthless — battles
// where it read 0-10 were won by the attacker 44% of the time, battles where it read 90-100
// were won 45% of the time, and its Brier score of 0.338 is worse than a constant guess of
// the base rate (0.243). It tracks `random_number` instead, to within 0.28 on average over
// the 1025 rows that carry it, and 434 of those match it exactly. It is the dice roll under
// another name.
// Nothing renders it, so nothing is currently lying to anyone — but it must not be wired to
// a "win chance" label later. `storedWinChanceCheck()` re-runs that proof on live data
// rather than asking anyone to believe this paragraph.

// Band edges chosen before looking at the outcome column, on ratios people actually talk
// about ("about even", "half again", "double", "five to one"), so the bands are not drawn
// around the answer they produce.
const DEFAULT_EDGES = [0, 0.9, 1.2, 1.6, 2.5, 5, 10, Infinity];

// Under this many battles a band reports its numbers but is marked thin, and lookup()
// refuses to turn it into advice. Five is not a statistical threshold, it is an honesty
// threshold: three battles is an anecdote.
const MIN_CONFIDENT_SAMPLES = 5;

// SQLite hands NULL back as null, and Number(null) is 0 — a finite, plausible-looking
// zero. Every numeric column here goes through this instead, because "no percentage was
// recorded" averaged in as 0% is a wrong answer that looks like a right one. That is not
// hypothetical: the first version of storedWinChanceCheck() scored 1029 battles when only
// 1025 carry the column, and its mean distance to random_number came out 0.47 instead of
// 0.28 because four nulls had become zeros.
function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function ratioOf(row) {
    const att = num(row.att_combat_value);
    const def = num(row.def_combat_value);
    if (att === null || def === null || att <= 0 || def <= 0) return null;
    return att / def;
}

function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function label(from, to) {
    if (to === Infinity) return `${from}x+`;
    if (from === 0) return `under ${to}x`;
    return `${from}-${to}x`;
}

/**
 * Recorded battles -> one row per CV-ratio band.
 *
 * Rows are battle_reports rows (or anything with the same column names). A row without
 * both combat values cannot be placed on the ratio axis and is counted in `skipped`
 * rather than dropped silently — a scrape regression that stops recording combat values
 * should show up as a growing skip count, not as a quietly shrinking table.
 */
function costCurve(rows, { edges = DEFAULT_EDGES } = {}) {
    const buckets = [];
    for (let i = 0; i < edges.length - 1; i++) {
        buckets.push({
            from: edges[i], to: edges[i + 1], label: label(edges[i], edges[i + 1]),
            battles: 0, attackerWins: 0,
            attLoss: [], defLoss: [], attLostCv: [], defLostCv: [],
        });
    }

    let skipped = 0;
    for (const row of rows || []) {
        const ratio = ratioOf(row);
        if (ratio === null) { skipped++; continue; }
        const bucket = buckets.find(b => ratio >= b.from && ratio < b.to);
        if (!bucket) { skipped++; continue; }
        bucket.battles++;
        if (row.att_has_won) bucket.attackerWins++;
        const attPct = num(row.att_pct_cv_lost), defPct = num(row.def_pct_cv_lost);
        const attCv = num(row.att_lost_cv), defCv = num(row.def_lost_cv);
        if (attPct !== null) bucket.attLoss.push(attPct);
        if (defPct !== null) bucket.defLoss.push(defPct);
        if (attCv !== null) bucket.attLostCv.push(attCv);
        if (defCv !== null) bucket.defLostCv.push(defCv);
    }

    const bands = buckets.map(b => {
        const attTotal = b.attLostCv.reduce((a, c) => a + c, 0);
        const defTotal = b.defLostCv.reduce((a, c) => a + c, 0);
        return {
            from: b.from, to: b.to, label: b.label,
            battles: b.battles,
            attackerWins: b.attackerWins,
            winRate: b.battles ? b.attackerWins / b.battles : null,
            attackerLossPct: mean(b.attLoss),
            attackerLossPctMedian: median(b.attLoss),
            defenderLossPct: mean(b.defLoss),
            // CV destroyed per CV lost, summed rather than averaged per battle: one lopsided
            // skirmish should not weigh the same as a fleet action ten times its size.
            exchange: attTotal > 0 ? defTotal / attTotal : null,
            thin: b.battles < MIN_CONFIDENT_SAMPLES,
        };
    });

    return { bands, skipped, battles: bands.reduce((n, b) => n + b.battles, 0) };
}

/**
 * The lowest band from which the attacker has never been observed to lose, and the band
 * where observed wins first pass half. Both are statements about this archive, not laws.
 */
function thresholds(curve) {
    const solid = curve.bands.filter(b => !b.thin);
    const decisive = solid.find(b => b.winRate === 1) || null;
    const favourable = solid.find(b => b.winRate !== null && b.winRate >= 0.5) || null;
    return {
        alwaysWonFrom: decisive ? decisive.from : null,
        favourableFrom: favourable ? favourable.from : null,
    };
}

/**
 * What the archive says about one planned attack.
 *
 * Returns { ratio, band, confident, verdict } — `confident` false when the band this
 * ratio lands in is thin, and the verdict then says so instead of quoting a number as
 * though it meant something.
 */
function lookup(curve, attackerCv, defenderCv) {
    const att = Number(attackerCv), def = Number(defenderCv);
    if (!Number.isFinite(att) || !Number.isFinite(def) || att <= 0 || def <= 0) {
        return { ratio: null, band: null, confident: false, verdict: 'Both combat values must be positive numbers.' };
    }
    const ratio = att / def;
    const band = curve.bands.find(b => ratio >= b.from && ratio < b.to) || null;
    if (!band || !band.battles) {
        return { ratio, band, confident: false, verdict: `No recorded battle has been fought at ${ratio.toFixed(2)}x. The archive cannot answer this one.` };
    }
    const pct = n => `${Math.round(n)}%`;
    const head = `${ratio.toFixed(2)}x — ${band.battles} recorded battle${band.battles === 1 ? '' : 's'} in ${band.label}: `
        + `attacker won ${pct(band.winRate * 100)}`;
    if (band.thin) {
        return { ratio, band, confident: false, verdict: `${head}. Too few battles at this ratio to call the cost — treat it as an anecdote.` };
    }
    const cost = band.attackerLossPct === null ? 'cost unrecorded'
        : `expect to lose about ${pct(band.attackerLossPct)} of the attacking fleet (median ${pct(band.attackerLossPctMedian)})`;
    return { ratio, band, confident: true, verdict: `${head}, and ${cost}.` };
}

/**
 * The cheapest band that has never been observed to lose — the "how much overkill actually
 * buys you something" answer. Returns null when no band qualifies.
 */
function cheapestCertainBand(curve) {
    const certain = curve.bands.filter(b => !b.thin && b.winRate === 1 && b.attackerLossPct !== null);
    if (!certain.length) return null;
    return certain.reduce((best, b) => (b.attackerLossPct < best.attackerLossPct ? b : best));
}

/**
 * Proof, from whatever rows are passed in, that the stored `win_chance` column does not
 * behave like a probability: its Brier score against the actual outcome, the Brier score
 * of simply always guessing the base rate, and how closely it tracks `random_number`.
 *
 * A calibrated probability scores BELOW the base-rate guess. This one scores above it.
 */
function storedWinChanceCheck(rows) {
    const usable = (rows || []).filter(r => num(r.win_chance) !== null && (r.att_has_won === 0 || r.att_has_won === 1));
    if (!usable.length) return { battles: 0, brier: null, baseRateBrier: null, behavesLikeAProbability: null, diceMeanAbsDiff: null };

    const baseRate = mean(usable.map(r => r.att_has_won));
    const brier = mean(usable.map(r => {
        const p = Math.max(0, Math.min(1, num(r.win_chance) / 100));
        return (p - r.att_has_won) ** 2;
    }));
    const baseRateBrier = mean(usable.map(r => (baseRate - r.att_has_won) ** 2));

    const paired = usable.filter(r => num(r.random_number) !== null);
    const diceMeanAbsDiff = paired.length ? mean(paired.map(r => Math.abs(num(r.win_chance) - num(r.random_number)))) : null;

    return {
        battles: usable.length,
        baseRate,
        brier,
        baseRateBrier,
        // The only claim made anywhere: does knowing this number beat knowing nothing?
        behavesLikeAProbability: brier < baseRateBrier,
        diceMeanAbsDiff,
        diceMatchRate: paired.length ? paired.filter(r => num(r.win_chance) === num(r.random_number)).length / paired.length : null,
    };
}

module.exports = {
    DEFAULT_EDGES,
    num,
    MIN_CONFIDENT_SAMPLES,
    ratioOf,
    costCurve,
    thresholds,
    lookup,
    cheapestCertainBand,
    storedWinChanceCheck,
};
