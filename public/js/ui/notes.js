// Personal task/reminder notes drawer. Fetches the logged-in user's open notes,
// drives the header bell badge (time to the closest due task, red when overdue),
// and pops an in-page reminder (+ browser Notification) 15 minutes before a note
// that has "remind 15m before" checked. The Discord mention for the same reminder
// is sent server-side (src/discord_bot.js checkNoteReminders) — independent of
// whether this tab is even open.
import { esc } from '../utils/escape.js';

let notesCache = [];
const alertedIds = new Set(); // notes already popped up this session — avoid re-nagging every poll
let recipients = []; // active members this user can assign a note to: [{id, game_name}]
let selfId = null;

function fmtRemaining(ms) {
    const overdue = ms < 0;
    const abs = Math.abs(ms);
    const totalMin = Math.floor(abs / 60000);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    const label = h > 0 ? `${h}h ${m}m` : (m > 0 ? `${m}m` : '<1m');
    return overdue ? `OVERDUE ${label}` : `in ${label}`;
}

function updateBadge() {
    const badge = document.getElementById('notes-badge-text');
    const btn = document.getElementById('notes-trigger');
    if (!badge || !btn) return;

    const timed = notesCache.filter(n => n.due_at);
    if (!timed.length) {
        badge.classList.add('hidden');
        btn.classList.remove('text-red-400', 'animate-pulse');
        return;
    }
    timed.sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
    const diff = new Date(timed[0].due_at) - Date.now();
    badge.textContent = fmtRemaining(diff);
    badge.classList.remove('hidden');
    btn.classList.toggle('text-red-400', diff < 0);
    btn.classList.toggle('animate-pulse', diff < 0);
}

function showReminderPopup(note) {
    try {
        if (window.Notification && Notification.permission === 'granted') {
            new Notification('⏰ Reminder', { body: note.text });
        }
    } catch (e) { /* notifications unsupported/blocked — modal below still shows */ }

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4';
    overlay.innerHTML = `
        <div class="bg-card border border-yellow-500 rounded-lg shadow-2xl max-w-sm w-full p-5 flex flex-col gap-3">
            <div class="flex items-center gap-2 text-yellow-400 font-bold text-sm uppercase tracking-wide">
                <i class="fa-solid fa-bell"></i> Reminder
            </div>
            <div class="text-foreground text-sm break-words">${esc(note.text)}</div>
            <div class="text-muted-foreground text-xs font-mono">Due ${new Date(note.due_at).toLocaleString()}</div>
            <div class="flex gap-2 mt-2">
                <button data-act="done" class="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">Mark done</button>
                <button data-act="dismiss" class="flex-1 h-9 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80">Dismiss</button>
            </div>
        </div>`;
    overlay.addEventListener('click', async (e) => {
        const act = e.target.closest('button')?.getAttribute('data-act');
        if (act === 'done') await markDone(note.id);
        if (act) overlay.remove();
    });
    document.body.appendChild(overlay);
}

function checkPopupReminders() {
    const now = Date.now();
    notesCache.forEach(n => {
        if (!n.due_at || !n.remind_15 || alertedIds.has(n.id)) return;
        if (new Date(n.due_at) - now <= 15 * 60 * 1000) {
            alertedIds.add(n.id);
            showReminderPopup(n);
        }
    });
}

function renderList() {
    const list = document.getElementById('notes-list');
    if (!list) return;
    if (!notesCache.length) {
        list.innerHTML = '<div class="text-center text-muted-foreground text-sm py-8">No open tasks. Nice.</div>';
        return;
    }
    const now = Date.now();
    list.innerHTML = notesCache.map(n => {
        const due = n.due_at ? new Date(n.due_at) : null;
        const overdue = due && due.getTime() < now;
        const dueLabel = due ? due.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
        return `
        <div class="bg-card border ${overdue ? 'border-red-500' : 'border-border'} rounded-lg p-3 flex items-start gap-2">
            <input type="checkbox" data-act="done" data-id="${n.id}" class="mt-1 w-4 h-4 rounded border-border bg-transparent text-primary focus:ring-0 cursor-pointer shrink-0" title="Mark done">
            <div class="flex-1 min-w-0">
                <div class="text-sm text-foreground break-words">${esc(n.text)}</div>
                ${n.author_name ? `<div class="text-[10px] text-sky-400 mt-0.5"><i class="fa-solid fa-user-check"></i> assigned by ${esc(n.author_name)}</div>` : ''}
                ${due ? `<div class="text-xs font-mono mt-1 ${overdue ? 'text-red-400 font-bold' : 'text-muted-foreground'}">
                    <i class="fa-solid fa-clock"></i> ${dueLabel} ${n.remind_15 ? '<i class="fa-solid fa-bell ml-1" title="Reminder set"></i>' : ''}
                </div>` : ''}
            </div>
            <button data-act="delete" data-id="${n.id}" class="text-muted-foreground hover:text-red-400 shrink-0" title="Delete">
                <i class="fa-solid fa-trash text-xs"></i>
            </button>
        </div>`;
    }).join('');
}

async function fetchNotes() {
    try {
        const res = await fetch('/hub-api/notes');
        const data = await res.json();
        if (data.success) notesCache = data.notes;
    } catch (e) { /* offline / logged out — keep last known state */ }
    updateBadge();
    checkPopupReminders();
    renderList();
}

async function markDone(id) {
    try { await fetch(`/hub-api/notes/${id}/done`, { method: 'PATCH' }); } catch (e) {}
    notesCache = notesCache.filter(n => n.id !== id);
    updateBadge();
    renderList();
}

