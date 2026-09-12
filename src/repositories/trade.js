const db = require('../database');

const reportedPlayersStmt = db.prepare('SELECT id, name, trade_partners FROM players ORDER BY id');

// Keep direct snapshot completeness separate from known edges. Even a partial list
// can establish a completed pair, and either participant can report that pair. Reads
// never promote coordination-board statuses or invent an empty observed snapshot.
function getPartnerObservations() {
    const rows = reportedPlayersStmt.all();
    const byId = new Map(rows.map(row => [row.id, row]));
    const observations = new Map();
    for (const player of rows) {
        const playerName = player.name.toLowerCase();
        const partners = new Set();
        let values;
        try { values = JSON.parse(player.trade_partners); } catch (_) { /* Unknown snapshot. */ }
        let complete = Array.isArray(values);
        if (complete) for (const value of values) {
            const idLike = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value.trim());
            let name;
            if (idLike) {
                const id = Number(value);
                name = Number.isSafeInteger(id) && id > 0 ? byId.get(id)?.name : null;
            } else if (typeof value === 'string' && value.trim()) {
                name = value.trim();
            }
            if (!name) { complete = false; continue; }
            const normalized = name.toLowerCase();
            if (normalized !== playerName) partners.add(normalized);
        }
        observations.set(playerName, {
            reported_partners: complete ? [...partners] : null,
            known_partners: partners,
        });
    }
    // Copy direct edges before adding reverses; the graph describes observations,
    // not inferred transitive agreements between two partners of the same player.
    const directEdges = [...observations].map(([name, value]) => [name, [...value.known_partners]]);
    for (const [name, partners] of directEdges) for (const partner of partners) {
        if (!observations.has(partner)) observations.set(partner, { reported_partners: null, known_partners: new Set() });
        observations.get(partner).known_partners.add(name);
    }
    for (const value of observations.values()) value.known_partners = [...value.known_partners];
    return observations;
}

function getReportedPartnerNames(playerName) {
    return getPartnerObservations().get(String(playerName).toLowerCase())?.reported_partners ?? null;
}

const getActivePairKeysStmt = db.prepare(`
    SELECT pair_key FROM trade_agreements
    WHERE status IN ('proposed','confirmed','done')
`);
function getActivePairKeys() {
    return getActivePairKeysStmt.all();
}

const getActiveAgreementsStmt = db.prepare(`SELECT * FROM trade_agreements WHERE status != 'cancelled' ORDER BY id ASC`);
function getActiveAgreements() {
    return getActiveAgreementsStmt.all();
}

const getAgreementStatusByPairKeyStmt = db.prepare(`SELECT status FROM trade_agreements WHERE pair_key = ?`);
function getAgreementStatusByPairKey(pairKey) {
    return getAgreementStatusByPairKeyStmt.get(pairKey);
}

// Consolidates the confirm route's and the cancel route's identical lookups.
const getAgreementByIdStmt = db.prepare(`SELECT * FROM trade_agreements WHERE id = ?`);
function getAgreementById(id) {
    return getAgreementByIdStmt.get(id);
}

const proposeAgreementStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'proposed', ?, 0)
    ON CONFLICT(pair_key) DO UPDATE SET status='proposed', initiator=excluded.initiator, updated_at=CURRENT_TIMESTAMP
        WHERE trade_agreements.status='cancelled'
`);
function proposeAgreement(pairKey, playerA, playerB, initiator) {
    proposeAgreementStmt.run(pairKey, playerA, playerB, initiator);
}

const confirmAgreementStmt = db.prepare(`UPDATE trade_agreements SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?`);
function confirmAgreement(id) {
    confirmAgreementStmt.run(id);
}

const cancelAgreementStmt = db.prepare(`DELETE FROM trade_agreements WHERE id=?`);
function cancelAgreement(id) {
    cancelAgreementStmt.run(id);
}

// NOT the same as proposeAgreement above — different literal status/initiator/is_admin_set
// values and no WHERE guard on the ON CONFLICT clause. See Global Constraints.
const forceSetAgreementStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'confirmed', 'admin', 1)
    ON CONFLICT(pair_key) DO UPDATE SET status='confirmed', is_admin_set=1, initiator='admin', updated_at=CURRENT_TIMESTAMP
`);
function forceSetAgreement(pairKey, playerA, playerB) {
    forceSetAgreementStmt.run(pairKey, playerA, playerB);
}

// NOT the same as markAgreementDoneByScan below — this one parameterizes `initiator`.
const markAgreementDoneByInitiatorStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'done', ?, 0)
    ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
`);
function markAgreementDoneByInitiator(pairKey, playerA, playerB, initiator) {
    markAgreementDoneByInitiatorStmt.run(pairKey, playerA, playerB, initiator);
}

// NOT the same as markAgreementDoneByInitiator above — this one hardcodes initiator='scan'.
const markAgreementDoneByScanStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'done', 'scan', 0)
    ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
`);
function markAgreementDoneByScan(pairKey, playerA, playerB) {
    markAgreementDoneByScanStmt.run(pairKey, playerA, playerB);
}

// pair_key identifies two PLAYER NAMES, and names are only meaningful within the round
// they played in — a round reset must clear every agreement or a name reused (or
// coincidentally reassigned) next round would inherit a stale confirmed/done status.
const deleteAllTradeAgreementsStmt = db.prepare(`DELETE FROM trade_agreements`);
function deleteAllTradeAgreements() {
    deleteAllTradeAgreementsStmt.run();
}

module.exports = {
    getActivePairKeys, getActiveAgreements, getAgreementStatusByPairKey, getAgreementById, getReportedPartnerNames, getPartnerObservations,
    proposeAgreement, confirmAgreement, cancelAgreement, forceSetAgreement,
    markAgreementDoneByInitiator, markAgreementDoneByScan, deleteAllTradeAgreements,
};
