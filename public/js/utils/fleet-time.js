// public/js/utils/fleet-time.js
// Converts the game's localized fleet arrival text into an absolute UTC timestamp.
//
// The in-game value looks like "04:54:12 - birž. 20" (time + localized month + day).
// We deliberately IGNORE the month name (it depends on each scraper's browser locale —
// Lithuanian, English, German, Finnish, Spanish...). Instead we use the plain digits:
// the day-of-month and the time, anchored to the browser's current date. Fleets always
// arrive in the near future, so if the reconstructed moment is already in the past we
// roll it forward by one month.
//
// Parsing happens in the scraper's browser, so the displayed time is in THAT viewer's
// local timezone — `new Date(y, m, d, h, mi, s).toISOString()` yields correct UTC
// regardless of where the member is (Chile, Finland, etc.).

export function parseArrivalToISO(text, nowMs = Date.now()) {
    if (!text || typeof text !== 'string') return null;

    const timeMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!timeMatch) return null;

    const hh = parseInt(timeMatch[1], 10);
    const mm = parseInt(timeMatch[2], 10);
    const ss = parseInt(timeMatch[3], 10);
    if (hh > 23 || mm > 59 || ss > 59) return null;

    // Day-of-month: the first standalone 1–31 number that isn't part of the time.
    const afterTime = text.slice(timeMatch.index + timeMatch[0].length);
    const dayMatch = afterTime.match(/(\b[0-3]?\d\b)/);

    const now = new Date(nowMs);
    let year = now.getFullYear();
    let month = now.getMonth(); // 0-based
    let day = dayMatch ? parseInt(dayMatch[1], 10) : now.getDate();
    if (day < 1 || day > 31) day = now.getDate();

    // Build the candidate in LOCAL time.
    let candidate = new Date(year, month, day, hh, mm, ss, 0);

    // Guard against month-length overflow (e.g. day 31 in a 30-day month rolls over).
    if (candidate.getDate() !== day) {
        candidate = new Date(year, month + 1, day, hh, mm, ss, 0);
    }

    // Arrivals are in the future: if we landed in the past, advance one month.
    // Small negative slack (2 min) absorbs scrape/display lag without misrolling.
    if (candidate.getTime() < nowMs - 120000) {
        candidate = new Date(year, month + 1, day, hh, mm, ss, 0);
        if (candidate.getDate() !== day) {
            candidate = new Date(year, month + 2, day, hh, mm, ss, 0);
        }
    }

    if (isNaN(candidate.getTime())) return null;
    return candidate.toISOString();
}
