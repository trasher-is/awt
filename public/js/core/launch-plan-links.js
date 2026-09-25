// FLEET LAUNCH: YOUR PLANS AS ONE-CLICK DESTINATIONS — /Game/Fleets/Launch/{id}
//
// Asked for by a member (2026-09-25): "I plan to colonise SID 140 planet 4, so on the
// launch screen give me a link that fills in the destination." This lists the member's own
// planned planets above the form; clicking one sets the System and Planet # fields, and
// nothing else. Ships, and the Launch button, stay entirely the member's own doing.
//
// What this deliberately does NOT do, because the game's administrator forbids automating
// actions and this file must stay on the "inform and assist" side of that line:
//   - it never submits the form, clicks a game button or picks ships;
//   - it never acts on its own: the form only changes when the member clicks a plan;
//   - it makes no request to the game. The one fetch is to the hub for the plan list.
//
// The launch form's markup has not been recorded in this repo, so the fill is defensive:
// it sets the field, fires the input/change events the game's own scripts listen for,
// waits briefly if the planet list is only filled in after a system is chosen, and says so
// plainly on the page when a value did not take instead of pretending it worked.
import { esc } from '../utils/escape.js';

const CONTAINER_ID = 'aw-launch-plan-links';
const PLANET_WAIT_MS = 3000;

function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
}

function hasOption(el, value) {
    if (!el.options) return true; // a plain input accepts any value
    return [...el.options].some(o => String(o.value) === value);
}

function setField(el, value) {
    if (!hasOption(el, value)) return false;
    el.value = value;
    fire(el, 'input');
    fire(el, 'change');
    return String(el.value) === value;
}

// Resolves true once the page has rebuilt `el`'s option list AND the rebuilt list offers
// `value`, or false after `timeoutMs`. A rebuild can come in two steps (list cleared, then
// refilled after a fetch), so a change that leaves `value` missing keeps it waiting.
//
// The real launch form (recorded 2026-09-25) always lists planets 1-12, whatever system is
// selected, and rebuilds that list asynchronously when System changes (data-update-planets,
// handled by the game's fleetLaunch.js). So "the option already exists" proves nothing:
// setting the planet straight away was wiped a moment later by the rebuild. The planet is
// set only once the rebuild has landed, or after the timeout if the page never rebuilds.
function waitForRebuild(el, value, timeoutMs, Observer = globalThis.MutationObserver) {
    if (typeof Observer !== 'function') return new Promise(res => setTimeout(() => res(false), timeoutMs));
    return new Promise(resolve => {
        const observer = new Observer(() => {
            if (!hasOption(el, value)) return; // cleared, not yet refilled
            observer.disconnect();
            clearTimeout(timer);
            // Let the page finish its batch of DOM writes before we pick an option.
            setTimeout(() => resolve(true), 0);
        });
        const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeoutMs);
        observer.observe(el, { childList: true, subtree: true });
    });
}

/**
 * Fill the launch form's destination with one plan. Returns { ok, message }.
 * Touches only the two destination fields; never submits anything.
 */
async function applyPlanToLaunchForm(systemEl, planetEl, plan, { waitMs = PLANET_WAIT_MS, Observer } = {}) {
    const systemValue = String(plan.system_id);
    const planetValue = String(plan.planet_index);
    if (String(systemEl.value) !== systemValue) {
        // Watch before changing System, so a rebuild that starts synchronously is not missed.
        const rebuilt = waitForRebuild(planetEl, planetValue, waitMs, Observer);
        if (!setField(systemEl, systemValue)) {
            return { ok: false, message: `System ${systemValue} is not in this form's list — pick it by hand.` };
        }
        await rebuilt;
    }
    if (!setField(planetEl, planetValue)) {
        return { ok: false, message: `System set; planet #${planetValue} could not be selected — pick it by hand.` };
    }
    return { ok: true, message: `Destination set to ${plan.system_name || `system ${systemValue}`} #${planetValue}. Choose your ships and launch as usual.` };
}

let loading = false;

async function initLaunchPlanLinks() {
    if (!window.location.pathname.toLowerCase().includes('/game/fleets/launch/')) return;
    const systemEl = document.getElementById('System');
    const planetEl = document.getElementById('PlanetIndex');
    if (!systemEl || !planetEl || document.getElementById(CONTAINER_ID) || loading) return;
    const anchorRow = systemEl.closest('tr');
    if (!anchorRow) return;

    loading = true;
    let plans;
    try {
        const res = await fetch('/hub-api/intel/colonize-launch-windows');
        const data = await res.json();
        plans = data && data.success && Array.isArray(data.plans) ? data.plans : [];
    } catch (err) {
        plans = [];
    } finally {
        loading = false;
    }
    if (!plans.length || document.getElementById(CONTAINER_ID)) return;

    const row = document.createElement('tr');
    row.id = CONTAINER_ID;
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.style.cssText = 'padding-bottom:6px;font-size:12px;';
    cell.innerHTML = '<span style="color:#888;">Your plans:</span> '
        + plans.map((p, i) => {
            const held = p.owner_name ? ` title="Held by ${esc(p.owner_name)}"` : '';
            return `<a href="#" data-plan="${i}"${held} style="margin-right:10px;">${esc(p.system_name || `System ${p.system_id}`)} [${p.system_id}] #${p.planet_index}</a>`;
        }).join('')
        + '<div data-plan-feedback style="color:#aaa;margin-top:2px;"></div>';
    row.appendChild(cell);
    anchorRow.insertAdjacentElement('beforebegin', row);

    const feedback = cell.querySelector('[data-plan-feedback]');
    cell.querySelectorAll('[data-plan]').forEach(link => link.addEventListener('click', async (event) => {
        event.preventDefault();
        const plan = plans[Number(link.dataset.plan)];
        const system = document.getElementById('System');
        const planet = document.getElementById('PlanetIndex');
        if (!plan || !system || !planet) return;
        const result = await applyPlanToLaunchForm(system, planet, plan);
        feedback.style.color = result.ok ? '#8c8' : '#e88';
        feedback.textContent = result.message;
    }));
}

export { initLaunchPlanLinks, applyPlanToLaunchForm };
