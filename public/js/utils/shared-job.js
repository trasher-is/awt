// Ask the hub whether THIS member's browser may run a hub-wide background job now.
// The hub grants it to one member at a time, rotating between members (see
// src/repositories/sharedJobs.js for the rules). Only a granted claim may send game
// requests; any failure counts as "not granted", so trouble means less game traffic, never
// more. These calls hit our own server only — they are not game traffic.

export async function claimSharedJob(job) {
    try {
        const res = await fetch(`/hub-api/sync/shared-job/${encodeURIComponent(job)}/claim`, { method: 'POST' });
        if (!res.ok) return false;
        const body = await res.json().catch(() => ({}));
        return body.success === true && body.granted === true;
    } catch (err) {
        return false;
    }
}

// A member pressed a scan button: record it for the "last scan" lines. Fire and forget.
export function recordSharedJobRun(job) {
    return fetch(`/hub-api/sync/shared-job/${encodeURIComponent(job)}/ran`, { method: 'POST' }).catch(() => {});
}

export async function fetchSharedJobStatus() {
    try {
        const res = await fetch('/hub-api/sync/shared-jobs');
        const body = await res.json();
        return body && body.success ? body.jobs || {} : {};
    } catch (err) {
        return {};
    }
}
