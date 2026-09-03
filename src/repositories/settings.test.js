const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const settings = require('./settings');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('settings.test.js');

// Test getSetting returns undefined for non-existent key
const missingKey = settings.getSetting('missing_key');
ok('getSetting returns undefined for non-existent key', missingKey === undefined);

// Test setSetting creates a new row
settings.setSetting('foo', 'bar');
const afterInsert = settings.getSetting('foo');
ok('setSetting creates row, getSetting returns it', afterInsert && afterInsert.value === 'bar');

// Test setSetting updates value on same key (upsert behavior)
settings.setSetting('foo', 'baz');
const afterUpdate = settings.getSetting('foo');
ok('setSetting updates value without error', afterUpdate && afterUpdate.value === 'baz');

// Verify there's still only one row for key='foo'
const countFoo = db.prepare(`SELECT COUNT(*) c FROM app_settings WHERE key = 'foo'`).get().c;
ok('setSetting updates in place (only one row for key)', countFoo === 1);

// Test getPpPrice returns undefined before pp_price is set
const ppPriceBefore = settings.getPpPrice();
ok('getPpPrice returns undefined before pp_price is set', ppPriceBefore === undefined);

// Test setPpPrice via setSetting and getPpPrice returns the row
settings.setSetting('pp_price', '0.95');
const ppPriceAfter = settings.getPpPrice();
ok('setPpPrice via setSetting, getPpPrice returns row with value', ppPriceAfter && ppPriceAfter.value === '0.95');

// Test getAllSettings returns all rows written so far
const allSettings = settings.getAllSettings();
ok('getAllSettings returns array', Array.isArray(allSettings));

// Should have at least 'foo' and 'pp_price' keys
ok('getAllSettings includes foo key', allSettings.some(row => row.key === 'foo' && row.value === 'baz'));
ok('getAllSettings includes pp_price key', allSettings.some(row => row.key === 'pp_price' && row.value === '0.95'));

// Test adding a third setting and verify getAllSettings includes all three
settings.setSetting('test_key', 'test_value');
const allSettingsFinal = settings.getAllSettings();
ok('getAllSettings includes all settings after multiple writes',
    allSettingsFinal.length >= 3 &&
    allSettingsFinal.some(row => row.key === 'foo') &&
    allSettingsFinal.some(row => row.key === 'pp_price') &&
    allSettingsFinal.some(row => row.key === 'test_key')
);

// getTagListSetting: shared parser for the comma-separated-alliance-tags convention.
ok('getTagListSetting returns [] for a key that was never set', settings.getTagListSetting('never_set').length === 0);

settings.setSetting('tag_list_test', ' raid, nap1 ,RAID,, ao ');
const tagList = settings.getTagListSetting('tag_list_test');
ok('getTagListSetting trims, uppercases, dedupes, and drops empties',
    tagList.length === 3 && tagList.includes('RAID') && tagList.includes('NAP1') && tagList.includes('AO'), tagList);

settings.setSetting('tag_list_empty', '');
ok('getTagListSetting returns [] for an explicitly empty value', settings.getTagListSetting('tag_list_empty').length === 0);

// Clean up
fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
