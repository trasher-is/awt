// News-page hostile-incoming enhancer.
// Runs inside the proxied game page (same origin as the hub), so it can fetch game
// profile pages directly AND POST to /hub-api with the session cookie.
//
// For each hostile incoming row (td.msg.player-incoming) it:
//   • shows a compact attacker stat line next to the attacker name
//     (race speed/att/def + physics/math/energy + player level), pulled from the hub DB
//   • adds a 🔄 button that re-scrapes the attacker's profile into the hub
//   • adds a 📣 button that sends/updates a Discord incoming alert for that fleet
import { extractPlayerData } from '../scrapers/player-parser.js';
import { runAllianceFleetScan } from '../scrapers/alliance-parser.js';

function toast(msg) {
    try {
        window.parent.postMessage({ type: 'SHOW_TOAST', payload: msg }, window.location.origin);
    } catch (e) { /* not embedded — ignore */ }
}

function getQueryParam(href, key) {
    const m = href.match(new RegExp('[?&]' + key + '=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : null;
}

function numFromText(text, re) {
    const m = text.match(re);
    return m ? parseInt(m[1].replace(/[,.\s]/g, ''), 10) : 0;
}

// Pull every piece of structured data we can out of one hostile incoming row.
function parseRow(div) {
    const text = div.innerText || '';

    const bcLink = div.querySelector('a[href*="BattleCalculator"]');
    if (!bcLink) return null; // no fleet id -> can't key a Discord alert
    const fleetId = parseInt(getQueryParam(bcLink.getAttribute('href'), 'attackingFleetId'), 10);
    if (!Number.isInteger(fleetId) || fleetId <= 0) return null;

    const profileLink = div.querySelector('a[href*="/Players/Profile/"]');
    if (!profileLink) return null; // attacker unknown
    const attackerId = parseInt(profileLink.getAttribute('href').split('/').pop(), 10);
    const attackerName = profileLink.innerText.trim();

    const tagLink = div.querySelector('a[href*="/Alliance/Profile/"]');
    const attackerTag = tagLink ? tagLink.innerText.trim() : null;

    const sysLink = div.querySelector('a[href*="/SolarSystem/"]');
    const systemId = sysLink ? parseInt(sysLink.getAttribute('href').split('/').pop(), 10) : null;

    const planetLink = div.querySelector('a[href*="/Planets/Planet/"]');
    let planetId = null, planetName = null, planetIndex = null;
    if (planetLink) {
        planetId = parseInt(planetLink.getAttribute('href').split('/').pop(), 10);
        planetName = planetLink.innerText.trim();
        const idxM = planetName.match(/#(\d+)/);
        if (idxM) planetIndex = parseInt(idxM[1], 10);
    }

    return {
        fleetId,
        attacker: { id: attackerId, name: attackerName, tag: attackerTag },
        target: { planetId, systemId, planetIndex, planetName },
        cv: numFromText(text, /\(([\d,]+)\s*CV\)/i),
        ships: {
            transports: numFromText(text, /([\d,]+)\s+Transport/i),
            colony: numFromText(text, /([\d,]+)\s+Colony/i),
            destroyers: numFromText(text, /([\d,]+)\s+Destroyer/i),
            cruisers: numFromText(text, /([\d,]+)\s+Cruiser/i),
            battleships: numFromText(text, /([\d,]+)\s+Battleship/i)
        },
        profileLink,
        bcLink
    };
}

// The News row prints the notification time in the VIEWER's local timezone, e.g.
// "11:00:00 - birž. 27" (Lithuanian). We parse it back as a local Date (the browser
// that rendered it shares that timezone) and return a UTC unix timestamp, so Discord's
// <t:unix> code can re-localize it correctly for every reader.
function parseNewsTimeToUnix(timeText) {
    if (!timeText) return 0;
    const tm = timeText.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!tm) return 0;
    const dm = timeText.match(/(\d{1,2})\s*$/); // trailing day-of-month
    const now = new Date();
    const day = dm ? parseInt(dm[1], 10) : now.getDate();
    let d = new Date(now.getFullYear(), now.getMonth(), day, +tm[1], +tm[2], +tm[3]);
    // News is never meaningfully in the future — if it looks ahead, it's last month.
    if (d.getTime() - now.getTime() > 36 * 3600 * 1000) {
        d = new Date(now.getFullYear(), now.getMonth() - 1, day, +tm[1], +tm[2], +tm[3]);
    }
    return Math.floor(d.getTime() / 1000);
}

function renderStat(span, stats) {
    if (!span) return;
    if (stats && stats.statLine) {
        span.textContent = ' ' + stats.statLine;
        span.style.opacity = stats.has_intel ? '1' : '0.7';
    } else {
        span.textContent = ' (no data — refresh)';
        span.style.opacity = '0.7';
    }
}

async function fetchStats(ids) {
    if (!ids.length) return {};
    try {
        const res = await fetch('/hub-api/incoming/stats?ids=' + ids.join(','));
        const data = await res.json();
        return data.success ? data.stats : {};
    } catch (e) {
        return {};
    }
}

async function refreshAttacker(info, span, btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '⏳';
    try {
        // 1. Re-scrape the attacker's profile for fresh race/science/level intel.
        toast(`Scanning ${info.attacker.name}...`);
        const resp = await fetch(`/Game/Players/Profile/${info.attacker.id}`);
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const p = extractPlayerData(info.attacker.id, doc);
        await fetch('/hub-api/sync/player', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p)
        });
        const stats = await fetchStats([info.attacker.id]);
        renderStat(span, stats[info.attacker.id]);

        // 2. Refresh all alliance fleet positions so the Discord defender analysis is live.
        toast('Refreshing alliance fleets...');
        const n = await runAllianceFleetScan();
        toast(`${info.attacker.name} intel + ${n} members' fleets updated`);
    } catch (err) {
        console.error('[News] attacker refresh failed:', err);
        toast('Refresh failed');
    } finally {
        btn.disabled = false;
        btn.textContent = old;
    }
}

