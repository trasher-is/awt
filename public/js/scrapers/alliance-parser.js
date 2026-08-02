import { parseArrivalToISO } from '../utils/fleet-time.js';
import '../utils/scrape-report.js';
import '../utils/parse-number.js';
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const { ScrapeReport, LABELS, labelledValue, headerIndex, matchesLabel } = globalThis.AWScrape;
const { parseLocaleInt } = globalThis.AWNumber;

export async function scrapeAlliance() {
    console.log(`[Spy] Initiating scrape for Alliance profile...`);

    const p = {
        id: null,
        name: null,
        tag: null,
        leader_id: null,
        ranking: null,
        points: null,
        members: []
    };

    // 1. Extract the true Alliance ID from the Ranking link
    const rankLink = document.querySelector('a[href*="/Ranking/Alliance?allianceId="]');
    if (rankLink) {
        const match = rankLink.getAttribute('href').match(/allianceId=(\d+)/i);
        if (match) p.id = parseInt(match[1], 10);
    }

    if (!p.id) {
        console.warn("[Spy] Could not extract Alliance ID. Aborting scrape.");
        return;
    }

    // 2. Parse the Alliance Profile Table
    const report = new ScrapeReport('alliance profile');
    const field = (which, synonyms, opts) => {
        const hit = labelledValue(document, synonyms, opts);
        report.label(hit.found, which);
        return hit;
    };

    p.name = field('name', LABELS.name).value || null;
    p.tag = field('tag', LABELS.tag).value || null;

    const pointsHit = field('points', LABELS.points, { exact: false });
    if (pointsHit.found) p.points = parseLocaleInt(pointsHit.value.split('(')[0]);

    const rankHit = field('ranking', LABELS.ranking);
    if (rankHit.found) p.ranking = parseLocaleInt(rankHit.value) || null;

    // The leader id comes from the profile link, not the visible text — an href survives
    // translation, a name does not.
    const leaderHit = field('leader', LABELS.leader);
    const leaderLink = leaderHit.cell && leaderHit.cell.querySelector ? leaderHit.cell.querySelector('a') : null;
    if (leaderLink) p.leader_id = parseInt(leaderLink.getAttribute('href').split('/').pop(), 10);

    // 3. Rip the entire Member roster cleanly from the roster tracking buttons
    // Since rows contain 2 members horizontally, we target the distinct member buttons directly.
    document.querySelectorAll('a[href*="/Game/Alliance/Member/"]').forEach(btn => {
        report.tryRow(() => {
            const mId = parseInt(btn.getAttribute('href').split('/').pop(), 10);

            // Find the matching profile link on the page using the ID to steal the name string
            const playerProfileLink = document.querySelector(`a[href^="/Game/Players/Profile/${mId}"]`);
            if (!playerProfileLink) {
                report.problem('member button without a matching profile link', `member ${mId}`);
                return false;
            }
            const mName = playerProfileLink.innerText.trim();

            // Prevent duplicate mutations
            if (!p.members.find(m => m.id === mId)) {
                p.members.push({ id: mId, name: mName });
            }
            return true;
        }, 'member link');
    });

    // A roster page with member buttons but no parsed members is a broken scrape, not an
    // empty alliance — do not overwrite the stored roster with nothing.
    if (report.emptyFromNonEmpty) {
        report.finish();
        console.error('[Spy] Alliance roster parsed 0 of', report.rowsSeen, 'member links — not syncing.');
        return;
    }

    // 4. Beam to backend
    try {
        const response = await fetch('/hub-api/sync/alliance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p)
        });
        if (response.ok) {
            report.finish();
            console.log(`[Spy] Alliance '${p.tag}' synced! (${p.members.length} members mapped)`);
            
            // Toast notification removed from here
            
            const header = document.querySelector('h5 span');
            if (header && !header.querySelector('.aw-synced')) {
                header.innerHTML += ' <span class="badge bg-success ms-2 aw-synced" style="font-size: 0.6em; vertical-align: middle; background-color: #22c55e !important; color: #fff;"><i class="bi bi-cloud-check"></i> Alliance Synced</span>';
            }
        }
    } catch (err) {
        console.error(`[Spy] Alliance API request failed`, err);
    }
}

// Extract every fleet from a member's alliance planet table. Two row shapes carry ships:
//   • Stationed (14 cells): SID,Name,Pop | Frm,Fac,Cyb,Lab,SB | TR,CS,DS,CR,BS,CV
//   • In-flight (11 cells): the 4 building cols are replaced by one colspan=4 cell holding
//     the landing time ("00:59:46 - birž. 28"); the fleet lands at this planet then.
// In BOTH shapes the ship columns are the LAST SIX cells [TR,CS,DS,CR,BS,CV]. Reading
// from the end survives a column inserted on the LEFT, but not one inserted among or
// after the ship columns — and nothing would notice. So we now ask the table's own header
// row where each ship column is, and only fall back to counting from the end when the
// header is absent. A PARTIAL header match is treated as no match: mixing two addressing
// schemes is how you get plausible numbers in the wrong fields.
//
// Siege rows (class *-siege, e.g. "friendly-siege"/"enemy-siege") are OTHER players'
// fleets parked on the planet — never the member's own — so we skip them.
const SHIP_COLUMNS = [
    { key: 'transports',   synonyms: ['tr', 'transports', 'transport'] },
    { key: 'colony_ships', synonyms: ['cs', 'colony ships', 'colony'] },
    { key: 'destroyers',   synonyms: ['ds', 'destroyers', 'destroyer'] },
    { key: 'cruisers',     synonyms: ['cr', 'cruisers', 'cruiser'] },
    { key: 'battleships',  synonyms: ['bs', 'battleships', 'battleship'] },
];

