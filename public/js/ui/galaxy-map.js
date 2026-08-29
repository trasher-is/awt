// Galaxy Archive — an independent canvas map of the whole galaxy, drawn from the hub's
// own archive rather than from the game's map component.
//
// ─── WHY NOT AN OVERLAY ───────────────────────────────────────────────────────
// public/js/core/spy.js annotates the game's live map, and that is the right place for
// anything about the CURRENT state: it has fresher data than we ever will, and clicking a
// system there already opens System Intel. Fighting it for pixels was tried before and
// the map stopped loading.
//
// This panel is for the questions that map cannot answer, because they are about what is
// NOT in front of you:
//   • the whole galaxy at once, with no panning and no vision limit
//   • systems currently out of vision, as of the last time anyone looked
//   • how old that answer is
//
// So it is a separate surface with its own data, and the game's DOM is never touched.
//
// ─── COVERAGE IS NOT UNIFORM, AND THE MAP MUST SAY SO ─────────────────────────
// Coordinates are complete: galaxy-parser.js reads every system from the travel
// calculator's dropdown. Contents are not — a system nobody has scanned has no planet
// rows. Drawing "never visited" and "visited, nothing there" the same way would turn a
// hole in our intel into a claim about the galaxy, so unscanned systems are hollow rings
// and scanned ones are filled.
import { esc } from '../utils/escape.js';
import '../utils/vision-model.js';   // side-effect import: the !vision rule, defined once
import '../utils/travel-model.js';   // side-effect import: THE travel formula, defined once
import '../utils/game-rate-limit.js'; // side-effect import: the shared 5/s gate AWApi rides
import '../utils/aw-api.js';         // side-effect import: the game API client, gate included

const { coverage: visionCoverage, visionRadius } = globalThis.AWVision;
// All travel math comes from the shared model — this file holds no formula constants.
const { calcTravelSeconds, isochroneRadius } = globalThis.AWTravelModel;
const AWApi = globalThis.AWApi;

const PREFS_KEY = 'awt.galaxyMap.layers.v1';

const DEFAULT_LAYERS = {
    territories: true,
    vision: false,
    free: false,
    stale: false,
    labels: false,
    isochrones: false,
};

// Isochrone controls: origin system, the fleet the rings are drawn for, and the three
// time bands. Defaults are a standing fleet (energy 0, speed 0) at half-day/day/two-day
// bands. IMPORTANT: these times are STANDARD round pace — the model has no pace
// multiplier, and the current RedZone round runs ×10; the panel says so on screen.
const DEFAULT_ISO = {
    origin: null,      // system id; null until derived from own home or picked by hand
    energy: 0,         // 0..100
    speed: 0,          // race speed, -4..+4
    alliance: false,   // allied / own-destination move (halved)
    hours: [12, 24, 48],
};

// Band colours, innermost first: reachable soonest reads green, latest reads red. The
// wash goes under the system dots so ownership fill stays legible on top of it.
const ISO_BANDS = [
    { stroke: 'rgba(74,222,128,0.7)',  wash: 'rgba(74,222,128,0.20)' },
    { stroke: 'rgba(251,191,36,0.6)',  wash: 'rgba(251,191,36,0.17)' },
    { stroke: 'rgba(248,113,113,0.55)', wash: 'rgba(248,113,113,0.14)' },
];

// Colour for an alliance tag. The game's own API exposes Alliance.color, but the map does
// not sync a colour feed — it derives a stable hue from the tag instead: the same alliance
// is the same colour on every member's screen and across reloads, which is the property
// that actually matters for reading a map. Our own alliance is special-cased to a colour
// no hash can produce, so "us" never blends into a rival.
const OWN_COLOUR = '#22d3ee';
function allianceColour(tag) {
    let hash = 0;
    for (let i = 0; i < String(tag).length; i++) hash = (hash * 31 + String(tag).charCodeAt(i)) >>> 0;
    const hue = hash % 360;
    // Keep away from the cyan band reserved for our own alliance.
    const shifted = (hue >= 165 && hue <= 205) ? (hue + 60) % 360 : hue;
    return `hsl(${shifted} 70% 58%)`;
}

let state = null;

