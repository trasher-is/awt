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

const { coverage: visionCoverage, visionRadius } = globalThis.AWVision;

const PREFS_KEY = 'awt.galaxyMap.layers.v1';

const DEFAULT_LAYERS = {
    territories: true,
    vision: false,
    free: false,
    stale: false,
    labels: false,
};

// Colour for an alliance tag. The game's own API exposes Alliance.color, but we have no
// access to it (issue #24), so this derives a stable hue from the tag: the same alliance
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
            x: o.x,
            y: o.y,
        }));
        state.ownTag = data.ownTag;
        state.coverage = data.coverage;

        if (!state.systems.length) {
            if (status) status.textContent = 'The archive has no system coordinates yet. Open the travel calculator in game once to index the galaxy.';
            return;
        }
        if (status) status.classList.add('hidden');

        recomputeVision();
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

// ─── SETUP ───────────────────────────────────────────────────────────────────

export async function initGalaxyMap(userId) {
    const canvas = document.getElementById('gm-canvas');
    const stage = document.getElementById('gm-stage');
    if (!canvas || !stage) return;

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
        layers: loadPrefs(userId),
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
            savePrefs(state.userId, state.layers);
            if (key === 'vision') recomputeVision();
            renderLegend();
            renderCoverage();
            draw();
        });
    }

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
export const __internals = { allianceColour, ageDays, describeAge, DEFAULT_LAYERS, OWN_COLOUR };