function extractMemberFleets(doc, playerId, report) {
    const fleets = [];
    const rows = doc.querySelectorAll('tr[data-planet-id]');
    if (!rows.length) return fleets;

    const table = rows[0].closest ? rows[0].closest('table') : null;
    const byHeader = {};
    let headerHits = 0;
    for (const col of SHIP_COLUMNS) {
        const idx = headerIndex(table, col.synonyms);
        byHeader[col.key] = idx;
        if (idx >= 0) headerHits++;
    }
    const useHeader = headerHits === SHIP_COLUMNS.length;
    if (!useHeader && headerHits > 0) {
        report.problem('fleet header only partially matched — using positional fallback',
                       `${headerHits}/${SHIP_COLUMNS.length} columns`);
    }

    rows.forEach(row => {
        if (/siege/i.test(row.className)) return;

        report.tryRow(() => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 11) { report.problem('fleet row too short', `${cells.length} cells`); return false; }

        const sysLink = row.querySelector('a[href*="/Game/Map/SolarSystem/"]');
        if (!sysLink) { report.problem('fleet row without a SolarSystem link', ''); return false; }
        const m = sysLink.getAttribute('href').match(/\/SolarSystem\/(\d+)\/(\d+)/);
        if (!m) { report.problem('unparseable SolarSystem href', sysLink.getAttribute('href')); return false; }

        const n = (cell) => (cell ? parseLocaleInt(cell.innerText) : 0);
        const last = cells.length;
        const ships = {};
        SHIP_COLUMNS.forEach((col, i) => {
            const idx = useHeader ? byHeader[col.key] : last - 6 + i;
            ships[col.key] = n(cells[idx]);
        });

        // An empty planet is not a parse failure — count it as parsed and move on.
        if (SHIP_COLUMNS.reduce((s, c) => s + ships[c.key], 0) === 0) return true;

        // In-flight rows carry a landing time in a colspan'd cell -> set arrival_at so the
        // server treats it as "lands later, then can relaunch".
        let arrival_at = null;
        const timerCell = Array.from(cells).find(c => c.getAttribute('colspan') === '4');
        if (timerCell) arrival_at = parseArrivalToISO(timerCell.innerText.trim());

        fleets.push({
            system_id: parseInt(m[1], 10),
            planet_index: parseInt(m[2], 10),
            ...ships,
            arrival_at
        });
        return true;
        }, 'fleet row');
    });
    return fleets;
}

