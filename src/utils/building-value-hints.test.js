// Actual DOM/event behavior against a small synthetic table implementation. Fixtures
// deliberately exercise reordered and malformed columns; no captured player markup.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let failed = 0;
function ok(name, condition, detail) {
    console.log(`${condition ? '  ok' : '  NOT OK'} - ${name}${condition || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!condition) failed++;
}

class Node {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase(); this.nodeType = 1; this.doc = doc;
        this.children = []; this.attrs = {}; this.listeners = {}; this._text = ''; this.hidden = false;
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); for (const child of this.children) child.parentElement = null; this.children = []; }
    get cells() { return this.children.filter(child => ['TH', 'TD'].includes(child.tagName)); }
    get colSpan() { return Number(this.attrs.colspan || 1); }
    get rowSpan() { return Number(this.attrs.rowspan || 1); }
    get isConnected() { return this === this.doc.body || this === this.doc.head || !!this.parentElement?.isConnected; }
    set id(value) { this.attrs.id = value; }
    get id() { return this.attrs.id || ''; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return name in this.attrs; }
    appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    insertAdjacentElement(where, child) {
        if (where !== 'afterend') throw new Error('Unsupported synthetic insertion');
        const parent = this.parentElement;
        child.remove(); child.parentElement = parent;
        parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
    }
    matches(selector) {
        return selector.split(',').some(piece => {
            if (piece.trim().startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(piece.trim().slice(1));
            const match = /^([a-z]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i.exec(piece.trim());
            if (!match) throw new Error(`Unsupported synthetic selector ${piece}`);
            return (!match[1] || this.tagName === match[1].toUpperCase())
                && (!match[2] || this.hasAttribute(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3]));
        });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) {
        const result = [];
        for (const child of this.children) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); }
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(fn => fn !== handler); }
    fire(type, fields = {}) {
        const event = { target: this, stopped: false, prevented: false, ...fields,
            stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
        for (let node = this; node; node = node.parentElement) {
            for (const handler of node.listeners[type] || []) handler(event);
            if (event.stopped) break;
        }
        return event;
    }
    focus() { this.doc.activeElement = this; }
}

function setup() {
    const document = { createElement(tag) { return new Node(tag, this); } };
    document.body = document.createElement('body'); document.head = document.createElement('head');
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.getElementById = id => [...document.head.querySelectorAll('[id]'), ...document.body.querySelectorAll('[id]')].find(node => node.id === id) || null;
    const listeners = {}, storage = new Map(), timers = new Map(), observers = [];
    let time = 1790000000000, timerId = 0;
    const window = {
        location: { pathname: '/Game/Planets/Planet/17' },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(handler => handler !== fn); },
        dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); },
    };
    const context = vm.createContext({
        document, window, console,
        Date: class extends Date { static now() { return time; } },
        Event: class { constructor(type) { this.type = type; } },
        dispatchEvent: event => window.dispatchEvent(event),
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        MutationObserver: class {
            constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
            observe() { this.connected = true; }
            disconnect() { this.connected = false; }
        },
    });
    for (const file of ['public/js/utils/game-tables.js', 'public/js/utils/building-economics.js', 'public/js/core/building-value-hints.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
        vm.runInContext(source, context, { filename: file });
    }
    function make(tag, text, parent) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent?.appendChild(node); return node; }
    function table(headers = ['Building', 'Level', 'PP to next level']) {
        const table = make('table', undefined, document.body), thead = make('thead', undefined, table), body = make('tbody', undefined, table);
        const headerRow = make('tr', undefined, thead);
        headers.forEach(header => make('th', header, headerRow));
        return { table, headerRow, row(building, amounts = [building, '12', '1000']) {
            const row = make('tr', undefined, body); row.setAttribute('data-spend-to', building);
            amounts.forEach(amount => make('td', amount, row)); return row;
        } };
    }
    function advance(ms) {
        time += ms;
        let executions = 0;
        while (true) {
            const found = [...timers.entries()].find(([, timer]) => timer.at <= time);
            if (!found) break;
            timers.delete(found[0]); found[1].fn();
            if (++executions > 100) throw new Error('Synthetic timer loop');
        }
    }
    const prices = { 'Production Point': '$0.80', 'Supply Unit': '$750', 'Robotic Factory': '$100' };
    const record = values => context.AWBuildingEconomics.recordQuote(values === undefined ? prices : values, time);
    return { context, document, window, listeners, storage, timers, observers, table, make, advance, record,
        mutate(target, type = 'characterData') { observers.filter(observer => observer.connected).forEach(observer => observer.fn([{ target, type, addedNodes: [], removedNodes: [] }])); },
        badge: row => row.querySelector('button'), hints: () => document.querySelectorAll('[data-aw-building-value="hint"]'),
        neutral: () => document.querySelectorAll('[data-aw-building-value="neutral"]'),
    };
}

const a = setup();
const t = a.table();
const factory = t.row('Robotic Factory'), lab = t.row('Research Lab'), starbase = t.row('Starbase');
a.record(); a.context.initBuildingValueHints();
ok('two eligible buildings show actual savings, Starbase does not', a.hints().length === 2 && !a.badge(starbase));
ok('badge uses a small whole-percent market-value estimate', a.badge(factory).textContent === 'SU ↓18%');
ok('known valid data produces no neutral warning', a.neutral().length === 0);
let rowClicks = 0; factory.addEventListener('click', () => rowClicks++);
const click = a.badge(factory).fire('click');
const region = factory.querySelector('[role="region"]');
ok('opening comparison prevents the building row action', click.prevented && click.stopped && rowClicks === 0 && !region.hidden);
ok('details connect to accessible expanded button', a.badge(factory).getAttribute('aria-expanded') === 'true' && a.badge(factory).getAttribute('aria-controls') === region.id);
ok('comparison states remaining PP, refund, exact amounts and siege constraint', region.textContent.includes('1,000 remaining PP') && region.textContent.includes('800.00 A$') && region.textContent.includes('−100.00 A$') && region.textContent.includes('only 70%'));
ok('missing refund is visibly labelled before refund', lab.querySelector('[role="region"]').textContent.includes('estimate before refund'));
const trade = region.querySelector('a'), tradeClick = trade.fire('click');
ok('Trade is ordinary navigation without bubbling to a build action', trade.href === '/Game/Trade' && !tradeClick.prevented && rowClicks === 0);
trade.fire('keydown', { key: 'Escape' });
ok('Escape closes details and restores focus to the badge', region.hidden && a.document.activeElement === a.badge(factory));
a.context.initBuildingValueHints();
ok('repeated view hooks preserve one hint/listener per row', a.hints().length === 2 && a.badge(factory).listeners.click.length === 1 && a.observers.length === 1);
factory.cells[2].textContent = '100'; a.mutate(factory.cells[2]); a.advance(60);
ok('nearly finished building explicitly favors PP instead of SU', a.badge(factory).textContent === 'PP cheaper' && a.hints().length === 2);
factory.cells[2].textContent = 'N/A'; a.mutate(factory.cells[2]); a.advance(60);
ok('unknown remaining PP uses full level cost with an explicit zero-investment assumption', a.neutral().length === 0 && a.badge(factory).textContent === '~ PP cheaper' && factory.querySelector('[role="region"]').textContent.includes('Assuming 0 PP already invested') && factory.querySelector('[role="region"]').textContent.includes('649 full-level PP'));
factory.cells[1].textContent = '15'; a.mutate(factory.cells[1]); a.advance(60);
ok('higher known level can favor SU even when the remaining PP column says N/A', a.badge(factory).textContent.startsWith('~ SU ↓') && factory.querySelector('[role="region"]').textContent.includes('2,189 full-level PP'));
factory.cells[2].textContent = '0'; a.mutate(factory.cells[2]); a.advance(60);
ok('observed zero is not replaced by the full-level estimate', a.badge(factory).textContent === 'PP cheaper' && !factory.querySelector('[role="region"]').textContent.includes('Assuming'));
factory.cells[2].textContent = 'N/A'; factory.cells[1].textContent = '30'; a.mutate(factory.cells[1]); a.advance(60);
ok('unknown costs beyond the published table do not invent a full-level price', !a.badge(factory) && a.neutral().length === 1);
factory.cells[1].textContent = '15';
const timersBefore = a.timers.size;
a.mutate(lab.querySelector('[role="region"]'));
ok('own details mutations do not enqueue another render', a.timers.size === timersBefore);
factory.cells[2].textContent = '1000'; a.context.initBuildingValueHints();
ok('valid cost recovery restores advice and clears neutral hint', !!a.badge(factory) && a.neutral().length === 0);
a.record({ 'Supply Unit': '$750' }); a.advance(60);
ok('an incomplete newer Trade parse invalidates visible advice in the writer document', a.hints().length === 0 && a.neutral().length === 1);
a.record(); a.advance(60);
ok('a new complete Trade quote restores advice in the writer document', a.hints().length === 2);
const key = a.context.AWBuildingEconomics.STORAGE_KEY;
const cached = JSON.parse(a.storage.get(key)); cached.suPrice = 99999;
a.storage.set(key, JSON.stringify(cached)); a.window.dispatchEvent({ type: 'storage', key }); a.advance(60);
ok('a changed quote from another realm updates visible advice', a.hints().length === 2 && a.badge(factory).textContent === 'PP cheaper' && a.badge(lab).textContent === 'PP cheaper');
a.record(); a.advance(60);
a.advance(a.context.AWBuildingEconomics.MAX_AGE_MS); a.advance(60);
ok('expiry removes badges even when the game DOM is idle', a.hints().length === 0 && a.neutral().length === 1);
a.record(); a.advance(60);
a.window.location.pathname = '/Game/Science'; a.context.initBuildingValueHints();
ok('navigation removes all advice, observers, timers and update listeners', a.hints().length === 0 && a.neutral().length === 0 && a.timers.size === 0 && a.observers.every(observer => !observer.connected) && a.listeners.storage.length === 0);

const b = setup();
const reordered = b.table(['Level', 'PP to next level', 'Building']);
const moved = reordered.row('Robotic Factory', ['12', '1,000', 'Robotic Factory']);
ok('remaining cost follows the header when columns are reordered', b.context.readRemainingPP(moved) === 1000);
reordered.headerRow.cells[1].textContent = 'Cost';
ok('an unconfirmed header is not guessed or treated positionally', b.context.readRemainingPP(moved) === null);
reordered.headerRow.cells[1].textContent = 'PP to next level';
reordered.headerRow.cells[0].textContent = 'PP to next level';
ok('duplicate matching headers are ambiguous', b.context.readRemainingPP(moved) === null);
reordered.headerRow.cells[0].textContent = 'Level';
reordered.headerRow.cells[0].setAttribute('colspan', '2');
ok('spanning headers fail closed', b.context.readRemainingPP(moved) === null);
reordered.headerRow.cells[0].setAttribute('colspan', '1');
moved.cells[1].textContent = '10/1000';
ok('progress fraction is not mistaken for remaining PP', b.context.readRemainingPP(moved) === null);
moved.cells[1].textContent = '1000'; b.make('td', 'New column', moved);
ok('a shifted body without a matching header fails closed', b.context.readRemainingPP(moved) === null);

const c = setup();
const missing = c.table(['Building', 'Progress', 'Other']);
const marked = missing.row('Robotic Factory', ['Robotic Factory', '15', 'N/A']);
marked.cells[1].setAttribute('class', 'building-lvl-up');
c.record(); c.context.initBuildingValueHints();
ok('structural level marker supports fallback without a remaining-cost or level header', c.badge(marked).textContent.startsWith('~ SU ↓') && c.neutral().length === 0);
marked.cells[1].textContent = '15 (80%)'; c.context.initBuildingValueHints();
ok('mixed level/progress text cannot create a guessed building cost', !c.badge(marked) && c.neutral().length === 1);
marked.cells[1].textContent = '15';
c.make('span', '16', marked).setAttribute('class', 'building-lvl-up');
c.context.initBuildingValueHints();
ok('multiple level markers cannot create an arbitrary estimate', !c.badge(marked));

const d = setup(); const equalTable = d.table(); const equalRow = equalTable.row('Robotic Factory');
d.record({ 'Production Point': '$0.65', 'Supply Unit': '$750', 'Robotic Factory': '$100' }); d.context.initBuildingValueHints();
ok('equal market costs produce an explicit same-cost result', d.badge(equalRow).textContent === 'Same cost');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/core/building-value-hints.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok('advice has no network or game-action capability', !/\bfetch\s*\(|\bgameFetch\s*\(|\.submit\s*\(|requestSubmit|\.click\s*\(/.test(source));
if (failed) process.exitCode = 1;
else console.log('All building-value-hints checks passed');
