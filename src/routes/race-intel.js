const express = require('express');
const { requireAdmin } = require('./_middleware');
const repository = require('../repositories/raceEstimates');
const service = require('../utils/race-inference-service');
const router = express.Router();
router.use('/admin/race', requireAdmin, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/admin/race', (req, res) => res.json({ success: true, estimates: repository.listEstimates(), calibration: service.getCalibrationSummary() }));
router.get('/admin/race/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid player ID.' });
    res.json({ success: true, estimate: repository.getEstimate(id), evidence: repository.evidenceForPlayer(id) });
});
router.post('/admin/race/recompute', (req, res) => {
    const id = req.body && req.body.player_id;
    if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: 'Invalid player ID.' });
    res.json({ success: true, result: id === undefined ? service.recomputeAll() : service.recompute(id) });
});
router.post('/admin/race/evidence/:id', (req, res) => {
    const id = Number(req.params.id), status = req.body && req.body.status;
    if (!Number.isSafeInteger(id) || id <= 0 || !['ok', 'excluded'].includes(status)) return res.status(400).json({ error: 'Choose include (ok) or excluded.' });
    const playerId = repository.setEvidenceStatus(id, status);
    if (playerId === null) return res.status(404).json({ error: 'Evidence not found.' });
    res.json({ success: true, result: service.recompute(playerId) });
});
module.exports = router;
