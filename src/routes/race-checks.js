const express = require('express');
const { requireAuth, requireAdmin, requireWriteRole } = require('./_middleware');
const defaultService = require('../utils/race-llm-service');
function createRouter(service = defaultService) {
    const router = express.Router();
    const idOf = raw => /^\d+$/.test(raw || '') && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
    const statusFor = error => error === 'forbidden' || error === 'not_approved' ? 403
        : error === 'not_found' ? 404 : error === 'disabled' ? 503
            : ['budget_exhausted', 'provider_busy', 'provider_rate_limit'].includes(error) ? 429
                : ['already_requested', 'already_decided', 'already_running', 'held_requires_resolution', 'request_expired'].includes(error) ? 409
                    : error?.startsWith('provider_') ? 502 : 422;
    const handler = (idParam, action) => async (req, res, next) => {
        const id = idParam ? idOf(req.params[idParam]) : null;
        if (idParam && !id) return res.status(400).json({ error: 'invalid_id' });
        res.setHeader('Cache-Control', 'no-store');
        try {
            const result = await action(id, req);
            return res.status(result?.error ? statusFor(result.error) : 200).json(result);
        } catch (error) { return next(error); }
    };
    router.post('/intel/race/:playerId/check-request', requireAuth, requireWriteRole,
        handler('playerId', (id, req) => service.requestCheck(id, req.session.userId)));
    router.get('/admin/race/check-requests', requireAuth, requireAdmin,
        handler(null, () => ({ requests: service.queue() })));
    router.post('/admin/race/check-requests/:id/approve', requireAuth, requireAdmin,
        handler('id', (id, req) => service.approveRequest(id, req.session.userId)));
    router.post('/admin/race/check-requests/:id/reject', requireAuth, requireAdmin,
        handler('id', (id, req) => service.rejectRequest(id, req.session.userId)));
    router.post('/admin/race/:playerId/check', requireAuth, requireAdmin,
        handler('playerId', (id, req) => service.runCheck(id, { userId: req.session.userId })));
    router.post('/admin/race/:playerId/check/resolve', requireAuth, requireAdmin,
        handler('playerId', (id, req) => service.resolveCheck(id, req.session.userId, req.body?.decision || 'release')));
    router.get('/admin/llm-usage', requireAuth, requireAdmin, handler(null, () => service.usage()));
    return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