async function deleteNote(id) {
    try { await fetch(`/hub-api/notes/${id}`, { method: 'DELETE' }); } catch (e) {}
    notesCache = notesCache.filter(n => n.id !== id);
    updateBadge();
    renderList();
}

function renderRecipientPicker() {
    const list = document.getElementById('note-recipients-list');
    if (!list) return;
    list.innerHTML = recipients.map(u => `
        <label class="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none py-0.5">
            <input type="checkbox" data-recipient value="${u.id}" ${u.id === selfId ? 'checked' : ''} class="w-3.5 h-3.5 rounded border-border bg-transparent text-primary focus:ring-0 cursor-pointer">
            ${esc(u.game_name)}${u.id === selfId ? ' <span class="text-muted-foreground">(you)</span>' : ''}
        </label>`).join('');
}

async function loadRecipients() {
    try {
        const [meRes, usersRes] = await Promise.all([fetch('/hub-api/me'), fetch('/hub-api/notes/recipients')]);
        const me = await meRes.json();
        const users = await usersRes.json();
        selfId = me && me.id != null ? me.id : null;
        if (users.success) recipients = users.users;
    } catch (e) { /* picker just stays empty — Add still defaults to self server-side */ }
    renderRecipientPicker();
}

function resetRecipientPicker() {
    document.querySelectorAll('#note-recipients-list input[data-recipient]').forEach(cb => {
        cb.checked = parseInt(cb.value, 10) === selfId;
    });
    const allBox = document.getElementById('note-recipients-all');
    if (allBox) allBox.checked = false;
}

async function addNote() {
    const textEl = document.getElementById('note-text-input');
    const dueEl = document.getElementById('note-due-input');
    const remindEl = document.getElementById('note-remind-input');
    const text = textEl.value.trim();
    if (!text) return;

    if (remindEl.checked && window.Notification && Notification.permission === 'default') {
        try { Notification.requestPermission(); } catch (e) {}
    }

    const recipientIds = [...document.querySelectorAll('#note-recipients-list input[data-recipient]:checked')]
        .map(cb => parseInt(cb.value, 10));

    try {
        await fetch('/hub-api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                due_at: dueEl.value ? new Date(dueEl.value).toISOString() : null,
                remind_15: remindEl.checked,
                recipient_ids: recipientIds
            })
        });
        textEl.value = '';
        dueEl.value = '';
        remindEl.checked = false;
        resetRecipientPicker();
        await fetchNotes();
    } catch (e) {}
}

// Pad-and-join a Date into the "YYYY-MM-DDTHH:MM" format <input type="datetime-local">
// expects, in the browser's local timezone (so it round-trips through the picker as-is).
function toLocalInputValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Minutes that `timeZone`'s wall clock is ahead of UTC at the instant `date`, via the
// standard shift-and-diff trick: format `date` in that zone, re-read the parts as if they
// were UTC, and the difference from `date` itself is the offset (Europe/Berlin -> +60 in
// winter/CET, +120 in summer/CEST — Intl handles the DST transition dates for us).
function tzOffsetMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((asUTC - date.getTime()) / 60000);
}

// Next daily server reset: 00:00 in Europe/Berlin (CET in winter, CEST in summer — Intl
// resolves which one applies, so this stays correct across the DST changeover). Two-pass:
// the offset is computed at "now" first, then re-checked at the guessed target instant in
// case a DST transition falls between now and then.
function nextUpdateUTC() {
    const now = new Date();
    const offset1 = tzOffsetMinutes(now, 'Europe/Berlin');
    const shifted = new Date(now.getTime() + offset1 * 60000); // now's Berlin wall-clock, readable via UTC getters
    const targetShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1, 0, 0, 0, 0);
    let guess = new Date(targetShifted - offset1 * 60000);

    const offset2 = tzOffsetMinutes(guess, 'Europe/Berlin');
    if (offset2 !== offset1) guess = new Date(targetShifted - offset2 * 60000);
    return guess;
}

// Quick-pick chips so a common due time never requires typing: relative offsets, or the
// next daily update.
function applyQuickPick(kind) {
    const input = document.getElementById('note-due-input');
    if (!input) return;
    if (kind === 'clear') { input.value = ''; return; }
    if (kind === 'update') { input.value = toLocalInputValue(nextUpdateUTC()); return; }

    const offsetMin = { '15': 15, '60': 60, '360': 360, '720': 720 }[kind];
    if (offsetMin) input.value = toLocalInputValue(new Date(Date.now() + offsetMin * 60000));
}

// Toggle the inline accordion — it lives inside the sidebar itself (not a separate
// overlay), so it's reachable on mobile without closing the sidebar first.
export function toggleNotesPanel() {
    const el = document.getElementById('notes-inline');
    if (!el) return;
    const opening = el.classList.contains('hidden');
    el.classList.toggle('hidden');
    el.classList.toggle('flex', opening);
    if (opening) renderList();
}

export function initNotes() {
    document.getElementById('note-add-btn')?.addEventListener('click', addNote);
    document.getElementById('note-quick-picks')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-quick]');
        if (btn) applyQuickPick(btn.getAttribute('data-quick'));
    });
    document.getElementById('notes-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = parseInt(btn.getAttribute('data-id'), 10);
        if (btn.getAttribute('data-act') === 'done') markDone(id);
        if (btn.getAttribute('data-act') === 'delete') deleteNote(id);
    });
    document.getElementById('note-recipients-all')?.addEventListener('change', (e) => {
        document.querySelectorAll('#note-recipients-list input[data-recipient]').forEach(cb => { cb.checked = e.target.checked; });
    });

    loadRecipients();
    fetchNotes();
    setInterval(fetchNotes, 30 * 1000);
}