function loadPrefs(userId) {
    try {
        const raw = localStorage.getItem(`${PREFS_KEY}.${userId != null ? userId : 'anon'}`);
        if (!raw) return { ...DEFAULT_LAYERS };
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_LAYERS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch (err) {
        console.warn('[GalaxyMap] Could not read layer preferences:', err.message);
        return { ...DEFAULT_LAYERS };
    }
}

function savePrefs(userId, layers) {
    try {
        localStorage.setItem(`${PREFS_KEY}.${userId != null ? userId : 'anon'}`, JSON.stringify(layers));
    } catch (err) {
        // Private mode, or storage full. Losing a checkbox between sessions is not worth
        // an error the member has to dismiss.
        console.warn('[GalaxyMap] Could not save layer preferences:', err.message);
    }
}

// The isochrone controls ride in the same per-user prefs record, under an `iso` key the
// layer loop never iterates. Stored values are member input from an older session, so
// they are re-clamped on the way in — a hand-edited record must not draw nonsense.
function sanitizeIso(saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const int = (v, lo, hi, fallback) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
    };
    const hours = DEFAULT_ISO.hours.map((fallback, i) => {
        const h = Array.isArray(s.hours) ? parseFloat(s.hours[i]) : NaN;
        return Number.isFinite(h) && h > 0 ? h : fallback;
    });
    return {
        origin: Number.isFinite(parseInt(s.origin, 10)) ? parseInt(s.origin, 10) : null,
        energy: int(s.energy, 0, 100, DEFAULT_ISO.energy),
        speed: int(s.speed, -4, 4, DEFAULT_ISO.speed),
        alliance: !!s.alliance,
        hours,
    };
}

function persistPrefs() {
    savePrefs(state.userId, { ...state.layers, iso: state.iso });
}

function ageDays(iso) {
    if (!iso) return null;
    // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC; Safari refuses that without the T.
    const t = Date.parse(String(iso).replace(' ', 'T') + (/[Z+]/.test(iso) ? '' : 'Z'));
    if (!Number.isFinite(t)) return null;
    return (Date.now() - t) / 86400000;
}

function describeAge(days) {
    if (days == null) return 'never scanned';
    if (days < 1) return 'under a day old';
    if (days < 2) return 'about a day old';
    return `${Math.floor(days)} days old`;
}

// ─── VIEWPORT ────────────────────────────────────────────────────────────────

