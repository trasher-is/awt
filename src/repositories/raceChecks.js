// All request transitions and budget reservations are synchronous IMMEDIATE transactions.
// The ledger intentionally survives reset. Unknown spend retains its full reservation.
function createRepository(db, { now = () => new Date() } = {}) {
    const stamp = () => now().toISOString();
    const today = () => stamp().slice(0, 10);
    const getRequest = id => db.prepare('SELECT * FROM llm_requests WHERE id=?').get(id);
    const getCheck = playerId => {
        const row = db.prepare('SELECT * FROM player_race_checks WHERE player_id=?').get(playerId);
        if (!row) return null;
        try { return { ...row, output: JSON.parse(row.output) }; } catch (_) { return null; }
    };
    const userRole = userId => db.prepare('SELECT role FROM app_users WHERE id=?').get(userId)?.role;
    const requestTx = db.transaction((playerId, userId, direct) => {
        if (!db.prepare('SELECT id FROM players WHERE id=?').get(playerId)) return { error: 'not_found' };
        const role = userRole(userId);
        if (direct ? role !== 'admin' : !['user', 'admin'].includes(role)) return { error: 'forbidden' };
        const previous = db.prepare("SELECT * FROM llm_requests WHERE player_id=? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 1").get(playerId);
        if (previous) return direct && previous.status !== 'approved'
            ? { error: 'already_requested', request: previous } : { request: previous };
        const result = db.prepare(`INSERT INTO llm_requests
            (player_id,requested_by,status,approved_by,created_at,decided_at) VALUES (?,?,?,?,?,?)`)
            .run(playerId, userId, direct ? 'approved' : 'pending', direct ? userId : null, stamp(), direct ? stamp() : null);
        return { request: getRequest(Number(result.lastInsertRowid)) };
    });
    const decideTx = db.transaction((id, adminId, decision) => {
        if (userRole(adminId) !== 'admin') return { error: 'forbidden' };
        const row = getRequest(id);
        if (!row) return { error: 'not_found' };
        if (row.status !== 'pending') return { error: 'already_decided' };
        db.prepare('UPDATE llm_requests SET status=?,approved_by=?,decided_at=? WHERE id=?')
            .run(decision, adminId, stamp(), id);
        return { request: getRequest(id) };
    });
    const reserveTx = db.transaction((requestId, userId, inputHash, model, reservation, budget) => {
        // A terminated process cannot settle usage. Retain its worst-case charge,
        // fail its request and unlock the provider after twice the client timeout.
        const abandoned = db.prepare("SELECT id,request_id FROM llm_calls WHERE status='reserved' AND created_at<?")
            .all(new Date(now().getTime() - 120000).toISOString());
        for (const call of abandoned) {
            db.prepare("UPDATE llm_calls SET status='failed',error='interrupted_without_usage' WHERE id=?").run(call.id);
            db.prepare("UPDATE llm_requests SET status='failed' WHERE id=? AND status='approved'").run(call.request_id);
        }
        const request = getRequest(requestId);
        if (!request) return { error: 'not_found' };
        if (request.status !== 'approved' || userRole(userId) !== 'admin') return { error: 'not_approved' };
        const existing = db.prepare("SELECT id FROM llm_calls WHERE request_id=? AND status='reserved'").get(requestId);
        if (existing) return { error: 'already_running' };
        const held = getCheck(request.player_id);
        if (held?.status === 'ok' && held.verdict === 'disagrees' && !held.resolved_by) return { error: 'held_requires_resolution' };
        // A separate provider gate. It never borrows the game's agreed traffic budget.
        if (db.prepare("SELECT id FROM llm_calls WHERE status='reserved' LIMIT 1").get()) return { error: 'provider_busy' };
        const last = db.prepare('SELECT created_at FROM llm_calls ORDER BY id DESC LIMIT 1').get();
        if (last && now().getTime() - Date.parse(last.created_at) < 1000) return { error: 'provider_rate_limit' };
        const spent = db.prepare('SELECT COALESCE(SUM(cost_usd),0) total FROM llm_calls WHERE substr(created_at,1,10)=?').get(today()).total;
        if (spent + reservation > budget + 1e-12) return { error: 'budget_exhausted' };
        const row = db.prepare(`INSERT INTO llm_calls (request_id,model,cost_usd,status,input_hash,created_at)
            VALUES (?,?,?,'reserved',?,?)`).run(requestId, model, reservation, inputHash, stamp());
        return { callId: Number(row.lastInsertRowid), request };
    });
    const finishTx = db.transaction((callId, result) => {
        const call = db.prepare('SELECT * FROM llm_calls WHERE id=?').get(callId);
        if (!call || call.status !== 'reserved') return { error: 'already_finished' };
        db.prepare(`UPDATE llm_calls SET input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,
            cost_usd=?,latency_ms=?,status=?,error=? WHERE id=?`)
            .run(result.usage?.input ?? null, result.usage?.output ?? null, result.usage?.read ?? null,
                result.usage?.write ?? null, result.cost ?? call.cost_usd, result.latency,
                result.error ? 'failed' : 'ok', result.error || null, callId);
        // A round reset can happen during the await. Never recreate its removed intel.
        const request = getRequest(call.request_id);
        if (!request || request.status !== 'approved') return { error: 'request_expired' };
        if (result.check) {
            const check = result.check;
            db.prepare(`INSERT INTO player_race_checks
                (player_id,request_id,input_hash,model_version,prompt_version,model,verdict,output,status,resolved_by,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(player_id) DO UPDATE SET
                request_id=excluded.request_id,input_hash=excluded.input_hash,model_version=excluded.model_version,
                prompt_version=excluded.prompt_version,model=excluded.model,verdict=excluded.verdict,
                output=excluded.output,status=excluded.status,resolved_by=NULL,created_at=excluded.created_at`)
                .run(request.player_id, request.id, call.input_hash, check.modelVersion, check.promptVersion,
                    call.model, check.verdict, JSON.stringify(check.output), check.status, stamp());
        }
        db.prepare('UPDATE llm_requests SET status=? WHERE id=?').run(result.error ? 'failed' : 'done', request.id);
        return { request: getRequest(request.id), check: getCheck(request.player_id) };
    });
    const resolveTx = db.transaction((playerId, adminId, decision) => {
        if (userRole(adminId) !== 'admin') return { error: 'forbidden' };
        if (!['release', 'keep'].includes(decision)) return { error: 'invalid_resolution' };
        const check = getCheck(playerId);
        if (!check || check.status !== 'ok' || check.verdict !== 'disagrees') return { error: 'not_held' };
        if (decision === 'release') db.prepare('UPDATE player_race_checks SET resolved_by=? WHERE player_id=?').run(adminId, playerId);
        return { decision, check: getCheck(playerId) };
    });
    return { userRole, getRequest, getCheck,
        request: (playerId, userId, direct = false) => requestTx.immediate(playerId, userId, direct),
        decide: (id, adminId, decision) => decideTx.immediate(id, adminId, decision),
        reserve: (...args) => reserveTx.immediate(...args), finish: (...args) => finishTx.immediate(...args),
        resolve: (playerId, adminId, decision = 'release') => resolveTx.immediate(playerId, adminId, decision),
        failRequest(id) { db.prepare("UPDATE llm_requests SET status='failed' WHERE id=? AND status='approved'").run(id); },
        queue() { return db.prepare("SELECT * FROM llm_requests WHERE status IN ('pending','approved') ORDER BY created_at,id").all(); },
        usage() {
            const days = db.prepare(`SELECT substr(created_at,1,10) day,COUNT(*) calls,
                COALESCE(SUM(cost_usd),0) cost_usd,SUM(status='reserved') reservations,
                COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
                COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,COALESCE(SUM(cache_write_tokens),0) cache_write_tokens
                FROM llm_calls GROUP BY day ORDER BY day DESC LIMIT 31`).all();
            return { today: days.find(row => row.day === today()) || { day: today(), calls: 0, cost_usd: 0, reservations: 0 }, days };
        } };
}
let repository;
const defaultRepo = () => repository ||= createRepository(require('../database'));
module.exports = { createRepository };
for (const method of ['userRole', 'getRequest', 'getCheck', 'request', 'decide', 'reserve', 'finish', 'resolve', 'failRequest', 'queue', 'usage']) {
    module.exports[method] = (...args) => defaultRepo()[method](...args);
}
