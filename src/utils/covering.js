// Shared "I cover this" state for incoming-attack alerts. A defender can claim an
// incoming from either the News panel or the Discord alert button; both funnel through
// here so the covering roster is one source of truth, stored on incoming_msgs.covering
// (newline-joined game names) and rendered as a "Covering:" line on the alert.
const incomingRepo = require('../repositories/incoming');

// Prefix that identifies the covering line inside a rendered alert body. Distinct from
// the "🛡️ **Can defend in time:**" defender header so stripping one never touches it.
const COVER_MARKER = '🛡️ **Covering:**';

function getCovering(alertKey) {
    try {
        const row = incomingRepo.getCoveringRow(alertKey);
        return row && row.covering ? row.covering.split('\n').filter(Boolean) : [];
    } catch (e) {
        return [];
    }
}

function setCovering(alertKey, names) {
    // The incoming_msgs row usually already exists (created when the alert was first sent),
    // but a News-panel claim can race ahead of that — upsert so it's never lost.
    incomingRepo.upsertCovering(alertKey, names.join('\n'));
}

// Add or remove a name from the covering roster (clicking again retracts). Case-insensitive
// match on the stored name. Returns { covering, added }.
function toggleCovering(alertKey, name) {
    const clean = String(name || '').trim();
    if (!clean) return { covering: getCovering(alertKey), added: false };
    const names = getCovering(alertKey);
    const lc = clean.toLowerCase();
    const idx = names.findIndex(n => n.toLowerCase() === lc);
    let added;
    if (idx >= 0) { names.splice(idx, 1); added = false; }
    else { names.push(clean); added = true; }
    setCovering(alertKey, names);
    return { covering: names, added };
}

// The single "Covering:" line for a roster, or '' when nobody has claimed the incoming.
function renderCoverLine(names) {
    if (!names || !names.length) return '';
    return `${COVER_MARKER} ${names.map(n => `**${n}**`).join(', ')}`;
}

// Remove any existing covering line from a rendered alert body.
function stripCoverLine(content) {
    return (content || '').split('\n').filter(l => !l.startsWith(COVER_MARKER)).join('\n');
}

// Re-apply the covering line to an already-rendered alert body: strip the old one, then
// insert the new line just above the trailing "_updated …_" footer (or at the end).
function applyCoverLine(content, line) {
    const lines = stripCoverLine(content).split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (line) {
        const last = lines[lines.length - 1] || '';
        if (last.startsWith('_updated')) lines.splice(lines.length - 1, 0, line);
        else lines.push(line);
    }
    return lines.join('\n');
}

module.exports = {
    COVER_MARKER, getCovering, setCovering, toggleCovering,
    renderCoverLine, stripCoverLine, applyCoverLine
};
