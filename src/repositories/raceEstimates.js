const db = require('../database');
const { notBefore } = require('../utils/battle-race-inputs');
const arithmetic = require('../../public/js/utils/race-inference');
const parse = value => { try { return JSON.parse(value); } catch (_) { return null; } };
function decode(row) {
    if (!row) return null;
    const dist = parse(row.dist), candidates = parse(row.hard_candidates) || [];
    return { ...row, dist, hard_candidates: candidates,
        credible_values: Array.isArray(dist) ? arithmetic.summarize(dist, row.evidence_count).credible_values : [],
        set90_values: candidates, set90_kind: 'conservative_compatibility',
        evidence_report_ids: parse(row.evidence_report_ids) || [], prior: parse(row.prior) };
}
function getEstimate(playerId) {
    const rows = db.prepare('SELECT * FROM player_race_estimates WHERE player_id = ?').all(playerId);
    return { player_id: playerId, ...Object.fromEntries(rows.map(row => [row.trait, decode(row)])) };
}
function listEstimates() {
    return db.prepare('SELECT DISTINCT player_id FROM player_race_estimates ORDER BY player_id').all().map(row => getEstimate(row.player_id));
}
function evidenceForPlayer(playerId) {
    return db.prepare('SELECT * FROM race_evidence WHERE player_id = ? ORDER BY battle_report_id,kind').all(playerId)
        .map(row => ({ ...row, loglik: parse(row.loglik), flags: parse(row.flags) || [] }));
}
const store = db.transaction((playerId, estimate, evidence, version, hash, statuses = {}) => {
    const currentKeys = new Set(evidence.map(row => `${row.report_id}:${row.kind}`));
    for (const old of db.prepare('SELECT id,battle_report_id,kind,model_version FROM race_evidence WHERE player_id=?').all(playerId)) {
        if (old.model_version !== version || !currentKeys.has(`${old.battle_report_id}:${old.kind}`)) db.prepare('DELETE FROM race_evidence WHERE id=?').run(old.id);
    }
    const insert = db.prepare(`INSERT INTO race_evidence
        (player_id,battle_report_id,side,kind,observed,sigma,window_key,loglik,flags,status,model_version)
        VALUES (@player_id,@battle_report_id,@side,@kind,@observed,@sigma,@window_key,@loglik,@flags,@status,@model_version)
        ON CONFLICT(player_id,battle_report_id,kind,model_version) DO UPDATE SET
        side=excluded.side,observed=excluded.observed,sigma=excluded.sigma,window_key=excluded.window_key,
        loglik=excluded.loglik,flags=excluded.flags,status=excluded.status`);
    for (const row of evidence) insert.run({ player_id: playerId, battle_report_id: row.report_id, side: row.side,
        kind: row.kind, observed: row.observed, sigma: row.sigma, window_key: row.window_key,
        loglik: JSON.stringify(row.matrix), flags: JSON.stringify(row.flags), status: statuses[`${row.report_id}:${row.kind}`] || 'ok', model_version: version });
    const write = db.prepare(`INSERT INTO player_race_estimates
        (player_id,trait,dist,most_likely,set90_low,set90_high,band,evidence_count,evidence_report_ids,model_version,evidence_hash,hard_candidates,prior,withheld_reason)
        VALUES (@player_id,@trait,@dist,@most_likely,@set90_low,@set90_high,@band,@evidence_count,@evidence_report_ids,@model_version,@evidence_hash,@hard_candidates,@prior,@withheld_reason)
        ON CONFLICT(player_id,trait) DO UPDATE SET dist=excluded.dist,most_likely=excluded.most_likely,set90_low=excluded.set90_low,set90_high=excluded.set90_high,
        band=excluded.band,evidence_count=excluded.evidence_count,evidence_report_ids=excluded.evidence_report_ids,model_version=excluded.model_version,
        evidence_hash=excluded.evidence_hash,hard_candidates=excluded.hard_candidates,prior=excluded.prior,withheld_reason=excluded.withheld_reason,estimated_at=CURRENT_TIMESTAMP`);
    for (const trait of ['attack', 'defence']) {
        const row = estimate[trait];
        const hasConflict = evidence.some(item => item.kind === (trait === 'attack' ? 'win' : 'loss') && statuses[`${item.report_id}:${item.kind}`] === 'conflict');
        write.run({ player_id: playerId, trait, dist: JSON.stringify(row.dist), most_likely: row.conflict ? null : row.most_likely,
            set90_low: row.set90_low, set90_high: row.set90_high, band: row.conflict ? 'none' : row.band,
            evidence_count: row.evidence_count, evidence_report_ids: JSON.stringify(row.evidence_report_ids), model_version: version,
            evidence_hash: hash, hard_candidates: JSON.stringify(row.hard_candidates), prior: JSON.stringify(estimate.prior),
            withheld_reason: row.conflict ? 'incompatible_evidence' : hasConflict ? 'unresolved_conflict' : null });
    }
});
function saveEstimate(...args) { store.immediate(...args); }
function setEvidenceStatus(id, status) {
    if (!['ok', 'excluded'].includes(status)) throw new TypeError('An admin must include or exclude the evidence.');
    const row = db.prepare('SELECT player_id FROM race_evidence WHERE id = ?').get(id);
    if (!row) return null;
    db.prepare('UPDATE race_evidence SET status = ? WHERE id = ?').run(status, id);
    return row.player_id;
}
function clearPlayer(playerId) {
    db.prepare('DELETE FROM race_evidence WHERE player_id = ?').run(playerId);
    db.prepare('DELETE FROM player_race_estimates WHERE player_id = ?').run(playerId);
}
function recordCalibration(playerId, incoming) {
    const before = db.prepare('SELECT has_intel,joined,battle_race_not_before FROM players WHERE id = ?').get(playerId);
    if (!before || before.has_intel || incoming.has_intel !== 1) return 0;
    if (incoming.joined === 'N/A') return 0;
    const boundary = notBefore({ ...before, ...incoming });
    if (incoming.joined && incoming.joined !== before.joined && !boundary) return 0;
    const estimate = getEstimate(playerId); let recorded = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO race_estimate_calibrations
        (player_id,trait,dist,set90_low,set90_high,band,truth,model_version,evidence_hash)
        VALUES (@player_id,@trait,@dist,@set90_low,@set90_high,@band,@truth,@model_version,@evidence_hash)`);
    for (const [trait, field] of [['attack', 'race_attack'], ['defence', 'race_defense']]) {
        const row = estimate[trait], truth = incoming[field];
        if (!row || !row.evidence_count || row.withheld_reason || row.model_version !== arithmetic.modelVersion()
            || !Number.isInteger(truth) || truth < -4 || truth > 4) continue;
        if (boundary) {
            const report = db.prepare('SELECT started_at FROM battle_reports WHERE id = ?');
            const cutoff = Date.parse(boundary);
            if (row.evidence_report_ids.some(id => {
                const started = report.get(id)?.started_at;
                const normalized = started && (/^\d{4}-\d{2}-\d{2} /.test(started) ? started.replace(' ', 'T') + 'Z' : started);
                return !normalized || !Number.isFinite(Date.parse(normalized)) || Date.parse(normalized) < cutoff;
            })) continue;
        }
        recorded += insert.run({ player_id: playerId, trait, dist: JSON.stringify(row.dist), set90_low: row.set90_low,
            set90_high: row.set90_high, band: row.band, truth, model_version: row.model_version, evidence_hash: row.evidence_hash }).changes;
    }
    return recorded;
}
function calibrationRows(version) {
    return db.prepare('SELECT * FROM race_estimate_calibrations WHERE model_version = ?').all(version).map(row => ({ ...row, dist: parse(row.dist) }));
}
module.exports = { getEstimate, listEstimates, evidenceForPlayer, saveEstimate, setEvidenceStatus, clearPlayer, recordCalibration, calibrationRows };
