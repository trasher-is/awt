const express = require('express');
const usersRepo = require('../repositories/users');
const planetBankingRepo = require('../repositories/planetBanking');
const alliancesRepo = require('../repositories/alliances');
const savingsExpensesRepo = require('../repositories/savingsExpenses');
const { requireAuth } = require('./_middleware');
const router = express.Router();

// --- MY SAVINGS (2026-09-18) ---
// A simpler, deliberately non-simulated stand-in for the Schedule tab's "total production
// converts to savings" math, which overstates how fast a player reaches the next TA when
// some of their planets are still spending their PP on buildings instead of banking it.
// This tool asks the player which planets are actually banking and only counts those —
// no build-order simulation, no finish-date prediction. See planet_banking's own comment
// in database.js for why the `banking` flag is manual rather than auto-detected.

// "Own" is resolved the same way /intel/me/planets resolves it.
function resolveOwnPlayerId(req) {
    const bridge = usersRepo.getUserAllianceIdBridge(req.session.userId);
    return bridge ? bridge.player_id : null;
}

router.get('/my-planets', requireAuth, (req, res) => {
    try {
        const playerId = resolveOwnPlayerId(req);
        if (!playerId) {
            return res.json({ success: false, error: 'No player on record for this account yet.' });
        }
        res.json({ success: true, planets: planetBankingRepo.getPlayerPlanets(playerId) });
    } catch (err) {
        console.error('[DB Error] Failed to load My Savings planets:', err);
        res.status(500).json({ success: false, error: 'Failed to load planets' });
    }
});

router.post('/sync/my-planets', requireAuth, (req, res) => {
    const { planets } = req.body;
    if (!Array.isArray(planets)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    try {
        const playerId = resolveOwnPlayerId(req);
        if (!playerId) {
            return res.status(404).json({ error: 'No player on record for this account yet.' });
        }
        const rows = planets
            .filter(p => Number.isInteger(p.game_planet_id))
            .map(p => ({
                game_planet_id: p.game_planet_id,
                system_id: Number.isInteger(p.system_id) ? p.system_id : null,
                name: typeof p.name === 'string' ? p.name.slice(0, 200) : null,
                population: Number.isFinite(p.population) ? Math.round(p.population) : null,
                population_progress: Number.isFinite(p.population_progress) ? Math.round(p.population_progress) : null,
                growth_rate: Number.isFinite(p.growth_rate) ? p.growth_rate : null,
                production_pp: Number.isFinite(p.production_pp) ? Math.round(p.production_pp) : null,
                production_rate: Number.isFinite(p.production_rate) ? p.production_rate : null,
            }));
        planetBankingRepo.syncPlayerPlanets(playerId, rows);
        // Production Points (2026-09-20): the total already-saved PP across every synced
        // planet, replacing the Alliance member-sheet's much coarser figure for this
        // member's own row — see alliances.js's upsertProductionPoints for why. Summed
        // over ALL planets, not just banking ones: production_pp is stock already sitting
        // there, independent of whether future production is being banked or spent.
        const totalPp = rows.reduce((sum, p) => sum + (p.production_pp || 0), 0);
        alliancesRepo.upsertProductionPoints(playerId, totalPp);
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] My Savings planet sync failure:', err);
        res.status(500).json({ error: 'Database sync error' });
    }
});

