// News-page battle/conquest completeness scraper.
// Runs inside the proxied game page (same origin as the hub) whenever a member visits
// their own /Game/News feed. Captures the two kinds of event that NEVER produce a
// battle_reports row — an undefended-planet conquest, and bombardment of a planet with no
// defending fleet — and POSTs them to the hub so the population leaderboard and future
// conquest announcements stay complete. See docs/superpowers/specs/2026-08-30-battle-
// challenge-tracker-design.md section 3 for the full design.
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const MAX_PAGES_PER_VISIT = 20;
const NEWS_TYPES = ['battle-conquer', 'battle-conquered', 'battle-bombarded'];

function idFromHref(href) {
    if (!href) return null;
    const n = parseInt(href.split('/').pop(), 10);
    return Number.isInteger(n) ? n : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "20:54:00 - Aug 24" -> an ISO timestamp. The News page never includes a year, so this
// resolves against `now`'s year, rolling back one year if that would land in the future
// (the feed only ever shows events that already happened).
function parseNewsTimestamp(rawText, now) {
    const m = rawText.trim().match(/(\d{2}):(\d{2}):(\d{2})\s*-\s*(\w{3})\s+(\d{1,2})/);
    if (!m) return null;
    const [, hh, mm, ss, monStr, day] = m;
    const month = MONTHS.indexOf(monStr);
    if (month === -1) return null;
    const year = now.getFullYear();
    let candidate = new Date(year, month, parseInt(day, 10), parseInt(hh, 10), parseInt(mm, 10), parseInt(ss, 10));
    if (candidate.getTime() > now.getTime() + 60000) {
        candidate = new Date(year - 1, month, parseInt(day, 10), parseInt(hh, 10), parseInt(mm, 10), parseInt(ss, 10));
    }
    return candidate.toISOString();
}

function bodyDivFor(tr) {
    return tr.querySelector('td.black.text-left div, td.text-left div');
}

function parseConquestRow(tr) {
    const div = bodyDivFor(tr);
    if (!div) return null;
    const sysLink = div.querySelector('a[href*="/SolarSystem/"]');
    const planetLink = div.querySelector('a[href*="/Planets/Planet/"]');
    return {
        game_planet_id: idFromHref(planetLink && planetLink.getAttribute('href')),
        system_id: idFromHref(sysLink && sysLink.getAttribute('href')),
        other_player_id: null,
        population_delta: null,
        direction: null,
    };
}

// Wording for the "you were the attacker" case is not yet confirmed against a real
// example (see the design spec) — this deliberately keys off "killed"/"lost" next to
// "population" rather than one exact sentence, so it survives that uncertainty.
function parseBombardmentRow(tr) {
    const div = bodyDivFor(tr);
    if (!div) return null;
    const text = div.innerText || div.textContent || '';
    const popMatch = text.match(/(killed|lost)\s+([\d,.\s]+)\s+population/i);
    if (!popMatch) return null;

    const sysLink = div.querySelector('a[href*="/SolarSystem/"]');
    const planetLink = div.querySelector('a[href*="/Planets/Planet/"]');
    const profileLink = div.querySelector('a[href*="/Players/Profile/"]');

    return {
        game_planet_id: idFromHref(planetLink && planetLink.getAttribute('href')),
        system_id: idFromHref(sysLink && sysLink.getAttribute('href')),
        other_player_id: idFromHref(profileLink && profileLink.getAttribute('href')),
        population_delta: parseInt(popMatch[2].replace(/[,.\s]/g, ''), 10) || 0,
        direction: popMatch[1].toLowerCase() === 'killed' ? 'killed' : 'lost',
    };
}

// Rows are newest-first on each page (standard for this feed), so the LAST entry
// collected here is the oldest on the page — used by the caller to decide whether to
// walk to the next page.
function collectEntriesFromDoc(doc, now) {
    const entries = [];
    doc.querySelectorAll('tr').forEach(tr => {
        const msgCell = tr.querySelector(NEWS_TYPES.map(t => `td.msg.${t}`).join(', '));
        if (!msgCell || tr.getAttribute('data-aw-newsbattle') === '1') return;

        const type = NEWS_TYPES.find(t => msgCell.classList.contains(t));
        const timeText = (msgCell.textContent || '').trim().split('\n')[0].trim();
        const occurred_at = parseNewsTimestamp(timeText, now);
        if (!occurred_at) return;

        const parsed = type === 'battle-bombarded' ? parseBombardmentRow(tr) : parseConquestRow(tr);
        if (!parsed) return;

        tr.setAttribute('data-aw-newsbattle', '1');
        entries.push({ message_type: type, occurred_at, ...parsed });
    });
    return entries;
}

async function postEntries(entries) {
    if (!entries.length) return true;
    try {
        const res = await fetch('/hub-api/sync/news', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
        });
        return res.ok;
    } catch (err) {
        return false;
    }
}

async function fetchWatermark() {
    try {
        const res = await fetch('/hub-api/sync/news-watermark');
        if (!res.ok) return null;
        return (await res.json()).watermark;
    } catch (err) {
        return null;
    }
}

async function walkFromPage(doc, pageNumber, watermark, now) {
    const entries = collectEntriesFromDoc(doc, now);
    const posted = await postEntries(entries);
    if (!posted) return; // best-effort: retried on the member's next visit

    const oldestOnPage = entries.length ? entries[entries.length - 1].occurred_at : null;
    const caughtUp = watermark && oldestOnPage && oldestOnPage <= watermark;
    if (caughtUp || pageNumber >= MAX_PAGES_PER_VISIT) return;

    const nextLink = doc.querySelector(`a[href*="pageNumber=${pageNumber + 1}"]`);
    if (!nextLink) return;

    let nextDoc;
    try {
        const res = await gameFetch(nextLink.getAttribute('href'));
        const html = await res.text();
        nextDoc = new DOMParser().parseFromString(html, 'text/html');
    } catch (err) {
        return;
    }

    await walkFromPage(nextDoc, pageNumber + 1, watermark, now);
}

export async function initNewsBattleEvents() {
    if (!window.location.pathname.toLowerCase().startsWith('/game/news')) return;

    const watermark = await fetchWatermark();
    await walkFromPage(document, 1, watermark, new Date());
}
