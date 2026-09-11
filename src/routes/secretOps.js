// Token-gated admin surface for the bonus-goals engine (see bonusGoals.js and
// database.js's bonus_goals comment for the secrecy design). This file's own content is
// committed to git like everything else — it is a GENERIC goal-config CRUD page, with no
// mention of any specific goal. What's actually configured lives only in the database.
//
// Mounted in server.js at a path built from a random per-install token
// (bonusGoalsRepo.getOrCreateAccessToken()) — this router itself only adds the second
// layer: requireAuth + requireAdmin, so a leaked/guessed path alone is still not enough.
const express = require('express');
const { requireAuth, requireAdmin } = require('./_middleware');
const bonusGoalsRepo = require('../repositories/bonusGoals');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/api/goals', (req, res) => {
    res.json({ success: true, goals: bonusGoalsRepo.listGoals() });
});

router.post('/api/goals', (req, res) => {
    const { type, name, config, enabled } = req.body || {};
    if (!type || !name) return res.status(400).json({ error: 'type and name are required' });
    let parsedConfig = {};
    if (config != null) {
        try { parsedConfig = typeof config === 'string' ? JSON.parse(config) : config; }
        catch (err) { return res.status(400).json({ error: 'config is not valid JSON' }); }
    }
    const goal = bonusGoalsRepo.createGoal({ type, name, config: parsedConfig, enabled: !!enabled });
    res.json({ success: true, goal });
});

router.put('/api/goals/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const { name, config, enabled } = req.body || {};
    let parsedConfig;
    if (config != null) {
        try { parsedConfig = typeof config === 'string' ? JSON.parse(config) : config; }
        catch (err) { return res.status(400).json({ error: 'config is not valid JSON' }); }
    }
    const goal = bonusGoalsRepo.updateGoal(id, { name, config: parsedConfig, enabled });
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true, goal });
});

router.delete('/api/goals/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const ok = bonusGoalsRepo.deleteGoal(id);
    if (!ok) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true });
});

router.get('/api/awards', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    res.json({ success: true, awards: bonusGoalsRepo.listRecentAwards(limit) });
});

// A single self-contained page — no static asset (see this file's own header comment for
// why: a file under public/ would be reachable at its own predictable path regardless of
// this route's secret prefix, defeating the entire point).
router.get('/', (req, res) => {
    res.type('html').send(ADMIN_PAGE_HTML);
});