router.post('/my-planets/:gamePlanetId/banking', requireAuth, (req, res) => {
    const gamePlanetId = Number(req.params.gamePlanetId);
    if (!Number.isInteger(gamePlanetId)) {
        return res.status(400).json({ success: false, error: 'Invalid planet id' });
    }
    if (typeof req.body.banking !== 'boolean') {
        return res.status(400).json({ success: false, error: 'banking must be true or false' });
    }
    try {
        const playerId = resolveOwnPlayerId(req);
        if (!playerId) {
            return res.status(404).json({ success: false, error: 'No player on record for this account yet.' });
        }
        const updated = planetBankingRepo.setPlanetBanking(playerId, gamePlanetId, req.body.banking);
        if (!updated) {
            return res.status(404).json({ success: false, error: 'Planet not found for this account.' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] My Savings banking toggle failure:', err);
        res.status(500).json({ success: false, error: 'Failed to update planet' });
    }
});

// Alliance-wide, not "my"-scoped: any member can see who's worth waiting on before
// proposing the next TA. A member who has never opened My Savings just has no rows and so
// no entry here — see getAllianceTrOutlook's own comment for why that's "no data", not 0%.
router.get('/trade-agreements/tr-outlook', requireAuth, (req, res) => {
    try {
        res.json({ success: true, members: planetBankingRepo.getAllianceTrOutlook() });
    } catch (err) {
        console.error('[DB Error] Failed to load TR outlook:', err);
        res.status(500).json({ success: false, error: 'Failed to load TR outlook' });
    }
});

// --- MY SAVINGS: PLANNED EXPENSES (2026-09-25) ---
// A$ a member knows they will spend soon, each with a due time. The panel reserves them on
// top of the trade-agreement cost. Scoped to the hub account (req.session.userId), not the
// player bridge: a member with no player on record yet can still note what they need.
const MAX_EXPENSES = 20;
const MAX_AMOUNT = 1e9;
const DUE_WINDOW_MS = 60 * 24 * 3600 * 1000; // due times beyond two months either way are typos

function readAmount(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT ? n : null;
}
function readDueAt(value) {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n - Date.now()) <= DUE_WINDOW_MS ? Math.round(n) : null;
}

router.get('/my-planets/expenses', requireAuth, (req, res) => {
    try {
        res.json({ success: true, expenses: savingsExpensesRepo.listExpenses(req.session.userId) });
    } catch (err) {
        console.error('[DB Error] Failed to load savings expenses:', err);
        res.status(500).json({ success: false, error: 'Failed to load expenses' });
    }
});

router.post('/my-planets/expenses', requireAuth, (req, res) => {
    const body = req.body || {};
    const amount = body.amount === undefined ? 0 : readAmount(body.amount);
    const dueAt = body.due_at === undefined ? Date.now() + 6 * 3600 * 1000 : readDueAt(body.due_at);
    if (amount === null) return res.status(400).json({ success: false, error: 'Amount must be a whole number of A$ from 0 up.' });
    if (dueAt === null) return res.status(400).json({ success: false, error: 'Due time must be within two months of now.' });
    try {
        if (savingsExpensesRepo.countExpenses(req.session.userId) >= MAX_EXPENSES) {
            return res.status(400).json({ success: false, error: `At most ${MAX_EXPENSES} expenses — remove one that is done first.` });
        }
        res.json({ success: true, expense: savingsExpensesRepo.createExpense(req.session.userId, amount, dueAt) });
    } catch (err) {
        console.error('[DB Error] Failed to add savings expense:', err);
        res.status(500).json({ success: false, error: 'Failed to add expense' });
    }
});

router.patch('/my-planets/expenses/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    try {
        const current = Number.isInteger(id) ? savingsExpensesRepo.getExpense(id, req.session.userId) : null;
        if (!current) return res.status(404).json({ success: false, error: 'No such expense.' });
        const amount = body.amount === undefined ? current.amount : readAmount(body.amount);
        const dueAt = body.due_at === undefined ? current.due_at : readDueAt(body.due_at);
        if (amount === null) return res.status(400).json({ success: false, error: 'Amount must be a whole number of A$ from 0 up.' });
        if (dueAt === null) return res.status(400).json({ success: false, error: 'Due time must be within two months of now.' });
        res.json({ success: true, expense: savingsExpensesRepo.updateExpense(id, req.session.userId, amount, dueAt) });
    } catch (err) {
        console.error('[DB Error] Failed to update savings expense:', err);
        res.status(500).json({ success: false, error: 'Failed to update expense' });
    }
});

router.delete('/my-planets/expenses/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        if (!Number.isInteger(id) || !savingsExpensesRepo.deleteExpense(id, req.session.userId)) {
            return res.status(404).json({ success: false, error: 'No such expense.' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to delete savings expense:', err);
        res.status(500).json({ success: false, error: 'Failed to delete expense' });
    }
});

module.exports = router;
