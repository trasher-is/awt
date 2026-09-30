// The line under each player in the Biology threat modal (Science page, issue #153): how far
// they are from seeing your origin, and — since biology 25 opens the whole map — what that
// level changes about it.
//
// Every verdict below comes from the real assessThreat(), not a hand-built object, so the
// wording is tested against what the server actually sends.
//
// Run with:  node src/utils/bio-reach.test.js

const path = require('path');
const fs = require('fs');
const R = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'bio-reach.js'));
const { assessThreat } = require('./threat-vision');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// Comments stripped before a source scan, so a comment explaining what a rule USED to say
// does not trip the assertion that the old wording is gone.
const readCode = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

// You sit at the grid origin, so distance is simply the x offset.
const me = { origin_x: 0, origin_y: 0 };
const said = (row) => R.describeReach({ ...row, vision: assessThreat(row, me) });
const at = (x, extra) => ({ name: 'T', origin_system: 7, origin_x: x, origin_y: 0, has_intel: 1, ...extra });
const scanned = (bio, x) => said(at(x, { biology: bio, science_level: bio }));
const unscanned = (science, x) => said(at(x, { biology: 0, science_level: science, has_intel: 0 }));

console.log('bio-reach.test.js');

console.log('\n── Biology 25 and above: sees the whole map ' + '─'.repeat(32));
{
    const far = scanned(25, 40);
    ok('biology 25 forty squares away is said to see the whole map', far.text === 'sees the whole map (bio 25+)' && far.tone === 'whole-map', far);
    ok('biology above 25 says the same', scanned(29, 40).text === 'sees the whole map (bio 25+)');
    ok('and a near one too — the reason is the level, not the distance', scanned(25, 3).text === 'sees the whole map (bio 25+)');

    // Where he sits no longer matters, so not being able to place him is not worth saying.
    const ghost = said({ name: 'Ghost', biology: 30, science_level: 30, has_intel: 1 });
    ok('a player we cannot place still gets the whole-map answer, not "position unknown"',
        ghost.text === 'sees the whole map (bio 25+)' && ghost.tone === 'whole-map', ghost);

    // An unscanned player at science 25 is a ceiling, not a reading, and the wording says so.
    const ceiling = unscanned(25, 40);
    ok('an unscanned science 25 only MAY see the whole map, and says bio was never scanned',
        ceiling.text === 'may see the whole map (science 25+, bio never scanned)' && ceiling.tone === 'whole-map', ceiling);
}

console.log('\n── Biology 24 and 23: one or two ticks from the whole map ' + '─'.repeat(18));
{
    const b24 = scanned(24, 40);
    ok('biology 24 far away: one more bio opens the whole map, not "needs 1 more to see your origin"',
        b24.text === '1 more bio and he sees the whole map (bio 25)' && b24.tone === 'closing', b24);
    ok('biology 23 is two', scanned(23, 40).text === '2 more bio and he sees the whole map (bio 25)');
    ok('exactly 25 squares away the requirement IS the whole-map level, so it reads the same',
        scanned(24, 25).text === '1 more bio and he sees the whole map (bio 25)');

    const u24 = unscanned(24, 40);
    ok('unscanned science 24 far away states the requirement and that the whole map opens at 25',
        u24.text === 'needs bio 25 — the whole map opens (bio never scanned)' && u24.tone === 'requirement', u24);
}

console.log('\n── Below that, nothing changed ' + '─'.repeat(45));
{
    const closing = scanned(18, 20);
    ok('biology 18 twenty squares away still needs 2 more to see your origin',
        closing.text === 'needs 2 more bio to see your origin' && closing.tone === 'closing', closing);
    ok('one who reaches you by distance can see your origin',
        scanned(18, 10).text === 'can see your origin' && scanned(18, 10).tone === 'sees');
    ok('an unscanned player still gets only the requirement',
        unscanned(9, 12).text === 'needs bio 12 to see your origin' && unscanned(9, 12).tone === 'requirement');

    const lost = said({ name: 'Ghost', biology: 10, science_level: 10, has_intel: 1 });
    ok('a sub-25 player we cannot place is still "position unknown", with the reason on hover',
        lost.text === 'position unknown' && lost.tone === 'unknown' && !!lost.title, lost);
}

console.log('\n── It survives a thin payload ' + '─'.repeat(46));
{
    ok('a row with no verdict does not throw', typeof R.describeReach({ biology: 5, has_intel: 1 }).text === 'string');
    ok('nor does no row at all', typeof R.describeReach(null).text === 'string');
}

console.log('\n── The modal uses it, and the file stays dual-runtime ' + '─'.repeat(22));
{
    const page = readCode('public/js/core/page-injections.js');
    ok('page-injections loads the helper and asks it for each row', /bio-reach\.js/.test(page) && /BioReach\.describeReach\(/.test(page));
    ok('and no longer words the row itself', !/more bio to see your origin/.test(page) && !/can see your origin/.test(page));
    ok('the "~origin" guess marker is hidden once the whole map is open', /v\.estimated && !v\.wholeMap/.test(page));

    const helper = readCode('public/js/utils/bio-reach.js');
    ok('the helper has no import or export, per the dual-runtime rule', !/^\s*(import|export)\s/m.test(helper));
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
