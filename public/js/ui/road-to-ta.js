import { esc } from '../utils/escape.js';
import '../utils/sqlite-time.js';
import '../utils/game-tables.js';
import '../utils/road-to-ta-model.js';

const { formatLocalDateTime } = globalThis.AWSqliteTime;
const T = globalThis.AWTables;
const M = globalThis.AWRoadToTA;
const MODES = [
    { key: 'rush', name: 'Rush for TA', gate: 2, description: 'Prioritize the first TA; limit development to the selected growth and production targets.' },
    { key: 'normal', name: 'Normal TA', gate: 3, description: 'Keep labs and cybernets developing while preparing the trade budget.' },
    { key: 'slow', name: 'Slow TA', gate: 6, description: 'Build a stronger development base before saving for agreements.' },
];
const FIELD_IDS = {
    ppPrice: 'price', cash: 'cash', completedTas: 'completed', playerLevel: 'level',
    horizonDays: 'horizon', social: 'social', scienceRate: 'science-rate',
    cultureRate: 'culture-rate', currentTradeBonusPct: 'trade-bonus',
    growthMultiplier: 'growth', productionMultiplier: 'production', scienceMultiplier: 'science',
};
const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const num = value => Number.isFinite(value) ? nf.format(value) : '—';
const observedAt = value => value == null ? 'Unknown' : when(value);
const when = value => value == null ? 'Not reached' : formatLocalDateTime(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const valueOf = input => input?.value.trim() === '' ? null : Number(input?.value);
const list = values => `<ul class="list-disc pl-5 space-y-1">${values.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;

// Isolated UI state per mounted panel. Nothing is written to intel or browser storage.
export function initRoadToTa(panel) {
    if (panel.dataset.initialized) return;
    panel.dataset.initialized = 'true';
    const $ = id => panel.querySelector(`#rta-${id}`);
    let snapshot = null, request = 0, controller = null, selectedMode = 'normal';
    let results = null, inputAtResult = null, added = 0, growthUsesBio = false;

    function close() {
        panel.classList.replace('translate-x-0', 'translate-x-full');
        document.getElementById('open-road-to-ta-btn')?.focus();
    }
    $('close').addEventListener('click', close);
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape' && panel.classList.contains('translate-x-0')) close();
    });

    function invalidate() {
        results = null;
        inputAtResult = null;
        $('results').innerHTML = '<p class="rta-help">Inputs changed. Compare strategies to update the forecast.</p>';
        updateConversion();
    }

    function updateConversion() {
        const price = valueOf($('price')), cash = valueOf($('cash'));
        if (valueOf($('completed')) === 5) {
            $('conversion').textContent = 'All five TA slots are already filled; no further TA fee is needed.';
            $('calculate').disabled = true;
            $('results').innerHTML = '<div class="rta-box text-sm">All five trade agreements are completed. No additional buildings or savings are needed for this goal.</div>';
            return;
        }
        $('calculate').disabled = false;
        const cost = $('trader').checked ? 0 : 20000;
        $('conversion').textContent = price > 0 && cash != null
            ? `Next fee: ${num(cost)} A$ · Remaining cash gap: ${num(Math.max(0, cost - cash))} A$ · ${num(Math.max(0, cost - cash) / price)} PP at this price, before siege losses`
            : 'Enter a sale price and available A$ to calculate the PP equivalent.';
    }

    function planetRow(planet, manual = false) {
        const row = document.createElement('tr');
        row.dataset.planetId = String(planet.id ?? `${planet.system_id}:${planet.planet_index}`);
        row.dataset.planetName = planet.name || `${planet.system_name || planet.system_id} #${planet.planet_index}`;
        const source = manual ? 'Scenario input' : observedAt(planet.updated_at);
        const cell = (key, value, max, required = true) => `<td><input data-field="${key}" aria-label="${esc(row.dataset.planetName)} ${key}" type="number" min="0" ${max ? `max="${max}"` : ''} step="${['pp', 'growthPoints'].includes(key) ? 'any' : '1'}" ${required ? 'required' : ''} value="${esc(value ?? '')}" ${required ? '' : 'placeholder="0 (assumed)"'}></td>`;
        row.innerHTML = `<td><span class="text-foreground whitespace-nowrap">${esc(row.dataset.planetName)}</span><div class="rta-help whitespace-nowrap">${esc(source)}</div></td>`
            + cell('population', planet.population, 100)
            + cell('HF', planet.farm, 100) + cell('RF', planet.factory, 100)
            + cell('RL', planet.lab, 100) + cell('GC', planet.cybernetics, 100)
            + cell('pp', planet.local_pp) + cell('growthPoints', planet.growth_progress, null, false)
            + `<td><input data-field="is_sieged" type="checkbox" aria-label="${esc(row.dataset.planetName)} under siege" ${planet.is_sieged ? 'checked' : ''}></td>`
            + `<td>${manual ? '<button type="button" class="text-zinc-400 hover:text-white" aria-label="Remove added planet">Remove</button>' : ''}</td>`;
        row.querySelector('[data-field="population"]').min = '1';
        row.querySelector('button')?.addEventListener('click', () => { row.remove(); invalidate(); });
        return row;
    }

    function populate(data) {
        snapshot = data;
        results = null;
        growthUsesBio = false;
        $('results').replaceChildren();
        const player = data.player;
        $('inputs').disabled = !player;
        if (!player) {
            $('status').textContent = 'Choose a member to load their saved planets and economic snapshot. Link your game name to select yourself automatically.';
            $('planets').replaceChildren();
            return;
        }
        $('status').textContent = `Saved intelligence for ${player.name}. Complete the unknown fields and check the snapshot dates before planning.`;
        const values = {
            cash: player.astro_dollars, completed: player.trade_partners?.length,
            level: player.level, social: player.social, 'science-rate': player.science_rate,
            'production-rate': player.production_rate, 'culture-rate': player.culture_rate,
            'trade-bonus': player.trade_revenue, 'eco-bonus': null, price: data.market.pp_price,
            growth: null, production: null, science: null, horizon: 60,
        };
        for (const [key, value] of Object.entries(values)) $(key).value = value ?? '';
        $('trader').checked = !!(player.has_intel && player.race_trader);
        $('market-stamp').textContent = `Last recorded market price: ${num(data.market.pp_price)} A$/PP · ${observedAt(data.market.updated_at)}. Confirm the current selling quote; future market movement is unknown.`;
        $('development-stamp').textContent = `Economy snapshot: ${observedAt(player.sheet_updated_at)} · Bio: ${observedAt(player.intel_updated_at)}. Automatic production/science multipliers require all current planets and their building levels. Economy bonus is not verified by the API snapshot: confirm 0% or 5% separately. Growth requires an effective multiplier, or use the saved bio/artifact action after confirming the bonuses.`;
        $('coverage').textContent = `${data.planets.length} known planet(s) / ${player.total_planets ?? 'unknown'} reported. ${player.planet_count_matches ? 'Planet count matches the saved profile.' : 'Coverage is incomplete or inconsistent: add missing current planets or refresh the source first.'} Buildings and local PP must be entered separately. Saved total PP: ${num(player.production_points)} (check against the local balances you enter).`;
        $('planets').replaceChildren(...data.planets.map(p => planetRow(p)));
        $('partners').replaceChildren();
        updatePartners();
        updateConversion();
    }

    async function load(playerId) {
        const revision = ++request;
        controller?.abort();
        controller = new AbortController();
        $('inputs').disabled = true;
        $('reload').disabled = true;
        snapshot = null;
        results = null;
        $('results').replaceChildren();
        $('status').textContent = 'Loading saved intelligence…';
        try {
            const response = await fetch(`/hub-api/road-to-ta${playerId ? `?player_id=${encodeURIComponent(playerId)}` : ''}`, { signal: controller.signal });
            const data = await response.json();
            if (revision !== request) return;
            if (!response.ok || !data.success) throw new Error(data.error || 'Could not load Road to TA.');
            $('player').innerHTML = '<option value="">Choose a player</option>' + data.players.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
            $('player').value = data.player?.id ?? '';
            populate(data);
        } catch (err) {
            if (revision !== request || err.name === 'AbortError') return;
            $('status').textContent = `Could not load saved intelligence: ${err.message}. Use Reload to retry.`;
        } finally {
            if (revision === request) $('reload').disabled = false;
        }
    }

    function updatePartners() {
        const completed = valueOf($('completed'));
        const previous = Array.from($('partners').querySelectorAll('input'), el => [el.dataset.number, el.value]);
        const values = new Map(previous);
        $('partners').innerHTML = Number.isInteger(completed) && completed >= 0 && completed <= 5
            ? Array.from({ length: 5 - completed }, (_, i) => {
                const number = completed + i + 1;
                return `<label>TA ${number}: partner planets at 10+<input data-number="${number}" type="number" min="0" max="100" step="1" value="${esc(values.get(String(number)) ?? 0)}" required></label>`;
            }).join('') : '';
    }

    function readInput() {
        const input = { now: Date.now(), traderAccept: $('trader').checked };
        for (const [key, id] of Object.entries(FIELD_IDS)) input[key] = valueOf($(id));
        const ecoBonus = valueOf($('eco-bonus'));
        if (ecoBonus !== 0 && ecoBonus !== 5) throw new Error('Confirm whether the current economy bonus is 0% or 5%.');
        input.currentTradeBonusPct += ecoBonus;
        input.planets = Array.from($('planets').children, row => {
            const p = { id: row.dataset.planetId, name: row.dataset.planetName };
            row.querySelectorAll('input').forEach(el => { p[el.dataset.field] = el.type === 'checkbox' ? el.checked : valueOf(el); });
            // Unobserved progress is explicitly assumed zero on the input form.
            if (p.growthPoints == null) delete p.growthPoints;
            return p;
        });
        if (!input.planets.length) throw new Error('Add your current planets before comparing strategies.');
        const reported = snapshot.player.total_planets;
        if (reported != null && reported !== input.planets.length) throw new Error(`The saved profile reports ${reported} planets, but this scenario has ${input.planets.length}. Add missing planets or reload current intel.`);
        if (reported == null && (input.productionMultiplier == null || input.scienceMultiplier == null)) {
            throw new Error('The total planet count is unknown. Enter explicit production and science multipliers; automatic rates require a complete planet snapshot.');
        }
        const totalBase = field => input.planets.reduce((n, p) => n + p.population + p[field], 0);
        if (input.productionMultiplier == null) {
            const rate = valueOf($('production-rate'));
            if (!(rate > 0)) throw new Error('Enter a production multiplier or a measured PP/hour rate.');
            input.productionMultiplier = rate / totalBase('RF');
        }
        if (input.scienceMultiplier == null) {
            if (!(input.scienceRate > 0)) throw new Error('Enter a science multiplier or a positive science/hour rate.');
            input.scienceMultiplier = input.scienceRate / totalBase('RL');
        }
        input.partnerQualifiedPlanets = Array.from($('partners').querySelectorAll('input'), valueOf);
        return input;
    }

    function renderResults() {
        if (!results) return;
        const selected = results.find(x => x.mode === selectedMode);
        $('results').innerHTML = `<div class="space-y-5"><h3 class="font-semibold">Strategy comparison</h3><p class="rta-help">Scenario starts ${esc(when(inputAtResult.now))}. All dates use your browser timezone. Targets are selected from a bounded strategy search, not a guarantee of the best possible play.</p><div class="rta-strategies">${MODES.map(mode => {
            const result = results.find(x => x.mode === mode.key);
            const first = result.agreements?.[0];
            return `<button type="button" data-mode="${mode.key}" aria-pressed="${selectedMode === mode.key}" class="rta-box text-left space-y-2" style="border-color:${selectedMode === mode.key ? '#e4e4e7' : '#27272a'}"><div class="font-semibold text-sm">${mode.name}</div><div class="rta-help">${mode.gate} planets at population 10+</div><p class="rta-help">${mode.description}</p><div class="text-sm">${result.ok ? (first ? `Next TA: ${esc(when(first.activeAt))}` : (inputAtResult.completedTas === 5 ? 'All 5 agreements completed' : 'Not reached within horizon')) : 'Needs more data or planets'}</div></button>`;
        }).join('')}</div><div id="rta-detail">${detail(selected)}</div></div>`;
        $('results').querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
            selectedMode = button.dataset.mode;
            renderResults();
            $('results').querySelector(`[data-mode="${selectedMode}"]`)?.focus();
        }));
    }

    function detail(result) {
        if (!result) return '';
        if (inputAtResult.completedTas === 5) return '<div class="rta-box text-sm">All five trade agreements are completed. There is no further TA to fund or development plan to follow for this goal.</div>';
        if (!result.ok) return `<div class="rta-box rta-help text-amber-300">${list(result.errors || ['The scenario cannot be calculated.'])}</div>`;
        const prices = [0.8, 1, 1.2].map(factor => {
            const forecast = factor === 1 ? result : M.plan({ ...inputAtResult, mode: result.mode, ppPrice: inputAtResult.ppPrice * factor });
            return `<tr><td>${num(inputAtResult.ppPrice * factor)} A$/PP${factor === 1 ? ' (chosen)' : ''}</td><td>${forecast.ok ? esc(when(forecast.agreements?.[0]?.activeAt)) : 'Unavailable'}</td></tr>`;
        }).join('');
        const gates = `<div class="rta-grid"><div class="rta-box"><div class="rta-help">Population gate (${result.gate.qualifiedNow}/${result.gate.requiredPlanets} now)</div><div class="font-semibold">${esc(when(result.gate.at))}</div></div><div class="rta-box"><div class="rta-help">All selected building targets complete / saving</div><div class="font-semibold">${esc(when(result.savingAt))}</div></div><div class="rta-box"><div class="rta-help">Building investment</div><div class="font-semibold">${num(result.totals.buildingPP)} PP</div></div></div>`;
        const agreements = result.agreements.map(a => `<tr><td>TA ${a.number}</td><td>${num(a.cost)} A$</td><td>${esc(when(a.fundedAt))}</td><td>${esc(when(a.activeAt))}</td><td>+${num(a.partnerQualifiedPlanets)}%</td></tr>`).join('');
        const planets = result.planets.map(p => `<tr><td>${esc(p.name)}</td><td>${p.start.HF} → ${p.target.HF}</td><td>${p.start.RF} → ${p.target.RF}</td><td>${p.start.RL} → ${p.target.RL}</td><td>${p.start.GC} → ${p.target.GC}</td><td>${esc(when(p.savingAt))}</td></tr>`).join('');
        const builds = result.planets.flatMap(p => p.builds.map(b => ({ ...b, planet: p.name }))).sort((a, b) => a.hours - b.hours || a.planet.localeCompare(b.planet));
        const buildRows = builds.map(b => `<tr><td>${esc(when(b.at))}</td><td>${esc(b.planet)}</td><td>${esc(b.building)} ${b.from} → ${b.to}</td><td>${num(b.cost)} PP</td></tr>`).join('');
        return `<div class="space-y-5">${gates}
            <section class="rta-box space-y-3"><h4 class="font-semibold text-sm">Next agreements</h4><p class="rta-help">Funding is conditional on the population gate and sale rules. Activation uses the next eligible Berlin acceptance window plus a conservative five-minute bonus refresh buffer. Partners must be ready too.</p><div class="overflow-x-auto"><table class="rta-table"><thead><tr><th>Agreement</th><th>Your fee</th><th>Funds ready</th><th>Active estimate (+5 min buffer)</th><th>Partner bonus</th></tr></thead><tbody>${agreements || '<tr><td colspan="5">No further TA reached within this horizon.</td></tr>'}</tbody></table></div></section>
            <section class="rta-box space-y-3"><h4 class="font-semibold text-sm">Build here, then stop and save</h4><p class="rta-help">Levels never decrease. Each planet pays for its own buildings. Stop building there at the listed time and accumulate PP. Once all selected targets are complete, Spend All sells the combined PP into A$ for TA. Research output continues while PP are saved.</p><div class="overflow-x-auto"><table class="rta-table"><thead><tr><th>Planet</th><th>Farms</th><th>Factories</th><th>Labs</th><th>Cybernets</th><th>Saving from</th></tr></thead><tbody>${planets}</tbody></table></div></section>
            <section class="rta-box space-y-3"><h4 class="font-semibold text-sm">If the market price changes</h4><p class="rta-help">Separate constant-price scenarios, each with its own selected building targets. These are sensitivity checks, not a market prediction.</p><table class="rta-table"><thead><tr><th>Sale price</th><th>Next TA active estimate</th></tr></thead><tbody>${prices}</tbody></table></section>
            <details class="rta-box"><summary class="cursor-pointer text-sm font-semibold">Ordered building plan (${builds.length} upgrades)</summary><div class="overflow-x-auto"><table class="rta-table"><thead><tr><th>Estimated time</th><th>Planet</th><th>Upgrade</th><th>Local cost</th></tr></thead><tbody>${buildRows || '<tr><td colspan="4">No upgrades scheduled before funding or the forecast horizon.</td></tr>'}</tbody></table></div></details>
            <details class="rta-box" open><summary class="cursor-pointer text-sm font-semibold">Assumptions &amp; limits</summary><div class="rta-help mt-3">${list([...(result.warnings || []), ...(result.assumptions || [])])}<p class="mt-3">PP produced: ${num(result.totals.earnedPP)} · PP built: ${num(result.totals.buildingPP)} · PP sold: ${num(result.totals.soldPP)} · A$ spent: ${num(result.totals.spentCash)}. Simulated ${num(result.totals.simulatedHours / 24)} days of the ${num(result.horizonHours / 24)}-day horizon.</p></div></details>
        </div>`;
    }

    $('form').addEventListener('input', event => {
        if (event.target === $('completed')) updatePartners();
        if (event.target === $('growth')) growthUsesBio = false;
        if (growthUsesBio && [ $('trade-bonus'), $('eco-bonus') ].includes(event.target)) {
            $('growth').value = '';
            growthUsesBio = false;
        }
        invalidate();
    });
    $('form').addEventListener('change', invalidate);
    $('form').addEventListener('submit', event => {
        event.preventDefault();
        if ($('inputs').disabled || !$('form').reportValidity() || !snapshot?.player) return;
        try {
            inputAtResult = readInput();
            results = MODES.map(mode => ({ ...M.plan({ ...inputAtResult, mode: mode.key }), mode: mode.key }));
            renderResults();
        } catch (err) {
            results = null;
            $('results').innerHTML = `<p role="alert" class="rta-box text-sm text-amber-300">${esc(err.message)}</p>`;
        }
    });
    $('use-bio').addEventListener('click', () => {
        const player = snapshot?.player;
        const eco = valueOf($('eco-bonus')), trade = valueOf($('trade-bonus'));
        let artifactName = player?.artefact;
        try { artifactName = JSON.parse(artifactName)?.name || artifactName; } catch (_) { /* plain observed name */ }
        const artifact = T.ARTIFACTS.find(a => a.name.toLowerCase() === String(artifactName || '').toLowerCase());
        if (!player?.has_intel || player.race_growth == null || !artifact || ![0, 5].includes(eco) || trade == null || trade < 0) {
            $('results').innerHTML = '<p role="alert" class="rta-box text-sm text-amber-300">This calculation needs confirmed race growth, a recognized active artifact, and explicit trade and economy bonuses. Enter your effective growth multiplier manually if any source is missing.</p>';
            return;
        }
        $('growth').value = Math.round((1 + player.race_growth * 0.08) * (1 + (trade + eco) / 100) * (1 + artifact.growth) * 1000000) / 1000000;
        growthUsesBio = true;
        invalidate();
    });
    $('add-planet').addEventListener('click', () => {
        if ($('planets').children.length >= 100) return;
        $('planets').appendChild(planetRow({ id: `manual-${++added}`, name: `Additional planet ${added}` }, true));
        invalidate();
    });
    $('player').addEventListener('change', () => load($('player').value));
    $('reload').addEventListener('click', () => load($('player').value));
    load();
}
