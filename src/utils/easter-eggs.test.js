// public/js/core/easter-eggs.js — the squadron flyby injected into the game page.
//
// Half of this file is ordinary unit testing of the sequence matcher. The other half scans
// the source, because the rules that make an easter egg acceptable in a file injected into
// the GAME page are rules about what it must never do: no network (the rate limit is a
// promise to the game's administrator), nothing appended to the game's own DOM (the
// scrapers read that markup), and no overlay left behind. Those cannot be asserted by
// calling a function, so they are asserted against the file itself.
//
// Browser module, so the helpers are lifted out of the source the same way
// page-injection-clock.test.js lifts its own.
//
// Run with: node src/utils/easter-eggs.test.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('easter-eggs.test.js');

const file = path.join(__dirname, '../../public/js/core/easter-eggs.js');
const source = fs.readFileSync(file, 'utf8');
// Comments explain what the code must not do and would otherwise trip the scans below.
const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

function lift(name, bindings = {}) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Cannot locate ${name}`);
    return new Function(...Object.keys(bindings), `${source.slice(start, end + 2)}; return ${name};`)(...Object.values(bindings));
}

// --- The sequence matcher ---------------------------------------------------
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
// advanceSequence leans on two helpers in the same file; lift them and hand them over,
// rather than re-implementing either here — a test that reimplements the thing it checks
// checks nothing.
const sameKey = lift('sameKey');
const longestBorder = lift('longestBorder', { sameKey });
const advance = lift('advanceSequence', { KONAMI, sameKey, longestBorder });

function feed(keys) {
    let progress = 0, fires = 0;
    for (const key of keys) {
        const step = advance(progress, key, KONAMI);
        progress = step.progress;
        if (step.fired) fires++;
    }
    return { progress, fires };
}

ok('the full sequence fires exactly once', feed(KONAMI).fires === 1, feed(KONAMI));
ok('and leaves the matcher back at the start', feed(KONAMI).progress === 0);
ok('a partial sequence does not fire', feed(KONAMI.slice(0, 9)).fires === 0);
ok('the sequence twice over fires twice', feed([...KONAMI, ...KONAMI]).fires === 2);

// The backtrack itself, checked directly: after "up up" a mismatch may keep one "up".
ok('the border of "up up" is one key', longestBorder(KONAMI, 2) === 1, longestBorder(KONAMI, 2));
ok('the border of "up up down" is nothing', longestBorder(KONAMI, 3) === 0, longestBorder(KONAMI, 3));

// The classic bug: a wrong key resets to zero, so a stutter on the first key breaks a
// sequence that a player would reasonably expect to work.
ok('a stuttered opening key still matches — "up up up down…" is a valid attempt',
    feed(['ArrowUp', ...KONAMI]).fires === 1, feed(['ArrowUp', ...KONAMI]));
ok('a wrong key that is itself a valid opening restarts rather than resetting to zero',
    advance(3, 'ArrowUp', KONAMI).progress === 1, advance(3, 'ArrowUp', KONAMI));
ok('a wrong key that opens nothing resets to zero', advance(3, 'z', KONAMI).progress === 0);
ok('junk in the middle breaks the sequence', feed([...KONAMI.slice(0, 5), 'z', ...KONAMI.slice(5)]).fires === 0);

ok('the letter keys are case-insensitive — caps lock is not a puzzle',
    feed([...KONAMI.slice(0, 8), 'B', 'A']).fires === 1);
ok('but the arrow keys are matched exactly, not case-folded',
    advance(0, 'arrowup', KONAMI).progress === 0);
ok('a non-string key cannot advance anything', advance(0, undefined, KONAMI).progress === 0);

// --- Typing must never scramble a squadron ----------------------------------
const isTyping = lift('isTypingTarget');
ok('an input is a typing target', isTyping({ tagName: 'INPUT' }) === true);
ok('a textarea is a typing target', isTyping({ tagName: 'textarea' }) === true);
ok('a contenteditable div is a typing target', isTyping({ tagName: 'DIV', isContentEditable: true }) === true);
ok('an ordinary div is not', isTyping({ tagName: 'DIV' }) === false);
ok('no target at all is not', isTyping(null) === false);

// --- The overlay ------------------------------------------------------------
// A tiny DOM stand-in: enough to see where the overlay is put, what it is styled with,
// and whether it takes itself away again.
function fakeDoc() {
    const made = [];
    const body = { children: [], appendChild(node) { this.children.push(node); node.parent = this; } };
    const el = (tag) => {
        const node = {
            tag, style: { cssText: '' }, children: [], textContent: '', innerHTML: '', id: '',
            appendChild(child) { this.children.push(child); return child; },
            remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.removed = true; },
            removed: false,
        };
        made.push(node);
        return node;
    };
    return { made, body, createElement: el, getElementById: () => null };
}

const timers = [];
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };

const fly = lift('flySquadron', {
    OVERLAY_ID: 'awt-squadron-overlay',
    FLIGHT_MS: 4200,
    SHIP_COUNT: 7,
    prefersReducedMotion: () => false,
    shipSvg: () => '<svg></svg>',
});

const doc = fakeDoc();
const overlay = fly(doc);
global.setTimeout = realSetTimeout;

ok('the overlay is appended to the body, not into the game markup', doc.body.children.includes(overlay), doc.body.children.length);
ok('the overlay cannot be clicked through to — pointer-events are off',
    /pointer-events\s*:\s*none/.test(overlay.style.cssText), overlay.style.cssText);
ok('the overlay is fixed over the viewport', /position\s*:\s*fixed/.test(overlay.style.cssText));
ok('a toast says what just happened', JSON.stringify(overlay.children.map(c => c.textContent)).includes('squadron'), overlay.children.map(c => c.textContent));
ok('the overlay schedules its own removal', timers.length === 1, timers);
timers[0].fn();
ok('and the removal actually takes it off the page', overlay.removed === true && !doc.body.children.includes(overlay));

// Reduced motion: no animation, but the egg is still findable.
const reducedTimers = [];
global.setTimeout = (fn, ms) => { reducedTimers.push({ fn, ms }); return reducedTimers.length; };
const flyReduced = lift('flySquadron', {
    OVERLAY_ID: 'awt-squadron-overlay', FLIGHT_MS: 4200, SHIP_COUNT: 7,
    prefersReducedMotion: () => true, shipSvg: () => '<svg></svg>',
});
const docReduced = fakeDoc();
const reducedOverlay = flyReduced(docReduced);
global.setTimeout = realSetTimeout;
ok('with reduced motion nothing is animated', !reducedOverlay.children.some(c => c.tag === 'style'), reducedOverlay.children.map(c => c.tag));
ok('but the toast still fires, so the egg is still findable',
    reducedOverlay.children.some(c => String(c.textContent).includes('squadron')));
ok('and it is still cleaned up', reducedTimers.length === 1 && reducedTimers[0].ms < 4200, reducedTimers.map(t => t.ms));

// --- What this file must never do -------------------------------------------
// These are the rules that make a decoration acceptable inside the game page. Each one
// exists because breaking it has a cost outside this repository.
ok('it never makes a network request of any kind',
    !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|gameFetch|WebSocket/.test(code), code.match(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|gameFetch|WebSocket/g));
ok('it appends exactly one thing to the page, and that is its own overlay',
    (code.match(/\.body\.appendChild\(/g) || []).length === 1, (code.match(/\.body\.appendChild\(/g) || []));
ok('it never reaches into the game\'s own markup by selector',
    !/querySelector|getElementsByClassName|getElementsByTagName/.test(code));
ok('it never writes to storage', !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code));
ok('the overlay is always removed, animation or not', /setTimeout\(\(\) => overlay\.remove\(\)/.test(code));
ok('the keydown listener is the only thing it binds',
    (code.match(/addEventListener\(/g) || []).length === 1, (code.match(/addEventListener\('[a-z]+'/g) || []));

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