async function announce(info, arrivalUnix, btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '⏳';
    try {
        const resp = await fetch('/hub-api/incoming/announce', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fleetId: info.fleetId,
                attacker: info.attacker,
                target: info.target,
                cv: info.cv,
                ships: info.ships,
                arrivalUnix: arrivalUnix || 0
            })
        });
        const data = await resp.json();
        if (data.success) toast(data.edited ? 'Discord alert updated' : 'Discord alert sent');
        else toast('Discord: ' + (data.error || 'failed'));
    } catch (err) {
        console.error('[News] announce failed:', err);
        toast('Discord announce failed');
    } finally {
        btn.disabled = false;
        btn.textContent = old;
    }
}

function makeBtn(label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'margin-left:6px;padding:1px 7px;font-size:0.85em;line-height:1.4;cursor:pointer;border:1px solid #475569;border-radius:4px;background:#1e293b;color:#e2e8f0;';
    return b;
}

export function initNewsIncomingTools() {
    if (!window.location.pathname.toLowerCase().startsWith('/game/news')) return;

    const rows = document.querySelectorAll('td.msg.player-incoming');
    if (!rows.length) return;

    const pending = []; // { id, span } for batch stat fetch this pass

    rows.forEach((msgCell) => {
        const tr = msgCell.closest('tr');
        if (!tr || tr.getAttribute('data-aw-incoming') === '1') return;

        const bodyCell = tr.querySelector('td.black, td.text-left') || msgCell.nextElementSibling;
        const div = bodyCell ? bodyCell.querySelector('div') : null;
        if (!div) return;

        const info = parseRow(div);
        if (!info) return;

        tr.setAttribute('data-aw-incoming', '1');

        // Inline stat span after the sentence's closing dot, then push "Battle Calculator"
        // onto its own line below it.
        const span = document.createElement('span');
        span.className = 'aw-atk-stats';
        span.style.cssText = 'font-weight:bold;color:#dc3545;white-space:nowrap;';
        span.textContent = ' …';
        info.bcLink.insertAdjacentElement('beforebegin', span);
        info.bcLink.insertAdjacentElement('beforebegin', document.createElement('br'));

        // Notification time from the first line of the timestamp cell -> Discord unix code.
        const timeText = (msgCell.innerText || '').split('\n')[0].trim();
        const arrivalUnix = parseNewsTimeToUnix(timeText);

        // Action buttons.
        const bar = document.createElement('span');
        bar.style.cssText = 'display:inline-block;margin-left:4px;white-space:nowrap;';
        const refreshBtn = makeBtn('🔄', 'Re-scan attacker profile into the hub');
        const discordBtn = makeBtn('📣', 'Send / update Discord incoming alert');
        refreshBtn.addEventListener('click', () => refreshAttacker(info, span, refreshBtn));
        discordBtn.addEventListener('click', () => announce(info, arrivalUnix, discordBtn));
        bar.appendChild(refreshBtn);
        bar.appendChild(discordBtn);
        div.appendChild(bar);

        if (info.attacker.id) pending.push({ id: info.attacker.id, span });
    });

    if (pending.length) {
        fetchStats(pending.map((p) => p.id)).then((stats) => {
            pending.forEach((p) => renderStat(p.span, stats[p.id]));
        });
    }
}