function fitToData() {
    const { systems, canvas } = state;
    if (!systems.length) return;
    const xs = systems.map(s => s.x), ys = systems.map(s => s.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const pad = 40;
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    state.scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    state.offsetX = w / 2 - ((minX + maxX) / 2) * state.scale;
    state.offsetY = h / 2 - ((minY + maxY) / 2) * state.scale;
}

const toScreen = (x, y) => ({ sx: x * state.scale + state.offsetX, sy: y * state.scale + state.offsetY });

function zoomAt(factor, cx, cy) {
    const before = state.scale;
    state.scale = Math.max(2, Math.min(220, state.scale * factor));
    // Keep the point under the cursor fixed.
    state.offsetX = cx - (cx - state.offsetX) * (state.scale / before);
    state.offsetY = cy - (cy - state.offsetY) * (state.scale / before);
    draw();
}

// ─── DRAWING ─────────────────────────────────────────────────────────────────

function radiusFor(system) {
    // Size carries how much we know, not how important the system is: a system with 12
    // known planets is a bigger dot than one with 2, and an unscanned one is smallest.
    const base = 2.2 + Math.min(4.5, system.known * 0.32);
    return Math.max(1.8, base * Math.min(1.6, Math.max(0.55, state.scale / 26)));
}

function fillFor(system) {
    const { layers, ownTag } = state;
    if (!system.known) return null;                         // never scanned: outline only
    if (!layers.territories) return 'rgba(148,163,184,0.85)';
    if (!system.top) return 'rgba(100,116,139,0.75)';       // scanned, nobody holds it
    return system.top === ownTag ? OWN_COLOUR : allianceColour(system.top);
}

function draw() {
    const { ctx, canvas, systems, layers } = state;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    drawGrid(ctx, w, h);

    // Isochrones under everything: three "reachable within T" rings around the origin,
    // and a band-coloured wash under each system dot so ownership fill stays readable on
    // top. Radii are world units from the shared model, scaled to pixels here.
    if (layers.isochrones && state.isoOrigin) {
        const o = toScreen(state.isoOrigin.x, state.isoOrigin.y);

        for (const s of systems) {
            const band = state.isoBands.get(s.id);
            if (band === undefined) continue;
            const { sx, sy } = toScreen(s.x, s.y);
            if (sx < -30 || sy < -30 || sx > w + 30 || sy > h + 30) continue;
            ctx.fillStyle = ISO_BANDS[band].wash;
            ctx.beginPath();
            ctx.arc(sx, sy, radiusFor(s) + 4, 0, Math.PI * 2);
            ctx.fill();
        }

        for (let i = state.isoRings.length - 1; i >= 0; i--) {
            const ring = state.isoRings[i];
            if (!(ring.radius > 0)) continue;   // budget below the deep-space minimum
            ctx.strokeStyle = ISO_BANDS[i].stroke;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.arc(o.sx, o.sy, ring.radius * state.scale, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // The origin itself: a crosshair no band colour can be mistaken for.
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(o.sx, o.sy, 6, 0, Math.PI * 2);
        ctx.moveTo(o.sx - 10, o.sy); ctx.lineTo(o.sx - 4, o.sy);
        ctx.moveTo(o.sx + 4, o.sy);  ctx.lineTo(o.sx + 10, o.sy);
        ctx.moveTo(o.sx, o.sy - 10); ctx.lineTo(o.sx, o.sy - 4);
        ctx.moveTo(o.sx, o.sy + 4);  ctx.lineTo(o.sx, o.sy + 10);
        ctx.stroke();
    }

    // Vision first, underneath everything, so it reads as a wash rather than as a marker.
    if (layers.vision) {
        for (const s of systems) {
            if (!state.seenBy.has(s.id)) continue;
            const { sx, sy } = toScreen(s.x, s.y);
            const r = radiusFor(s) * 3.2;
            const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
            grad.addColorStop(0, 'rgba(34,211,238,0.30)');
            grad.addColorStop(1, 'rgba(34,211,238,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    for (const s of systems) {
        const { sx, sy } = toScreen(s.x, s.y);
        if (sx < -30 || sy < -30 || sx > w + 30 || sy > h + 30) continue;
        const r = radiusFor(s);
        const fill = fillFor(s);

        ctx.globalAlpha = 1;
        if (layers.stale && s.known) {
            const days = ageDays(s.lastSeen);
            // Fade towards invisible over a fortnight. Old intel should LOOK old.
            ctx.globalAlpha = days == null ? 0.35 : Math.max(0.28, 1 - Math.min(1, days / 14) * 0.72);
        }

        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        if (fill) {
            ctx.fillStyle = fill;
            ctx.fill();
        } else {
            ctx.strokeStyle = 'rgba(100,116,139,0.55)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        if (layers.free && s.free > 0) {
            ctx.strokeStyle = 'rgba(74,222,128,0.9)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sx, sy, r + 3, 0, Math.PI * 2);
            ctx.stroke();
        }

        if (s.sieged > 0) {
            ctx.strokeStyle = 'rgba(248,113,113,0.95)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sx, sy, r + 5.5, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.globalAlpha = 1;

        if (s.id === state.hoverId) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sx, sy, r + 8, 0, Math.PI * 2);
            ctx.stroke();
        }

        if (layers.labels && state.scale > 18) {
            ctx.fillStyle = 'rgba(226,232,240,0.75)';
            ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`${s.name || '?'} [${s.id}]`, sx, sy - r - 5);
        }
    }
}

function drawGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(148,163,184,0.07)';
    ctx.lineWidth = 1;
    const stepWorld = state.scale > 45 ? 1 : state.scale > 20 ? 2 : 5;
    const step = stepWorld * state.scale;
    if (step < 8) return;
    const startX = state.offsetX % step;
    const startY = state.offsetY % step;
    ctx.beginPath();
    for (let x = startX; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = startY; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
}

// ─── INTERACTION ─────────────────────────────────────────────────────────────

function systemAt(px, py) {
    let best = null, bestD = Infinity;
    for (const s of state.systems) {
        const { sx, sy } = toScreen(s.x, s.y);
        const d = Math.hypot(sx - px, sy - py);
        const hit = Math.max(10, radiusFor(s) + 6);
        if (d < hit && d < bestD) { best = s; bestD = d; }
    }
    return best;
}

function tooltipHtml(s) {
    const seers = state.seenBy.get(s.id) || [];
    const owners = s.owners.length
        ? s.owners.map(o => `${esc(o.tag)} ×${o.planets}`).join(', ')
        : (s.known ? 'nobody we know of' : '—');

    const lines = [
        `<div class="font-semibold text-foreground">${esc(s.name || 'Unnamed')} <span class="text-muted-foreground">[${s.id}]</span></div>`,
        `<div class="text-zinc-400">(${s.x} / ${s.y})</div>`,
    ];

    if (!s.known) {
        lines.push('<div class="mt-1 text-amber-400">Never scanned — we have its position and nothing else.</div>');
    } else {
        lines.push(`<div class="mt-1">Planets on record: <span class="text-foreground">${s.known}</span></div>`);
        lines.push(`<div>Held by: <span class="text-foreground">${owners}</span></div>`);
        if (s.free > 0) lines.push(`<div class="text-emerald-400">${s.free} free planet${s.free === 1 ? '' : 's'}</div>`);
        if (s.unaligned > 0) lines.push(`<div class="text-zinc-400">${s.unaligned} held by players with no known alliance</div>`);
        if (s.sieged > 0) lines.push(`<div class="text-red-400">${s.sieged} under siege</div>`);
        lines.push(`<div class="text-zinc-500">Intel ${esc(describeAge(ageDays(s.lastSeen)))}</div>`);
    }

    if (seers.length) {
        const shown = seers.slice(0, 3).map(o => `${esc(o.name)} (${o.radius}${o.measured ? '' : '*'}/${o.needed})`).join(', ');
        lines.push(`<div class="mt-1 text-sky-400">In vision of ${seers.length}: ${shown}${seers.length > 3 ? '…' : ''}</div>`);
        if (seers.some(o => !o.measured)) {
            lines.push('<div class="text-amber-500/90">* biology never scraped — science level used instead</div>');
        }
    } else if (state.layers.vision) {
        lines.push('<div class="mt-1 text-zinc-500">No member is modelled as seeing this.</div>');
    }

    return lines.join('');
}

function moveTooltip(px, py) {
    const tip = state.tooltip;
    const stage = state.stage;
    tip.style.left = `${Math.min(px + 14, stage.clientWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.min(py + 14, stage.clientHeight - tip.offsetHeight - 8)}px`;
}

function openSystem(systemId) {
    // Navigate the game frame the same way search does. Everything downstream — the
    // sidebar labels, loadPlans(), the out-of-vision synthetic page — is the existing
    // System Intel path, reached the existing way.
    const frame = document.getElementById('game-frame');
    if (frame) frame.src = `/Game/Map/SolarSystem/${systemId}`;
    document.getElementById('galaxy-map-panel')?.classList.replace('translate-x-0', 'translate-x-full');
}

// ─── DATA ────────────────────────────────────────────────────────────────────

function recomputeVision() {
    state.seenBy = state.layers.vision
        ? visionCoverage(state.observers, state.systems)
        : new Map();
}

// ─── ISOCHRONES ──────────────────────────────────────────────────────────────
// "How far does a fleet get from HERE in 12/24/48 hours?" — ring radii from the model's
// analytic inverse, and a band per system from the forward formula (planet 1 → 1, the
// branch the inverse is defined for). All of it standard round pace: the model has no
// pace multiplier, and the current RedZone round runs ×10 — the controls row says so.

function recomputeIsochrones() {
    state.isoOrigin = null;
    state.isoRings = [];
    state.isoBands = new Map();
    if (!state.layers.isochrones) return;

    const origin = state.systems.find(s => s.id === state.iso.origin);
    if (!origin) return;
    state.isoOrigin = origin;

    // Bands are cheapest sorted ascending; the inputs stay as typed, the maths does not
    // care which box a number came from.
    const hours = state.iso.hours.slice().sort((a, b) => a - b);
    const { energy, speed, alliance } = state.iso;

    state.isoRings = hours.map(h => ({
        hours: h,
        radius: isochroneRadius(h * 3600, energy, speed, alliance),
    }));

    for (const s of state.systems) {
        if (s.id === origin.id) continue;   // the origin gets a crosshair, not a band
        const t = calcTravelSeconds(origin.x, origin.y, 1, s.x, s.y, 1, energy, speed, alliance);
        const band = hours.findIndex(h => t <= h * 3600);
        if (band !== -1) state.isoBands.set(s.id, band);
    }
}

// Default origin: the member's own home system, resolved the only way the hub can —
// /hub-api/me's game name matched (case-insensitively) against the observers the map
// already loaded. A broken bridge just means no default; the member picks one by hand.
async function deriveHomeOrigin() {
    try {
        const res = await fetch('/hub-api/me');
        const me = await res.json();
        const name = me && me.gameName ? String(me.gameName).toLowerCase() : null;
        if (!name) return;
        const mine = state.observers.find(o => o.name && String(o.name).toLowerCase() === name);
        if (mine && mine.originSystemId != null && state.systems.some(s => s.id === mine.originSystemId)) {
            // In memory only: a derived default is not a choice, so it is not persisted.
            state.iso.origin = mine.originSystemId;
        }
    } catch (err) {
        console.warn('[GalaxyMap] Could not derive a home origin:', err.message);
    }
}

function reflectIsoControls() {
    const origin = state.systems.find(s => s.id === state.iso.origin);
    const input = document.getElementById('gm-iso-origin');
    if (input) input.value = origin ? `${origin.name || 'Sys'} #${origin.id}` : '';
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('gm-iso-energy', state.iso.energy);
    set('gm-iso-speed', state.iso.speed);
    set('gm-iso-t1', state.iso.hours[0]);
    set('gm-iso-t2', state.iso.hours[1]);
    set('gm-iso-t3', state.iso.hours[2]);
    const allied = document.getElementById('gm-iso-alliance');
    if (allied) allied.checked = !!state.iso.alliance;
}

function syncIsoControlsVisibility() {
    document.getElementById('gm-iso-controls')?.classList.toggle('hidden', !state.layers.isochrones);
}

// Origin picker over the systems the map has already loaded — no extra endpoint, same
// input-plus-dropdown shape as the travel calculator's system search.
function wireIsoOriginPicker() {
    const input = document.getElementById('gm-iso-origin');
    const drop = document.getElementById('gm-iso-origin-drop');
    if (!input || !drop) return;
    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { drop.classList.add('hidden'); return; }
        const matches = state.systems.filter(s =>
            (s.name && s.name.toLowerCase().includes(q)) || String(s.id).includes(q)).slice(0, 12);
        if (!matches.length) { drop.classList.add('hidden'); return; }
        drop.classList.remove('hidden');
        drop.innerHTML = matches.map(s =>
            `<button data-id="${s.id}" class="gm-iso-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${esc(s.name || 'Sys')} #${s.id}</span>
                <span class="text-zinc-500 ml-auto">${Number(s.x)}/${Number(s.y)}</span>
            </button>`).join('');
        drop.querySelectorAll('.gm-iso-pick').forEach(btn => btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            state.iso.origin = parseInt(btn.dataset.id, 10);
            drop.classList.add('hidden');
            reflectIsoControls();
            isoChanged();
        }));
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
}

function wireIsoInputs() {
    const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));
    document.getElementById('gm-iso-energy')?.addEventListener('input', (e) => {
        state.iso.energy = clampInt(e.target.value, 0, 100);
        isoChanged();
    });
    document.getElementById('gm-iso-speed')?.addEventListener('input', (e) => {
        state.iso.speed = clampInt(e.target.value, -4, 4);
        isoChanged();
    });
    document.getElementById('gm-iso-alliance')?.addEventListener('change', (e) => {
        state.iso.alliance = e.target.checked;
        isoChanged();
    });
    [['gm-iso-t1', 0], ['gm-iso-t2', 1], ['gm-iso-t3', 2]].forEach(([id, i]) => {
        document.getElementById(id)?.addEventListener('input', (e) => {
            const h = parseFloat(e.target.value);
            state.iso.hours[i] = Number.isFinite(h) && h > 0 ? h : DEFAULT_ISO.hours[i];
            isoChanged();
        });
    });
}

