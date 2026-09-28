// Research tracker: reading the member's own /Game/Science page
// (public/js/scrapers/science-research-parser.js).
//
// The markup is synthetic, built from the selectors the hub has read this page with since
// July (page-injections.js: `.timer-active`, the bi-N-circle icons in the queue cell paired
// by position with `.timer`s in the cell before it). No captured page is committed.
//
// Run with: node src/utils/science-research-parser.test.js

const fs = require('fs');
const path = require('path');
const AWNumber = require('../../public/js/utils/parse-number.js');

let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
}
console.log('science-research-parser.test.js');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/scrapers/science-research-parser.js'), 'utf8');
const { parseScienceResearchPage } = new Function('globalThis',
    `${source.replace(/^import .*$/gm, '').replace(/^export /gm, '')}; return { parseScienceResearchPage };`)({ AWNumber });

// Minimal DOM: tags, classes, attributes, text, and the selectors the parser uses.
class El {
    constructor(tag, opts = {}) {
        this.tagName = tag.toUpperCase(); this.nodeType = 1; this.childNodes = []; this.parentNode = null;
        this.cls = (opts.cls || '').split(/\s+/).filter(Boolean); this.attrs = opts.attrs || {};
        this.classList = { contains: c => this.cls.includes(c) };
        if (opts.text != null) this.childNodes.push({ nodeType: 3, textContent: String(opts.text) });
        (opts.children || []).forEach(c => this.add(c));
    }
    add(c) { this.childNodes.push(c); c.parentNode = this; return c; }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
    get cells() { return this.tagName === 'TR' ? this.children.filter(c => c.tagName === 'TD' || c.tagName === 'TH') : undefined; }
    getAttribute(k) { return k in this.attrs ? String(this.attrs[k]) : null; }
    hasAttribute(k) { return k in this.attrs; }
    matches(sel) {
        return sel.split(',').map(s => s.trim()).some(s => s.startsWith('.') ? this.cls.includes(s.slice(1)) : this.tagName === s.toUpperCase());
    }
    querySelectorAll(sel) { return this.children.flatMap(c => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const td = (children, opts = {}) => new El('td', Object.assign({ children: [].concat(children || []) }, opts));
const txt = t => ({ nodeType: 3, textContent: t });
const timer = (secs, active) => new El('span', { cls: active ? 'timer timer-active' : 'timer', attrs: { 'data-value': secs }, text: '…' });
const icon = cls => new El('i', { cls: `bi ${cls}` });

// name, level, [points], [research], timers cell, queue cell
function row(nameNodes, level, timers = [], icons = []) {
    return new El('tr', { children: [td([].concat(nameNodes)), td(txt(String(level))), td(txt('1 234')), td(txt('')), td(timers), td(icons)] });
}
function page(rows, rateText = 'Science +293.3/h') {
    const header = new El('tr', { children: [new El('th', { text: rateText })] });
    const table = new El('table', { children: [header, ...rows] });
    return new El('html', { children: [new El('body', { children: [table] })] });
}
const short = t => txt(t);

console.log('\n── Active research carrying the 1 icon, two more queued ' + '─'.repeat(19));
{
    const physActive = timer(7200, true);
    const doc = page([
        // Responsive name: short and long spans both in textContent.
        row([new El('span', { cls: 'd-sm-none', text: 'Bio' }), new El('span', { cls: 'd-none d-sm-inline', text: 'Biology' })], 10),
        row(short('Eco'), 8),
        row(short('E'), 6),
        row(short('Math'), 11, [timer(10800)], [icon('bi-2-circle')]),
        row(short('Phy'), 14, [physActive, timer(18000)], [icon('bi-1-circle'), icon('bi-3-circle')]),
        // The hub's own Social marker is inside the name cell.
        row([txt('Soc'), new El('span', { attrs: { 'data-hub-inject': '' }, text: '▲' })], 9),
        // Culture has its own live timer, and must not be taken for research.
        row(short('Cul'), 4, [timer(999, true)]),
    ]);
    const r = parseScienceResearchPage(doc);
    ok('six sciences, Culture left out', r && r.sciences.length === 6 && !r.sciences.some(s => s.science === 'Culture'), r && r.sciences.map(s => s.science));
    const by = Object.fromEntries(r.sciences.map(s => [s.science, s]));
    ok('a short/long span pair still reads as Biology', by.Biology && by.Biology.level === 10, by.Biology);
    ok('"E" is Energy, not a substring of Eco', by.Energy && by.Energy.level === 6 && by.Economy.level === 8);
    ok('the hub\'s injected marker does not hide Social', by.Social && by.Social.level === 9, by.Social);
    ok('Physics carries the live countdown', by.Physics.active_seconds === 7200, by.Physics);
    ok('Physics queue: slot 1 is the active timer, slot 3 queued', JSON.stringify(by.Physics.queued) === JSON.stringify([{ slot: '1', seconds: 7200, active: true }, { slot: '3', seconds: 18000, active: false }]), by.Physics.queued);
    ok('Math is queued in slot 2', by.Mathematics.queued.length === 1 && by.Mathematics.queued[0].slot === '2' && by.Mathematics.active_seconds === null, by.Mathematics);
    ok('the science rate is read from the header', r.science_rate === 293.3, r.science_rate);

    // End to end with the model: the order the Discord reply will show.
    const Q = require('../../public/js/utils/research-queue.js');
    const q = Q.buildQueue(r.sciences);
    ok('queue: Physics 15, Math 12, Physics 16', q.map(i => `${i.science} ${i.target_level}`).join(',') === 'Physics 15,Mathematics 12,Physics 16', q);
}

console.log('\n── Other pages and other languages are not "researching nothing" ' + '─'.repeat(10));
{
    ok('a page with no science rows is null', parseScienceResearchPage(page([])) === null);
    const foreign = page(['Biologie', 'Ökonomie', 'Energie', 'Mathematik', 'Physik', 'Soziales'].map((n, i) => row(short(n), i)));
    ok('unrecognised names (a language we have not confirmed) are null, not zeros', parseScienceResearchPage(foreign) === null);
    const locale = page(['Bio', 'Eco', 'E', 'Math', 'Phy', 'Soc'].map((n, i) => row(short(n), i)), 'Sci +1.039,5/h');
    ok('a comma-decimal rate with the phone label parses', parseScienceResearchPage(locale).science_rate === 1039.5, parseScienceResearchPage(locale).science_rate);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