// Fetch + parse one member's alliance page and sync stats + stationed fleets.
async function syncMember(url) {
    const idMatch = url.match(/\/Member\/(\d+)/);
    if (!idMatch) return { ok: false, report: null };
    const playerId = parseInt(idMatch[1], 10);
    const report = new ScrapeReport(`member ${playerId}`);

    const res = await gameFetch(url);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tds = Array.from(doc.querySelectorAll('td'));

    // Parse Username
    const profileLink = doc.querySelector('a[href*="/Game/Players/Profile/"]');
    if (!profileLink) {
        report.problem('member page without a profile link', url);
        report.finish();
        return { ok: false, report };
    }
    const name = profileLink.innerText.trim();
    {

            // Planets & Next Culture. The old lookup matched the literal markup
            // 'Planets<br>(Next Culture)', which breaks on any translation AND on the
            // game emitting '<br/>' instead of '<br>'. The countdown span carries an id,
            // which is markup the game controls and translation cannot touch — so find
            // the value cell from the span and read the label cell from there.
            let planetsText = '';
            let nextCultureSeconds = null;
            const cultureSpan = doc.querySelector('#nextCulture');
            const valTd = cultureSpan && cultureSpan.closest ? cultureSpan.closest('td') : null;
            if (valTd) {
                planetsText = valTd.innerText.split('(')[0].trim();
                nextCultureSeconds = parseInt(cultureSpan.getAttribute('data-value'), 10);
                if (isNaN(nextCultureSeconds)) nextCultureSeconds = null;
            }
            report.label(!!valTd, 'planets / next culture');

            const grab = (which, synonyms, opts = {}) => {
                const hit = labelledValue(doc, synonyms, opts);
                report.label(hit.found, which);
                return hit.found ? hit.value : '';
            };
            // Rates read as "1 234 /h" — keep only the leading number.
            const grabRate = (which, synonyms) => (grab(which, synonyms).split(' ')[0] || '');

            const pLevelTd = tds.find(t => matchesLabel(t.innerText, LABELS.playerLevel) && t.querySelector('a[data-href*="PlayerLevelTable"]'));
            const cvLimitHit = labelledValue(doc, LABELS.cvLimit, { exact: false });
            report.label(!!pLevelTd, 'player level');
            report.label(cvLimitHit.found, 'cv limit');

            const payload = {
                player_id: playerId,
                name,
                planets_text: planetsText,
                next_culture_seconds: nextCultureSeconds,
                science_rate: grabRate('science rate', LABELS.scienceRate),
                culture_rate: grabRate('culture rate', LABELS.cultureRate),
                production_rate: grabRate('production rate', LABELS.productionRate),
                astro_dollars: grab('astro dollars', LABELS.astroDollars),
                production_points: grab('production points', LABELS.productionPoints),
                artefact: grab('artefact', LABELS.artefact),
                level_text: pLevelTd && pLevelTd.nextElementSibling ? pLevelTd.nextElementSibling.innerText.trim().replace(/\s+/g, ' ') : '',
                cv_limit_text: cvLimitHit.value.replace(/\s+/g, ' '),
                economy: parseLocaleInt(grab('economy', LABELS.economy, { accept: v => !v.includes('%') })),
                energy: parseLocaleInt(grab('energy', LABELS.energy)),
                mathematics: parseLocaleInt(grab('mathematics', LABELS.mathematics)),
                physics: parseLocaleInt(grab('physics', LABELS.physics)),
                population: parseLocaleInt(grab('population', LABELS.population)),
                fleets: extractMemberFleets(doc, playerId, report)
            };

            // A member page where most labels went unmatched is a locale mismatch, not an
            // empty member. Syncing it would overwrite good stats with zeros.
            if (report.likelyWrongLanguage) {
                report.finish();
                return { ok: false, report };
            }

            await fetch('/hub-api/sync/alliance-stats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return { ok: true, report };
    }
}

// Collect the member links from a document (alliance overview page).
function memberLinksFrom(doc) {
    const seen = new Set();
    const urls = [];
    doc.querySelectorAll('a[href*="/Game/Alliance/Member/"]').forEach(a => {
        const href = a.getAttribute('href');
        const m = href.match(/\/Member\/(\d+)/);
        if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            urls.push(new URL(href, window.location.origin).href);
        }
    });
    return urls;
}

// On-page scan: runs while sitting on the alliance overview.
export async function scrapeAllianceMembers() {
    if (!window.location.pathname.toLowerCase().includes('/game/alliance')) return;

    // Stop parser if navigating tabs (list, naps, specific detail screens)
    if (window.location.pathname.toLowerCase().includes('/member/') ||
        window.location.pathname.toLowerCase().includes('/list') ||
        window.location.pathname.toLowerCase().includes('/naps')) return;

    const urls = memberLinksFrom(document);
    if (urls.length === 0) return;

    console.log(`[AWT Scraper] Found ${urls.length} alliance members. Syncing stats + fleets in background...`);
    const roster = new ScrapeReport('alliance member scan');
    for (const url of urls) {
        try {
            const r = await syncMember(url);
            roster.row(!!(r && r.ok));
            if (r && r.report && !r.report.ok) roster.problem('member scrape degraded', r.report.summary());
        } catch (err) {
            // This used to be a bare console.error inside the loop, so a scan where every
            // member failed still finished quietly.
            roster.row(false);
            roster.problem('member sync threw', err.message);
            console.error('[AWT Scraper] Member sync failed:', err);
        }
    }
    const result = roster.finish();
    if (typeof window !== 'undefined' && window.parent && !result.ok) {
        window.parent.postMessage({ type: 'SHOW_TOAST', payload: `⚠️ ${result.line}` }, window.location.origin);
    }
    return result;
}

// Off-page scan (e.g. triggered from the News page): fetch the alliance overview to get
// the member roster, then sync each member's stats + stationed fleets. Returns a count.
export async function runAllianceFleetScan() {
    const ovRes = await gameFetch('/Game/Alliance');
    const ovDoc = new DOMParser().parseFromString(await ovRes.text(), 'text/html');
    const urls = memberLinksFrom(ovDoc);
    if (urls.length === 0) return 0;

    console.log(`[AWT Scraper] Refreshing ${urls.length} alliance members' fleets...`);
    // `ok` used to count every call that did not throw, including ones that silently
    // parsed nothing, so the News page reported a full refresh after a total failure.
    const roster = new ScrapeReport('alliance fleet refresh');
    for (const url of urls) {
        try {
            const r = await syncMember(url);
            roster.row(!!(r && r.ok));
            if (r && r.report && !r.report.ok) roster.problem('member scrape degraded', r.report.summary());
        } catch (err) {
            roster.row(false);
            roster.problem('member sync threw', err.message);
            console.error('[AWT Scraper] Member sync failed:', err);
        }
    }
    roster.finish();
    return roster.rowsParsed;
}