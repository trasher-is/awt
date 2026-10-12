// /hub-api/admin/peers/* — an admin decides whom we share with and whom we read from.
// /hub-api/peers/*       — members browse what partner hubs have shared with us.
// See docs/peer-sharing.md.
const express = require('express');
const { requireAuth, requireAdmin } = require('./_middleware');
const peersRepo = require('../repositories/peers');
const { KINDS, ENABLED_KINDS, normaliseScopes } = require('../utils/peer-kinds');
const { validateBaseUrl, pullSource } = require('../utils/peer-pull');

const router = express.Router();

const kindList = () => ENABLED_KINDS.map(k => ({ key: k, label: KINDS[k].label }));
const idParam = req => { const n = Number(req.params.id); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const cleanName = v => String(v || '').trim().slice(0, 80);

// ─── ADMIN ───────────────────────────────────────────────────────────────────

router.get('/admin/peers', requireAdmin, (req, res) => {
    res.json({ success: true, kinds: kindList(), links: peersRepo.listLinks(), sources: peersRepo.listSources() });
});

router.post('/admin/peers/links', requireAdmin, (req, res) => {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ success: false, error: 'Give the partner a name' });
    const scopes = normaliseScopes(req.body.scopes);
    if (!scopes.length) return res.status(400).json({ success: false, error: 'Pick at least one thing to share' });
    const { link, token } = peersRepo.createLink({
        name, scopes, excludeTags: req.body.excludeTags,
    });
    console.log(`[Peers] ${req.session.gameName} created share link #${link.id} "${name}" (${scopes.join(', ')})`);
    res.json({ success: true, link, token });
});

router.put('/admin/peers/links/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    const patch = {};
    for (const k of ['name', 'scopes', 'excludeTags', 'enabled']) {
        if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    if (patch.name !== undefined && !cleanName(patch.name)) return res.status(400).json({ success: false, error: 'Name cannot be empty' });
    const link = id && peersRepo.updateLink(id, patch);
    if (!link) return res.status(404).json({ success: false, error: 'No such link' });
    res.json({ success: true, link });
});

router.delete('/admin/peers/links/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    if (!id || !peersRepo.deleteLink(id)) return res.status(404).json({ success: false, error: 'No such link' });
    console.log(`[Peers] ${req.session.gameName} revoked share link #${id}`);
    res.json({ success: true });
});

router.post('/admin/peers/sources', requireAdmin, (req, res) => {
    const name = cleanName(req.body.name);
    const token = String(req.body.token || '').trim();
    const url = validateBaseUrl(req.body.baseUrl);
    if (!name) return res.status(400).json({ success: false, error: 'Give the partner a name' });
    if (url.error) return res.status(400).json({ success: false, error: url.error });
    if (!/^awtp_[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(400).json({ success: false, error: 'That does not look like an AWT peer token (awtp_…)' });
    const source = peersRepo.createSource({ name, baseUrl: url.url, token });
    console.log(`[Peers] ${req.session.gameName} added source #${source.id} "${name}" (${url.url})`);
    res.json({ success: true, source });
});

router.put('/admin/peers/sources/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    const patch = {};
    if (req.body.name !== undefined) {
        patch.name = cleanName(req.body.name);
        if (!patch.name) return res.status(400).json({ success: false, error: 'Name cannot be empty' });
    }
    if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
    if (req.body.token) {
        const t = String(req.body.token).trim();
        if (!/^awtp_[A-Za-z0-9_-]{20,}$/.test(t)) return res.status(400).json({ success: false, error: 'That does not look like an AWT peer token (awtp_…)' });
        patch.token = t;
    }
    const source = id && peersRepo.updateSource(id, patch);
    if (!source) return res.status(404).json({ success: false, error: 'No such source' });
    res.json({ success: true, source });
});

router.delete('/admin/peers/sources/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    if (!id || !peersRepo.deleteSource(id)) return res.status(404).json({ success: false, error: 'No such source' });
    console.log(`[Peers] ${req.session.gameName} removed source #${id} and everything it sent`);
    res.json({ success: true });
});

router.post('/admin/peers/sources/:id/pull', requireAdmin, async (req, res) => {
    const id = idParam(req);
    if (!id || !peersRepo.getSource(id)) return res.status(404).json({ success: false, error: 'No such source' });
    const result = await pullSource(id);
    res.json({ success: result.ok, result, source: peersRepo.getSource(id) });
});

// ─── MEMBERS ─────────────────────────────────────────────────────────────────

// The newest partner intelligence report on one player, for the profile page's Hub Intel
// card (public/js/core/page-injections.js decides whether it beats our own). Partner name
// only — never the address or token. Display only: nothing here is written to players.
router.get('/peers/player/:id/intel', requireAuth, (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(400).json({ success: false, error: 'Bad player id' });
    res.json({ success: true, intel: peersRepo.partnerIntelForPlayer(id) });
});

module.exports = router;