function isoChanged() {
    persistPrefs();
    recomputeIsochrones();
    renderLegend();
    draw();
}

function renderLegend() {
    const body = document.getElementById('gm-legend-body');
    if (!body) return;
    const dot = (colour, filled) => filled
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${colour};margin-right:6px"></span>`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;border:1px solid ${colour};margin-right:6px"></span>`;

    const tags = [...new Set(state.systems.map(s => s.top).filter(Boolean))]
        .sort((a, b) => (a === state.ownTag ? -1 : b === state.ownTag ? 1 : String(a).localeCompare(String(b))))
        .slice(0, 8);

    const rows = [
        `<div>${dot('rgba(100,116,139,0.55)', false)}never scanned</div>`,
        `<div>${dot('rgba(100,116,139,0.75)', true)}scanned, unheld</div>`,
    ];
    if (state.layers.territories) {
        for (const tag of tags) {
            const colour = tag === state.ownTag ? OWN_COLOUR : allianceColour(tag);
            rows.push(`<div>${dot(colour, true)}${esc(tag)}${tag === state.ownTag ? ' <span class="text-zinc-500">(us)</span>' : ''}</div>`);
        }
    }
    if (state.layers.free) rows.push(`<div>${dot('rgba(74,222,128,0.9)', false)}has free planets</div>`);
    rows.push(`<div>${dot('rgba(248,113,113,0.95)', false)}siege on record</div>`);
    if (state.layers.vision) {
        rows.push('<div class="mt-1 text-amber-500/90">Vision is modelled from biology, not read from the game.</div>');
    }
    if (state.layers.isochrones) {
        if (state.isoOrigin) {
            state.isoRings.forEach((ring, i) =>
                rows.push(`<div>${dot(ISO_BANDS[i].stroke, false)}reachable within ${ring.hours} h</div>`));
            rows.push('<div class="mt-1 text-amber-500/90">Standard-pace times — this RedZone round runs ×10.</div>');
        } else {
            rows.push('<div class="mt-1 text-amber-500/90">Isochrones: pick an origin system first.</div>');
        }
    }
    body.innerHTML = rows.join('');
}

function renderCoverage() {
    const el = document.getElementById('gm-coverage');
    if (!el || !state.coverage) return;
    const c = state.coverage;
    const never = c.systemsKnown - c.systemsScanned;
    const parts = [
        `${c.systemsKnown} systems mapped`,
        `${c.systemsScanned} scanned`,
        `${never} never visited`,
    ];
    if (state.layers.vision) {
        parts.push(`${c.observersPlaced}/${c.membersTracked} members placed`);
    }
    el.innerHTML = `${esc(parts.join(' · '))}`
        + (never > 0 ? ' <span class="text-amber-500/80">— hollow rings are gaps in our intel, not empty space</span>' : '');
}

async function loadData() {
    const status = document.getElementById('gm-status');
    if (status) { status.textContent = 'Loading the archive…'; status.classList.remove('hidden'); }
    try {
        const res = await fetch('/hub-api/intel/galaxy-map');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);

        state.systems = data.systems || [];
        state.observers = (data.observers || []).map(o => ({
            playerId: o.playerId,
            name: o.name,
            biology: o.biology,
            science_level: o.science_level,
            originSystemId: o.originSystemId,
            x: o.x,
            y: o.y,
        }));
        state.ownTag = data.ownTag;
        state.coverage = data.coverage;

        if (!state.systems.length) {
            if (status) {
                // Static markup only — nothing player-derived. The button is created here
                // rather than in the component, so it is wired by delegation (see init).
                status.innerHTML = 'The archive has no system coordinates yet.'
                    + '<button class="gm-seed-inline pointer-events-auto ml-2 h-7 px-2 rounded border border-input bg-zinc-950 text-xs text-foreground hover:bg-accent transition-colors">'
                    + '<i class="fa-solid fa-cloud-arrow-down mr-1"></i>Seed from API</button>';
            }
            return;
        }
        if (status) status.classList.add('hidden');

        if (state.iso.origin == null) await deriveHomeOrigin();
        recomputeVision();
        recomputeIsochrones();
        reflectIsoControls();
        fitToData();
        renderLegend();
        renderCoverage();
        draw();
    } catch (err) {
        console.error('[GalaxyMap] Load failed:', err);
        if (status) {
            status.classList.remove('hidden');
            status.textContent = `Could not load the archive: ${err.message}`;
        }
    }
}

// ─── SEED FROM THE GAME API ──────────────────────────────────────────────────
// One GET of the game's system index — through the member's own session and the shared
// 5/s gate, like every game-bound request — replaces the old requirement to open the
// in-game travel calculator once. The answer is filtered to systems that actually have
// coordinates and handed to the existing /hub-api/sync/galaxy receiver; the map then
// reloads from its own archive, the only surface it ever draws from.
let seeding = false;
async function seedFromApi() {
    if (seeding) return;   // a re-click mid-run would double-spend the request budget
    seeding = true;
    const button = document.getElementById('gm-seed-api');
    if (button) button.disabled = true;
    const status = document.getElementById('gm-status');
    const say = (msg) => { if (status) { status.classList.remove('hidden'); status.textContent = msg; } };
    try {
        say('Asking the game for the system index…');
        const res = await AWApi.getSolarSystems();
        if (!res.ok) {
            say(res.reason === 'session'
                ? 'Seeding needs your game session — log into the game first, then try again.'
                : `The game API did not answer (${res.reason}${res.status ? `, HTTP ${res.status}` : ''}).`);
            return;
        }
        // The ONE shared API->sync mapper (aw-api.js) — never a local copy of it.
        const { systems } = AWApi.mapSolarSystemsToSyncPayload(res.data);
        if (!systems.length) {
            say('The game returned no systems with coordinates — nothing to index.');
            return;
        }
        const sync = await fetch('/hub-api/sync/galaxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systems }),
        });
        const result = await sync.json().catch(() => ({}));
        if (!sync.ok || !result.success) {
            say(`The archive rejected the index: ${result.error || `HTTP ${sync.status}`}`);
            return;
        }
        if (typeof window.showToast === 'function') window.showToast(`Indexed ${systems.length} systems from the game API`);
        await loadData();
    } catch (err) {
        console.error('[GalaxyMap] Seed failed:', err);
        say(`Seeding failed: ${err.message}`);
    } finally {
        seeding = false;
        if (button) button.disabled = false;
    }
}

// Seeds planets in bulk from Map/sectors, one system at a time, through the EXISTING
// /hub-api/sync/system endpoint — same fog-of-war/owner-change/pop-drop logic a live scrape
// already goes through, just driven from a bulk API response instead of one page. A system
// the API marks isInVision:false gets every one of its planets marked is_unknown so the
// merge preserves whatever was last actually seen there, exactly like a DOM scraper would.
let seedingSectors = false;
const SECTOR_BOUNDS = { x1: -40, y1: -40, x2: 40, y2: 40 }; // known map bounds ~-32..32, padded

async function seedPlanetsFromSectors() {
    if (seedingSectors) return;
    seedingSectors = true;
    const button = document.getElementById('gm-seed-sectors');
    if (button) button.disabled = true;
    const status = document.getElementById('gm-status');
    const say = (msg) => { if (status) { status.classList.remove('hidden'); status.textContent = msg; } };
    try {
        say('Asking the game for the map sectors…');
        const res = await AWApi.getMapSectors(SECTOR_BOUNDS);
        if (!res.ok) {
            say(res.reason === 'session'
                ? 'Seeding needs your game session — log into the game first, then try again.'
                : `The game API did not answer (${res.reason}${res.status ? `, HTTP ${res.status}` : ''}).`);
            return;
        }
        const sectors = Array.isArray(res.data) ? res.data : [];
        const allSystems = sectors.flatMap(sec => Array.isArray(sec.solarSystems) ? sec.solarSystems : []);
        if (!allSystems.length) {
            say('The game returned no systems in that area — nothing to seed.');
            return;
        }

        let systemsProcessed = 0;
        let planetsProcessed = 0;
        const visionFlags = [];
        for (const sys of allSystems) {
            if (!sys || !Number.isInteger(sys.id)) continue;
            const isInVision = !!sys.isInVision;
            visionFlags.push({ id: sys.id, is_in_vision: isInVision });

            const planets = Array.isArray(sys.planets) ? sys.planets : [];
            const payload = AWApi.mapPlanetsToSyncPayload(sys.id, planets);
            if (!isInVision) {
                // Out-of-vision: the game's cache may be stale, so route every planet
                // through the SAME "unknown" guard a live scraper uses for fog of war.
                payload.planets = payload.planets.map(p => ({ ...p, is_unknown: true }));
            }
            if (!payload.planets.length) continue;
            // Bulk seeding hundreds of systems at once would otherwise flood Discord with
            // owner-change/pop-drop announcements; scan_mode: 'silent' still does every DB
            // write and history log, it just skips the announcement.
            payload.scan_mode = 'silent';

            const syncRes = await fetch('/hub-api/sync/system', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (syncRes.ok) {
                systemsProcessed++;
                planetsProcessed += payload.planets.length;
            }
            say(`Seeding planets… ${systemsProcessed}/${allSystems.length} systems (${planetsProcessed} planets)`);
        }

        if (visionFlags.length) {
            await fetch('/hub-api/sync/system-in-vision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ systems: visionFlags }),
            });
        }

        if (typeof window.showToast === 'function') {
            window.showToast(`Seeded ${planetsProcessed} planets across ${systemsProcessed} systems`);
        }
        await loadData();
    } catch (err) {
        console.error('[GalaxyMap] Sector seed failed:', err);
        say(`Sector seed failed: ${err.message}`);
    } finally {
        seedingSectors = false;
        if (button) button.disabled = false;
    }
}

// ─── SETUP ───────────────────────────────────────────────────────────────────

export async function initGalaxyMap(userId) {
    const canvas = document.getElementById('gm-canvas');
    const stage = document.getElementById('gm-stage');
    if (!canvas || !stage) return;

    // One prefs record per member: the gm-layer-* checkboxes plus, under `iso`, the
    // isochrone controls. The iso half is split off before the record becomes
    // state.layers so the checkbox loops below only ever see real layers.
    const prefs = loadPrefs(userId);
    const savedIso = prefs.iso;
    delete prefs.iso;

    state = {
        canvas,
        stage,
        ctx: canvas.getContext('2d'),
        tooltip: document.getElementById('gm-tooltip'),
        systems: [],
        observers: [],
        seenBy: new Map(),
        ownTag: null,
        coverage: null,
        layers: prefs,
        iso: sanitizeIso(savedIso),
        isoOrigin: null,
        isoRings: [],
        isoBands: new Map(),
        userId,
        scale: 20,
        offsetX: 0,
        offsetY: 0,
        hoverId: null,
    };

    for (const [key, on] of Object.entries(state.layers)) {
        const box = document.getElementById(`gm-layer-${key}`);
        if (box) box.checked = !!on;
    }

    for (const key of Object.keys(DEFAULT_LAYERS)) {
        document.getElementById(`gm-layer-${key}`)?.addEventListener('change', (e) => {
            state.layers[key] = e.target.checked;
            persistPrefs();
            if (key === 'vision') recomputeVision();
            if (key === 'isochrones') { syncIsoControlsVisibility(); recomputeIsochrones(); }
            renderLegend();
            renderCoverage();
            draw();
        });
    }

    syncIsoControlsVisibility();
    reflectIsoControls();
    wireIsoOriginPicker();
    wireIsoInputs();

    document.getElementById('gm-seed-api')?.addEventListener('click', seedFromApi);
    document.getElementById('gm-seed-sectors')?.addEventListener('click', seedPlanetsFromSectors);
    // The empty-state message offers the same seed. Its button only exists after
    // loadData() renders it, so the click is caught here by delegation instead of an id.
    document.getElementById('gm-status')?.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.gm-seed-inline')) seedFromApi();
    });

    document.getElementById('gm-zoom-in')?.addEventListener('click', () => zoomAt(1.3, canvas.clientWidth / 2, canvas.clientHeight / 2));
    document.getElementById('gm-zoom-out')?.addEventListener('click', () => zoomAt(1 / 1.3, canvas.clientWidth / 2, canvas.clientHeight / 2));
    document.getElementById('gm-reset')?.addEventListener('click', () => { fitToData(); draw(); });
    document.getElementById('gm-refresh')?.addEventListener('click', loadData);
    document.getElementById('close-galaxy-map-btn')?.addEventListener('click', () => {
        document.getElementById('galaxy-map-panel')?.classList.replace('translate-x-0', 'translate-x-full');
    });

    // --- pan / zoom / hover ---
    let dragging = false, dragMoved = false, lastX = 0, lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        dragMoved = false;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;

        if (dragging) {
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
            state.offsetX += dx;
            state.offsetY += dy;
            lastX = e.clientX;
            lastY = e.clientY;
            draw();
            return;
        }

        const hit = systemAt(px, py);
        const nextId = hit ? hit.id : null;
        if (nextId !== state.hoverId) {
            state.hoverId = nextId;
            draw();
        }
        const tip = state.tooltip;
        if (hit && tip) {
            tip.innerHTML = tooltipHtml(hit);
            tip.classList.remove('hidden');
            moveTooltip(px, py);
        } else if (tip) {
            tip.classList.add('hidden');
        }
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        canvas.style.cursor = 'grab';
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    };
    canvas.addEventListener('pointerup', (e) => {
        const wasDrag = dragMoved;
        endDrag(e);
        if (wasDrag) return;
        const rect = canvas.getBoundingClientRect();
        const hit = systemAt(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) openSystem(hit.id);
    });
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', () => { state.tooltip?.classList.add('hidden'); });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    // Pinch on touch devices.
    let pinchStart = null;
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        pinchStart = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 2 || !pinchStart) return;
        e.preventDefault();
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const rect = canvas.getBoundingClientRect();
        zoomAt(d / pinchStart, (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
                               (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top);
        pinchStart = d;
    }, { passive: false });
    canvas.addEventListener('touchend', () => { pinchStart = null; }, { passive: true });

    const observer = new ResizeObserver(() => { if (state.systems.length) draw(); });
    observer.observe(stage);

    await loadData();
}

export async function openGalaxyMapPanel(userId) {
    let panel = document.getElementById('galaxy-map-panel');
    if (!panel) {
        const res = await fetch('/hub-assets/components/galaxy-map.html');
        document.getElementById('dynamic-panels-container').insertAdjacentHTML('beforeend', await res.text());
        panel = document.getElementById('galaxy-map-panel');
        await initGalaxyMap(userId);
    }
    if (panel.classList.contains('translate-x-0')) return panel.classList.replace('translate-x-0', 'translate-x-full');

    document.querySelectorAll('#dynamic-panels-container > div[id$="-panel"]').forEach(p => {
        if (p.id !== 'galaxy-map-panel') p.classList.replace('translate-x-0', 'translate-x-full');
    });
    panel.classList.replace('translate-x-full', 'translate-x-0');
    // The canvas was sized while hidden; give it its real size now.
    if (state && state.systems.length) { fitToData(); draw(); }
    if (document.getElementById('sidebar')?.classList.contains('expanded') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
}

// Exposed for the tests, which check the pure pieces without a DOM.
export const __internals = { allianceColour, ageDays, describeAge, DEFAULT_LAYERS, OWN_COLOUR, DEFAULT_ISO, sanitizeIso };