const ADMIN_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bonus Goals</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0b0b0f; color:#e5e5e5; font:14px/1.4 system-ui,sans-serif; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .hint { color:#888; font-size:12px; margin-bottom:20px; }
  section { background:#15151c; border:1px solid #2a2a35; border-radius:8px; padding:16px; margin-bottom:20px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#aaa; margin:0 0 12px; }
  label { display:block; font-size:12px; color:#999; margin:10px 0 4px; }
  input[type=text], select, textarea { width:100%; box-sizing:border-box; background:#0b0b0f; color:#eee; border:1px solid #333; border-radius:4px; padding:8px; font-family:inherit; }
  textarea { font-family:ui-monospace,monospace; font-size:12px; min-height:140px; }
  .row { display:flex; align-items:center; gap:8px; margin-top:10px; }
  button { background:#3b3b55; color:#fff; border:1px solid #4a4a68; border-radius:4px; padding:7px 14px; cursor:pointer; font-size:13px; }
  button:hover { background:#4a4a68; }
  button.danger { background:#552b2b; border-color:#6b3838; }
  button.danger:hover { background:#6b3838; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #24242e; }
  th { color:#888; font-weight:normal; font-size:11px; text-transform:uppercase; }
  .pill { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; }
  .pill.on { background:#1e4620; color:#7be27f; }
  .pill.off { background:#3a2020; color:#e2807b; }
  .actions button { padding:3px 9px; font-size:12px; margin-right:4px; }
  #status { font-size:12px; color:#7be27f; min-height:16px; }
</style>
</head>
<body>
<h1>Bonus Goals</h1>
<div class="hint">Generic engine config — only whoever has this link and an admin account can see or change anything here.</div>

<section>
  <h2 id="form-title">New goal</h2>
  <input type="hidden" id="goal-id">
  <label>Name <span style="color:#666">(admin-facing only, members never see this)</span></label>
  <input type="text" id="goal-name" placeholder="e.g. a short label for yourself">
  <label>Type</label>
  <select id="goal-type">
    <option value="ranking_match">ranking_match — tiered points for hitting a planet in some in-game ranking page</option>
    <option value="random_target">random_target — a random planet, an irregular schedule, first real hit wins flat points</option>
  </select>
  <label>Config (JSON)</label>
  <textarea id="goal-config"></textarea>
  <div class="row">
    <label style="margin:0"><input type="checkbox" id="goal-enabled" style="width:auto"> Enabled</label>
  </div>
  <div class="row">
    <button id="btn-save">Save</button>
    <button id="btn-reset" type="button">New / Clear</button>
    <span id="status"></span>
  </div>
</section>

<section>
  <h2>Goals</h2>
  <table id="goals-table">
    <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Config</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Recent awards</h2>
  <table id="awards-table">
    <thead><tr><th>When</th><th>Player</th><th>Goal</th><th>Points</th><th>Detail</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<script>
const base = location.pathname.replace(/\\/$/, '');
// Deliberately generic placeholder VALUES, not real ones — this file is committed to git
// (see this file's own header comment) and these are just form scaffolding, filled in by
// hand once the page is actually open behind the token gate.
const configTemplates = {
  ranking_match: {
    ranking_path: '/Ranking/SomePage',
    tier_size: 5,
    tier_start_points: 10,
    tier_step: -1,
    max_rank: 25,
  },
  random_target: {
    points: 10,
    daily_probability: 0.5,
    active_hour_start: 7,
    active_hour_end: 22,
  },
};

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setStatus(msg) { document.getElementById('status').textContent = msg; setTimeout(() => { document.getElementById('status').textContent = ''; }, 3000); }

document.getElementById('goal-type').addEventListener('change', (e) => {
  document.getElementById('goal-config').value = JSON.stringify(configTemplates[e.target.value] || {}, null, 2);
});
document.getElementById('goal-config').value = JSON.stringify(configTemplates.ranking_match, null, 2);

document.getElementById('btn-reset').addEventListener('click', () => {
  document.getElementById('goal-id').value = '';
  document.getElementById('form-title').textContent = 'New goal';
  document.getElementById('goal-name').value = '';
  document.getElementById('goal-enabled').checked = false;
  document.getElementById('goal-config').value = JSON.stringify(configTemplates[document.getElementById('goal-type').value] || {}, null, 2);
});

document.getElementById('btn-save').addEventListener('click', async () => {
  const id = document.getElementById('goal-id').value;
  const payload = {
    type: document.getElementById('goal-type').value,
    name: document.getElementById('goal-name').value.trim(),
    config: document.getElementById('goal-config').value,
    enabled: document.getElementById('goal-enabled').checked,
  };
  if (!payload.name) { setStatus('Name is required'); return; }
  const res = await fetch(base + '/api/goals' + (id ? '/' + id : ''), {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { setStatus('Error: ' + (data.error || res.status)); return; }
  setStatus('Saved.');
  document.getElementById('btn-reset').click();
  loadGoals();
});

async function loadGoals() {
  const res = await fetch(base + '/api/goals');
  const data = await res.json();
  const tbody = document.querySelector('#goals-table tbody');
  tbody.innerHTML = (data.goals || []).map(g => \`
    <tr>
      <td>\${esc(g.name)}</td>
      <td>\${esc(g.type)}</td>
      <td><span class="pill \${g.enabled ? 'on' : 'off'}">\${g.enabled ? 'ON' : 'off'}</span></td>
      <td><code style="font-size:11px">\${esc(JSON.stringify(g.config))}</code></td>
      <td class="actions">
        <button data-edit="\${g.id}">Edit</button>
        <button data-toggle="\${g.id}" data-enabled="\${g.enabled}">\${g.enabled ? 'Disable' : 'Enable'}</button>
        <button class="danger" data-delete="\${g.id}">Delete</button>
      </td>
    </tr>\`).join('') || '<tr><td colspan="5" style="color:#666">No goals yet.</td></tr>';

  tbody.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
    const g = data.goals.find(x => x.id === Number(btn.dataset.edit));
    document.getElementById('goal-id').value = g.id;
    document.getElementById('form-title').textContent = 'Edit goal #' + g.id;
    document.getElementById('goal-name').value = g.name;
    document.getElementById('goal-type').value = g.type;
    document.getElementById('goal-config').value = JSON.stringify(g.config, null, 2);
    document.getElementById('goal-enabled').checked = g.enabled;
    window.scrollTo(0, 0);
  }));
  tbody.querySelectorAll('[data-toggle]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.toggle;
    const enabled = btn.dataset.enabled !== 'true';
    await fetch(base + '/api/goals/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    loadGoals();
  }));
  tbody.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this goal? Its award history stays, but it stops scoring.')) return;
    await fetch(base + '/api/goals/' + btn.dataset.delete, { method: 'DELETE' });
    loadGoals();
  }));
}

async function loadAwards() {
  const res = await fetch(base + '/api/awards?limit=100');
  const data = await res.json();
  const tbody = document.querySelector('#awards-table tbody');
  tbody.innerHTML = (data.awards || []).map(a => \`
    <tr>
      <td>\${esc(a.awarded_at)}</td>
      <td>\${esc(a.player_name)}</td>
      <td>\${esc(a.goal_name)}</td>
      <td>\${esc(a.points)}</td>
      <td><code style="font-size:11px">\${esc(a.detail)}</code></td>
    </tr>\`).join('') || '<tr><td colspan="5" style="color:#666">No awards yet.</td></tr>';
}

loadGoals();
loadAwards();
</script>
</body>
</html>`;

module.exports = router;
