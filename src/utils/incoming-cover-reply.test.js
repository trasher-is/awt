// The "I cover this" reply (2026-10-04). Pressing the button used to rewrite the alert; it
// now posts a reply under it. The text carries game names, which other players choose, so
// it is checked that a name cannot ping, and that a withdraw reads as a withdraw.
//
// Run with: node src/utils/incoming-cover-reply.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-cover-reply-test-')), 'test.db');
delete process.env.DISCORD_TOKEN;

require(path.join(__dirname, '..', 'database.js'));
const { coverReplyText } = require(path.join(__dirname, '..', 'discord_bot.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('incoming-cover-reply.test.js');

const claim = coverReplyText('caveman', true, ['Harpyie', 'caveman']);
ok('a claim says who covers and lists everyone covering', /🛡️ \*\*caveman\*\* covers this/.test(claim) && /Covering:\*\* \*\*Harpyie\*\*, \*\*caveman\*\*/.test(claim), claim);
const withdraw = coverReplyText('caveman', false, ['Harpyie']);
ok('pressing again reads as a withdraw', /↩️ \*\*caveman\*\* withdrew/.test(withdraw) && /Harpyie/.test(withdraw), withdraw);
const last = coverReplyText('caveman', false, []);
ok('the last one out says nobody is covering now', /Nobody is covering this now/.test(last), last);
const nasty = coverReplyText('@everyone', true, ['@everyone', '<@123>']);
ok('a name cannot become a mention', !/@everyone(?!​)/.test(nasty.replace(/@​everyone/g, '')) && !/<@123>/.test(nasty), nasty);

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
