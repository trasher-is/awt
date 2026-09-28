import '../utils/unicorn-mode.js';
import '../utils/sqlite-time.js';
import { renderUnicornMarkers, clearUnicornMarkers, isUnicornMutation } from '../core/unicorn-markers.js';

const { createStore, createWordDetector } = globalThis.AWUnicornMode;
const { parseTimestamp } = globalThis.AWSqliteTime;
const initialized = new WeakMap();
const REFRESH_MS = 5 * 60 * 1000;

export function summarizeUnicornData(data, now = Date.now()) {
    const total = Number(data?.total) || 0;
    if (!total) return 'Best Planets has not been synced yet. Building leaders unavailable.';
    const mapped = Number(data.mapped) || 0;
    const stamp = parseTimestamp(data.synced_at);
    const age = stamp ? Math.max(0, now - stamp.getTime()) : null;
    const ageLabel = age === null ? 'sync time unknown'
        : age < 60000 ? 'synced just now'
            : age < 3600000 ? `synced ${Math.floor(age / 60000)}m ago`
                : `synced ${Math.floor(age / 3600000)}h ago`;
    const freshness = age !== null && age > 26 * 3600000 ? `stale: ${ageLabel}` : ageLabel;
    const leaderKinds = new Set((data.leaders || []).map(leader => leader.kind));
    const leaders = data.leaders_status === 'complete' ? '4 building leaders identified'
        : leaderKinds.size ? `${leaderKinds.size}/4 building leaders; incomplete building data`
            : data.leaders_status === 'incomplete' ? 'building leaders unavailable: incomplete data'
                : 'building leaders unavailable';
    const coverage = total < 50 ? `Partial ranking: ${total}/50 entries · ${mapped}/${total} located`
        : `${mapped}/${total} ranked planets located`;
    return `${coverage} · ${freshness} · ${leaders}.`;
}

// One owner for the whole tab, even when storage is blocked. The frame is same-origin;
// attaching on every load also removes listeners and markers from the old document.
export function initUnicornMode(host = window) {
    if (initialized.has(host)) return initialized.get(host);
    const doc = host.document;
    const frame = doc.getElementById('game-frame');
    const store = createStore(host);
    const detector = createWordDetector();
    let frameDocument = null;
    let observer = null;
    let renderTimer = null;
    let refreshTimer = null;
    let control = null;
    let snapshot = null;
    let errorMessage = '';
    let generation = 0;
    let inFlight = false;
    let wasActive = false;
    let disposed = false;
    let lastAttempt = 0;

    const render = () => {
        renderTimer = null;
        if (!frameDocument) return;
        if (store.getState().active && snapshot) renderUnicornMarkers(frameDocument, snapshot);
        else clearUnicornMarkers(frameDocument);
    };
    const scheduleRender = () => {
        if (!store.getState().active || renderTimer !== null) return;
        renderTimer = host.setTimeout(render, 100);
    };
    const updateStatus = state => {
        if (!state.active) { control?.remove(); control = null; return; }
        if (!control) {
            control = doc.createElement('aside');
            control.className = 'awt-unicorn-control';
            control.setAttribute('aria-label', 'Unicorn ranking mode');
            const top = doc.createElement('div');
            top.className = 'awt-unicorn-control-top';
            const label = doc.createElement('span');
            label.className = 'awt-unicorn-countdown';
            top.appendChild(label);
            const button = doc.createElement('button');
            button.type = 'button';
            button.textContent = 'Unicorn OFF';
            button.className = 'awt-unicorn-off';
            button.addEventListener('click', () => store.deactivate());
            top.appendChild(button);
            control.appendChild(top);
            const status = doc.createElement('p');
            status.className = 'awt-unicorn-status';
            status.setAttribute('role', 'status');
            control.appendChild(status);
            doc.body.appendChild(control);
        }
        control.querySelector('.awt-unicorn-countdown').textContent = `🦄 ${state.minutesLeft} min`;
        const description = snapshot ? summarizeUnicornData(snapshot) : 'Loading the Best Planets snapshot…';
        control.querySelector('.awt-unicorn-status').textContent = errorMessage
            ? `${errorMessage}${snapshot ? ` ${description}` : ''}` : description;
        control.title = 'Best Planets is a daily ranking. Building leaders are selected within its Top 50; ties use the better rank.';
    };
    const refreshSnapshot = async () => {
        if (disposed || !store.getState().active || inFlight) return;
        inFlight = true;
        lastAttempt = Date.now();
        const requestGeneration = generation;
        try {
            const response = await host.fetch('/hub-api/intel/unicorn', { cache: 'no-store' });
            if (!response.ok) throw new Error('Could not read the hub ranking.');
            const data = await response.json();
            if (!data || data.success !== true) throw new Error('Could not read the hub ranking.');
            if (disposed || generation !== requestGeneration || !store.getState().active) return;
            snapshot = data;
            errorMessage = '';
            render();
        } catch (err) {
            if (disposed || generation !== requestGeneration) return;
            errorMessage = snapshot ? 'Refresh failed; showing the last snapshot.' : 'Ranking unavailable. Retrying in five minutes.';
        } finally {
            if (!disposed && generation === requestGeneration) {
                inFlight = false;
                updateStatus(store.getState());
            }
        }
    };
    const onKey = event => {
        if (detector.feed(event)) store.activate();
    };
    const attachFrame = () => {
        detector.reset();
        observer?.disconnect();
        host.clearTimeout(renderTimer);
        renderTimer = null;
        if (frameDocument) {
            frameDocument.removeEventListener('keydown', onKey);
            clearUnicornMarkers(frameDocument);
        }
        frameDocument = null;
        try {
            frameDocument = frame?.contentDocument || null;
            if (!frameDocument) return;
            frameDocument.addEventListener('keydown', onKey);
            observer = new host.MutationObserver(records => {
                if (records.some(record => !isUnicornMutation(record))) scheduleRender();
            });
            observer.observe(frameDocument.documentElement, { childList: true, subtree: true });
            store.refresh();
            render();
        } catch (err) { frameDocument = null; }
    };
    const onVisibility = () => {
        if (!doc.hidden && store.getState().active && Date.now() - lastAttempt >= REFRESH_MS) refreshSnapshot();
    };
    doc.addEventListener('keydown', onKey);
    frame?.addEventListener('load', attachFrame);
    doc.addEventListener('visibilitychange', onVisibility);
    attachFrame();
    const unsubscribe = store.subscribe(state => {
        updateStatus(state);
        if (state.active && !wasActive) {
            wasActive = true;
            refreshSnapshot();
            refreshTimer = host.setInterval(refreshSnapshot, REFRESH_MS);
        } else if (!state.active && wasActive) {
            wasActive = false;
            generation++;
            inFlight = false;
            snapshot = null;
            errorMessage = '';
            host.clearInterval(refreshTimer);
            refreshTimer = null;
            host.clearTimeout(renderTimer);
            renderTimer = null;
            render();
        }
    });

    const cleanup = () => {
        if (disposed) return;
        disposed = true;
        generation++;
        unsubscribe();
        store.dispose();
        observer?.disconnect();
        host.clearTimeout(renderTimer);
        host.clearInterval(refreshTimer);
        doc.removeEventListener('keydown', onKey);
        frame?.removeEventListener('load', attachFrame);
        doc.removeEventListener('visibilitychange', onVisibility);
        frameDocument?.removeEventListener('keydown', onKey);
        if (frameDocument) clearUnicornMarkers(frameDocument);
        control?.remove();
        initialized.delete(host);
    };
    initialized.set(host, cleanup);
    return cleanup;
}
