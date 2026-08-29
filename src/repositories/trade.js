const db = require('../database');

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

module.exports = {
    getActivePairKeys, getActiveAgreements, getAgreementStatusByPairKey, getAgreementById,
    proposeAgreement, confirmAgreement, cancelAgreement, forceSetAgreement,
    markAgreementDoneByInitiator, markAgreementDoneByScan,
};
