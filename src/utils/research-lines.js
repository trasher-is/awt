// Discord text for the research tracker — `!research` and `/intel research`. Pure: takes
// stored snapshots (scienceResearch.js's listResearch shape) and a clock, returns embed
// parts, so it is tested without a Discord client.
//
// Times go out as Discord <t:…> tags, which every reader sees in their own time zone. The
// "left" duration is worked out at the moment of the reply, because a relative tag only
// says "in 2 hours" and the question being asked is how long exactly.

const { statusAt, formatDuration } = require('../../public/js/utils/research-queue.js');

const STALE_MS = 6 * 3600 * 1000;
const unix = ms => Math.floor(ms / 1000);
const label = i => `${i.science} ${i.target_level}`;

function currentLine(st, nowMs) {
    const c = st.current;
    const left = formatDuration(c.finishes_at_ms - nowMs);
    const approx = st.current_exact ? '' : '~';
    return `🔬 **${label(c)}** · ${approx}${left} left · done <t:${unix(c.finishes_at_ms)}:t>`;
}

function upcomingLine(st) {
    if (!st.upcoming.length) return st.ends_with_repeat ? '🔁 then repeats' : '⚠️ nothing queued after this';
    const parts = st.upcoming.map(i => `${label(i)}${i.repeat ? ' 🔁' : ''} (<t:${unix(i.finishes_at_ms)}:t>)`);
    return `then ${parts.join(', ')}`;
}

// Why a member has nothing running. "Ran out" is inferred from the recorded queue; the
// member may well have queued more since the read, which is why the read time is shown.
function idleLine(snap, st) {
    if (st.idle_since_ms != null) {
        return st.ends_with_repeat
            ? `🔁 last known item finished <t:${unix(st.idle_since_ms)}:R> and repeats — current level unknown`
            : `💤 queue ran out <t:${unix(st.idle_since_ms)}:R>`;
    }
    return '💤 nothing being researched';
}

function seenLine(snap, nowMs) {
    const stale = nowMs - snap.observed_at_ms > STALE_MS;
    return `${stale ? '⚠️ ' : ''}read <t:${unix(snap.observed_at_ms)}:R>`;
}

/** One member, as an embed field. */
function memberField(snap, nowMs) {
    const st = statusAt(snap, nowMs);
    const lines = st.current
        ? [currentLine(st, nowMs), upcomingLine(st)]
        : [idleLine(snap, st)];
    lines.push(seenLine(snap, nowMs));
    return { name: snap.name, value: lines.join('\n').slice(0, 1024), idle: !st.current, finishesAt: st.current ? st.current.finishes_at_ms : 0 };
}

/**
 * The alliance overview. Idle members first — they are the ones someone can act on — then
 * whoever finishes soonest.
 * @returns {{fields:Array<{name,value}>, footer:string}}
 */
function buildResearchOverview(snaps, missingNames, nowMs) {
    const fields = snaps.map(s => memberField(s, nowMs))
        .sort((a, b) => (b.idle - a.idle) || (a.finishesAt - b.finishesAt))
        .map(({ name, value }) => ({ name, value }))
        .slice(0, 24);
    if (missingNames && missingNames.length) {
        fields.push({
            name: 'No research reported yet',
            value: `${missingNames.join(', ')}`.slice(0, 900) + '\n*Appears once they open the Hub or their Science page.*',
        });
    }
    return {
        fields,
        footer: 'From each member\'s own Science page. ~ = rolled forward past the last read; queued times move if the science rate changes.',
    };
}

/** One member in full: the whole queue, levels and rate. */
function buildResearchDetail(snap, nowMs) {
    const st = statusAt(snap, nowMs);
    const lines = [];
    if (st.current) {
        lines.push(currentLine(st, nowMs));
        st.upcoming.forEach((i, idx) => {
            lines.push(`${idx + 2}. ${label(i)}${i.repeat ? ' 🔁' : ''} · done <t:${unix(i.finishes_at_ms)}:t> (in ${formatDuration(i.finishes_at_ms - nowMs)})`);
        });
        if (!st.upcoming.length) lines.push(upcomingLine(st));
    } else {
        lines.push(idleLine(snap, st));
    }
    if (st.done.length) lines.push(`✅ finished since the read: ${st.done.map(label).join(', ')}`);
    const levels = Object.entries(snap.levels || {}).map(([k, v]) => `${k.slice(0, 4)} ${v}`).join(' · ');
    if (levels) lines.push('', `Levels at the read: ${levels}`);
    if (Number.isFinite(snap.science_rate)) lines.push(`Science rate: ${snap.science_rate}/h`);
    lines.push(seenLine(snap, nowMs));
    return { title: `🔬 ${snap.name} — research`, description: lines.join('\n').slice(0, 4000) };
}

module.exports = { buildResearchOverview, buildResearchDetail, memberField };
