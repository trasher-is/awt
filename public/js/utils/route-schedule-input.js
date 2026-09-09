// Local date input and the saved UTC anchor are different things. In a repeated autumn
// hour, parsing the displayed wall-clock again can move a saved route back by an hour.
// Keep its exact instant until the member edits the date or changes planning mode.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWRouteScheduleInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function localInputToIso(value) {
        if (!value) return null;
        const parts = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
        const d = new Date(value);
        const invalid = () => { throw new Error('This local date or time does not exist. Choose a valid local time.'); };
        if (!parts || !Number.isFinite(d.getTime())) return invalid();
        const [, year, month, day, hour, minute, second = '0', fraction = '0'] = parts;
        // Native Date silently moves e.g. 02:30 to 03:30 when clocks jump forward.
        if (d.getFullYear() !== Number(year) || d.getMonth() + 1 !== Number(month)
            || d.getDate() !== Number(day) || d.getHours() !== Number(hour)
            || d.getMinutes() !== Number(minute) || d.getSeconds() !== Number(second)
            || d.getMilliseconds() !== Number(fraction.padEnd(3, '0'))) return invalid();
        return d.toISOString();
    }

    function isoToLocalInput(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) throw new Error('The saved route has an invalid date.');
        const pad = n => String(n).padStart(2, '0');
        return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // Browsers omit :00 from the value of datetime-local controls even when it was set.
    const withSeconds = value => /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;

    function createScheduleInput() {
        let mode = 'start';
        let canonical = null;
        let loadedValue = '';
        return {
            get mode() { return mode; },
            setMode(next) {
                if (next !== 'start' && next !== 'arrival') throw new Error('Unknown planning mode.');
                mode = next;
                canonical = null;
                loadedValue = '';
            },
            load(route) {
                mode = route.targetArrivalAt ? 'arrival' : 'start';
                canonical = route.targetArrivalAt || route.plannedStartAt || null;
                loadedValue = isoToLocalInput(canonical);
                return { mode, value: loadedValue };
            },
            edit() { canonical = null; },
            fields(value) {
                const iso = canonical && withSeconds(value) === withSeconds(loadedValue)
                    ? canonical : localInputToIso(value);
                return {
                    plannedStartAt: mode === 'start' ? iso : null,
                    targetArrivalAt: mode === 'arrival' ? iso : null
                };
            }
        };
    }

    return { localInputToIso, isoToLocalInput, createScheduleInput };
});
