// PLANET PAGE: ONE-TAP SUPPLY UNIT SPEND — /Game/Planets/Planet/{id}
//
// Asked for by the operator (2026-09-28): a "+1" button, and "+All" when more than one is
// held, on each building row of the planet page, spending Supply Units on that building
// without going through the Spend Points page by hand.
//
// This is the first hub feature that performs a game action for a member. The operator's
// line: automation is the game acting without the member; a shortcut the member taps is
// not. The boundaries that keep it a shortcut, each enforced by a source-scanning test:
//   - it only ever acts on the member's own tap, one spend per tap, never on a timer,
//     page load or loop;
//   - it only ever posts the game's own Supply Unit form, with the values the member
//     picked, to the Spend Points page of the planet they are looking at;
//   - every request goes through gameFetch, so it counts against the agreed 5/s budget
//     and carries the automated-traffic marker like any other hub request.
//
// Form shape recorded from the live page (2026-09-28): /Game/Planets/SpendPoints/{id} holds
// two forms; the Supply Unit one has input#SupplyUnitsToUse (max = units held), one radio
// per building named SpendTo (value = building name), a hidden UseSupplyUnit=true and the
// anti-forgery token. Starbases and ships are not offered there, so they get no buttons.
import '../utils/game-rate-limit.js';
import { forceTradeInventorySync } from '../ui/trade-inventory-watch.js';

const SU_BUILDINGS = ['Hydroponic Farm', 'Robotic Factory', 'Galactic Cybernet', 'Research Lab'];
const MARK = 'data-aw-su-buttons';

// Reads the Supply Unit form off a parsed Spend Points document. null when the page offers
// no Supply Unit form (none held) or its shape is not what was recorded.
function readSupplyUnitForm(doc) {
    const qty = doc.getElementById('SupplyUnitsToUse');
    const form = qty && qty.closest('form');
    if (!form) return null;
    const token = form.querySelector('input[name="__RequestVerificationToken"]');
    const held = parseInt(qty.getAttribute('max'), 10);
    if (!token || !token.value || !Number.isInteger(held) || held < 1) return null;
    const buildings = SU_BUILDINGS.filter(b => form.querySelector(`input[name="SpendTo"][value="${b}"]`));
    return { held, token: token.value, buildings };
}

// The exact fields the game's own Supply Unit form submits.
function supplyUnitSpendBody({ units, building, token }) {
    const body = new URLSearchParams();
    body.set('SupplyUnitsToUse', String(units));
    body.set('__Invariant', 'SupplyUnitsToUse');
    body.set('SpendTo', building);
    body.set('UseSupplyUnit', 'true');
    body.set('__RequestVerificationToken', token);
    return body;
}

// How many units a tap spends: 1, or everything held for "+All". Never more than held.
function unitsFor(which, held) {
    if (!Number.isInteger(held) || held < 1) return 0;
    return which === 'all' ? held : 1;
}

async function spend(planetId, building, which, status) {
    const { gameFetch } = globalThis.AWGameRate;
    const url = `/Game/Planets/SpendPoints/${planetId}`;
    status('checking…');
    const page = await gameFetch(url);
    if (!page.ok) return status(`could not open Spend Points (${page.status})`, true);
    const form = readSupplyUnitForm(new DOMParser().parseFromString(await page.text(), 'text/html'));
    if (!form) return status('no Supply Units to spend', true);
    if (!form.buildings.includes(building)) return status(`${building} cannot take Supply Units here`, true);
    const units = unitsFor(which, form.held);
    status(`spending ${units}…`);
    const res = await gameFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: supplyUnitSpendBody({ units, building, token: form.token }).toString(),
    });
    if (!res.ok) return status(`the game refused (${res.status})`, true);
    status(`spent ${units} ✓`);
    // Keep My Savings honest about what is left, then show the new building level.
    try { await forceTradeInventorySync(); }
    catch (e) { console.warn('[SU spend] inventory re-sync failed; the next background check catches up:', e.message); }
    window.location.reload();
}

let heldFromHub = null;

async function initSupplyUnitButtons() {
    const match = window.location.pathname.match(/\/Game\/Planets\/Planet\/(\d+)/i);
    if (!match) return;
    const planetId = match[1];
    const rows = [...document.querySelectorAll('tr[data-spend-to]')].filter(r => SU_BUILDINGS.includes(r.getAttribute('data-spend-to')));
    if (!rows.length || rows.every(r => r.hasAttribute(MARK))) return;

    // Whether to show anything at all comes from the hub's copy of the member's Trade
    // inventory, so a planet page view with no Supply Units costs no game request.
    if (heldFromHub === null) {
        try {
            const res = await fetch('/hub-api/my-planets/sell-picks');
            const data = await res.json();
            const su = data && data.success ? (data.items || []).find(it => it.name === 'Supply Unit') : null;
            heldFromHub = su ? su.held : 0;
        } catch (e) { heldFromHub = 0; }
    }
    if (heldFromHub < 1) return;

    for (const row of rows) {
        if (row.hasAttribute(MARK)) continue;
        row.setAttribute(MARK, '1');
        const building = row.getAttribute('data-spend-to');
        const cell = row.querySelector('td');
        if (!cell) continue;
        const box = document.createElement('span');
        box.style.cssText = 'margin-left:6px;white-space:nowrap;';
        const kinds = heldFromHub > 1 ? ['one', 'all'] : ['one'];
        box.innerHTML = kinds.map(k => `<button type="button" data-aw-su="${k}" class="btn btn-sm btn-outline-info py-0 px-1 ms-1" title="Spend ${k === 'all' ? 'all your Supply Units' : '1 Supply Unit'} on ${building}">${k === 'all' ? '+All' : '+1'} SU</button>`).join('')
            + '<span data-aw-su-status style="margin-left:6px;font-size:11px;color:#aaa;"></span>';
        cell.appendChild(box);
        const statusEl = box.querySelector('[data-aw-su-status]');
        const status = (text, isError) => { statusEl.textContent = text; statusEl.style.color = isError ? '#e88' : '#aaa'; };
        box.querySelectorAll('[data-aw-su]').forEach(btn => btn.addEventListener('click', async (event) => {
            // The game navigates when a building row is clicked; this tap is ours alone.
            event.stopPropagation();
            event.preventDefault();
            box.querySelectorAll('button').forEach(b => { b.disabled = true; });
            try { await spend(planetId, building, btn.getAttribute('data-aw-su'), status); }
            catch (err) { status('failed — reload the page to see what happened', true); }
            finally { box.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
        }));
    }
}

export { initSupplyUnitButtons, readSupplyUnitForm, supplyUnitSpendBody, unitsFor, SU_BUILDINGS };
