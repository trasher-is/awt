// public/js/scrapers/science-research-parser.js
// Reads the member's own /Game/Science page: each science's level, which one is being
// researched (and its seconds left), and the queue after it. Only the raw rows go to the
// hub; the ordering and the finish times are worked out server-side by research-queue.js,
// so the rule exists once. See that file for the markup this relies on.
//
// Takes a `doc` — the live `document` when the member is on the page (spy.js), or a
// DOMParser result from the background read (research-watch.js). textContent throughout,
// not innerText: a DOMParser document is never rendered. Same reasoning as
// trade-inventory-parser.js.
import '../utils/parse-number.js'; // side-effect import: parseLocaleNumber on globalThis
const { parseLocaleNumber } = globalThis.AWNumber;

// How the name cell may read. The page abbreviates (Bio Eco E Math Phy Soc), matched
// exactly so "E" cannot match "Eco". Same list as page-injections.js's SCIENCES, minus
// Culture, which has its own track. English only: a guessed translation would match the
// wrong row silently (AGENTS.md).
const ALIASES = {
    Biology: ['biology', 'bio'],
    Economy: ['economy', 'eco'],
    Energy: ['energy', 'e'],
    Mathematics: ['mathematics', 'math'],
    Physics: ['physics', 'phy'],
    Social: ['social', 'soc'],
};
const QUEUE_SLOTS = [['bi-1-circle', '1'], ['bi-2-circle', '2'], ['bi-3-circle', '3'], ['bi-repeat', 'repeat']];

function hasClass(el, cls) {
    return !!(el && el.classList && el.classList.contains(cls));
}

// Every reading of the name cell worth trying: the whole text without anything the hub
// injected (the Social marker and Economy countdown live in this cell), and each child
// element's own text, because a responsive short/long pair of spans concatenates in
// textContent ("BioBiology").
function nameCandidates(cell) {
    const out = [];
    let whole = '';
    (cell.childNodes || []).forEach(node => {
        if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-hub-inject')) return;
        whole += node.textContent || '';
        if (node.nodeType === 1) out.push(node.textContent || '');
    });
    out.unshift(whole);
    return out.map(t => t.trim().toLowerCase()).filter(Boolean);
}

function scienceOf(cell) {
    const candidates = nameCandidates(cell);
    for (const [science, aliases] of Object.entries(ALIASES)) {
        if (candidates.some(c => aliases.includes(c))) return science;
    }
    return null;
}

function secondsOf(el) {
    const v = parseInt(el && el.getAttribute('data-value'), 10);
    return Number.isFinite(v) && v >= 0 ? v : null;
}

// The shared science rate from the "Science +293.3/h" header (or "Sci" on a phone).
function readRate(doc) {
    let rate = null;
    doc.querySelectorAll('th, td').forEach(el => {
        if (rate != null) return;
        const m = (el.textContent || '').match(/(?:Science|Sci)\s*\+([\d.,\s ]+)\/h/i);
        if (m) rate = parseLocaleNumber(m[1]);
    });
    return rate;
}

/**
 * @returns {{science_rate:number|null, sciences:Array}|null}  null when the page did not
 *          look like the Science page — the caller then leaves the old snapshot alone
 *          rather than reporting "researching nothing".
 */
export function parseScienceResearchPage(doc) {
    const seen = new Set();
    const sciences = [];
    doc.querySelectorAll('tr').forEach(row => {
        const cells = row.cells || row.querySelectorAll('td, th');
        if (!cells || cells.length < 2 || !cells[0]) return;
        const science = scienceOf(cells[0]);
        if (!science || seen.has(science)) return;
        const level = parseInt((cells[1].textContent || '').trim(), 10);
        if (!Number.isInteger(level)) return;
        seen.add(science);

        const activeEl = row.querySelector('.timer-active');
        const queued = [];
        // Icons in the queue cell pair by position with the timers in the cell before it —
        // the pairing initScienceTimers has always used.
        if (cells[4] && cells[5]) {
            const timers = Array.from(cells[4].querySelectorAll('.timer, .timer-active'));
            Array.from(cells[5].querySelectorAll('i')).forEach((icon, idx) => {
                const slot = QUEUE_SLOTS.find(([cls]) => hasClass(icon, cls));
                const timer = timers[idx];
                const seconds = secondsOf(timer);
                if (!slot || seconds == null) return;
                queued.push({ slot: slot[1], seconds, active: !!activeEl && timer === activeEl });
            });
        }
        sciences.push({ science, level, active_seconds: activeEl ? secondsOf(activeEl) : null, queued });
    });
    // Fewer than four recognised rows is a different page or a different language, not a
    // member with two sciences.
    if (sciences.length < 4) return null;
    return { science_rate: readRate(doc), sciences };
}

export async function postScienceResearch(result) {
    if (!result) return;
    await fetch('/hub-api/sync/science-research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
    });
}

// In-page: the member is looking at /Game/Science right now. spy.js re-runs its view hooks
// on every DOM change, so an unchanged page is not re-posted more than once a minute.
let lastPost = { key: '', at: 0 };
export async function scrapeScienceResearch() {
    if (!window.location.pathname.toLowerCase().includes('/game/science')) return;
    const result = parseScienceResearchPage(document);
    if (!result) return;
    // Seconds tick down; the shape (what is queued, at which level) is what matters here.
    const key = JSON.stringify(result.sciences.map(s => [s.science, s.level, s.active_seconds != null, s.queued.map(q => q.slot)]));
    const now = Date.now();
    if (key === lastPost.key && now - lastPost.at < 60 * 1000) return;
    lastPost = { key, at: now };
    await postScienceResearch(result);
}
