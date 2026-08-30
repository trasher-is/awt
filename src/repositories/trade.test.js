const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const trade = require('./trade');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('trade.test.js');

ok('getActiveAgreements starts empty', trade.getActiveAgreements().length === 0);
ok('getActivePairKeys starts empty', trade.getActivePairKeys().length === 0);

trade.proposeAgreement('caveman|trader1', 'caveman', 'trader1', 'caveman');
ok('proposeAgreement created a proposed row', trade.getActiveAgreements().length === 1);
ok('getAgreementStatusByPairKey finds it', trade.getAgreementStatusByPairKey('caveman|trader1').status === 'proposed');
ok('getActivePairKeys now includes it', trade.getActivePairKeys().some(r => r.pair_key === 'caveman|trader1'));

const ta = trade.getActiveAgreements()[0];
ok('getAgreementById returns the same row', trade.getAgreementById(ta.id).pair_key === 'caveman|trader1');

trade.confirmAgreement(ta.id);
ok('confirmAgreement sets status to confirmed', trade.getAgreementById(ta.id).status === 'confirmed');

trade.cancelAgreement(ta.id);
ok('cancelAgreement removes the row', trade.getAgreementById(ta.id) === undefined);
ok('getActiveAgreements excludes the cancelled/deleted row', trade.getActiveAgreements().length === 0);

trade.forceSetAgreement('adminpair|x', 'adminpair', 'x');
const forced = trade.getActiveAgreements()[0];
ok('forceSetAgreement creates an already-confirmed row', forced.status === 'confirmed' && forced.is_admin_set === 1 && forced.initiator === 'admin');

trade.markAgreementDoneByInitiator('donepair|y', 'donepair', 'y', 'donepair');
const doneRow = trade.getActiveAgreements().find(r => r.pair_key === 'donepair|y');
ok('markAgreementDoneByInitiator creates a done row with the given initiator', doneRow.status === 'done' && doneRow.initiator === 'donepair');

trade.markAgreementDoneByScan('scanpair|z', 'scanpair', 'z');
const scanRow = trade.getActiveAgreements().find(r => r.pair_key === 'scanpair|z');
ok('markAgreementDoneByScan creates a done row with initiator=scan', scanRow.status === 'done' && scanRow.initiator === 'scan');

// Re-proposing an existing non-cancelled pair should NOT change it (the ON CONFLICT guard
// only fires when status='cancelled') — proposeAgreement on the already-confirmed forced
// pair must leave it untouched.
trade.proposeAgreement('adminpair|x', 'adminpair', 'x', 'someoneelse');
ok('proposeAgreement does not touch a non-cancelled existing pair (ON CONFLICT WHERE guard)', trade.getActiveAgreements().find(r => r.pair_key === 'adminpair|x').status === 'confirmed');

// Regression for a real production bug (2026-08-30): trade_agreements was never cleared
// by the round-reset ("nuke intel") route — pair_key identifies two player NAMES, only
// meaningful within the round they played in.
ok('trade_agreements has rows from the earlier tests before the wipe', trade.getActiveAgreements().length > 0);
trade.deleteAllTradeAgreements();
ok('deleteAllTradeAgreements empties the table', trade.getActiveAgreements().length === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
