const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const usersRepo = require('../repositories/users');
const { requireAuth } = require('./_middleware');
const router = express.Router();

// --- 1. LOGIN SYSTEM ---
router.post('/login', (req, res) => {
    const { game_name, password } = req.body;

    // Find the user
    const user = usersRepo.getUserByGameName(game_name);

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_active === 0) return res.status(403).json({ error: 'Account has been deactivated' });

    // Check password
    if (bcrypt.compareSync(password, user.password_hash)) {
        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.gameName = user.game_name;
        return res.json({ success: true, role: user.role });
    } else {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// --- TOOL USER CONTEXT ---
// The Wrapper calls this to figure out who is supposed to be playing.
//
// allianceId (and playerId alongside it) rides along for the battle-report scheduler,
// resolved through the only app_users -> players bridge there is: case-insensitive name
// equality. allianceId is null in TWO genuinely different cases a caller must not conflate:
// the bridge itself failing to match (hub username drifted from the in-game name) vs. the
// bridge matching fine but that player simply has no alliance right now (a brand-new
// round, before anyone's joined one — commonly the first 7-10+ days). bridgeResolved tells
// them apart — it's true as soon as a players row was found, independent of whether that
// row's alliance_id happens to be set. playerId lets a caller fall back to a per-player
// battle search during that gap, instead of having nothing to search by at all.
router.get('/me', requireAuth, (req, res) => {
    let allianceId = null;
    let playerId = null;
    let bridgeResolved = false;
    try {
        const row = usersRepo.getUserAllianceIdBridge(req.session.userId);
        if (row) {
            bridgeResolved = true;
            playerId = row.player_id;
            if (row.alliance_id != null) allianceId = row.alliance_id;
        }
    } catch (err) {
        // Purely additive field: a broken bridge must never break /me itself.
        console.error('[Auth] allianceId resolution failed:', err.message);
    }
    res.json({
        id: req.session.userId,
        gameName: req.session.gameName,
        bridgeResolved,
        role: req.session.role,
        allianceId,
        playerId
    });
});

// --- DISCORD LINK CODE ---
// The Hub half of the account-linking challenge. The caller is already authenticated
// here, which is exactly the proof `!link <name>` never had: it took a name and bound
// whoever typed it, so anyone could claim any unlinked account.
//
// The code is minted here and spent in Discord, so completing a link requires holding
// both sides. Single use, ten minutes, and any older unused codes for this account are
// dropped so only the newest one works.
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1 — these get read aloud

router.post('/link-code', requireAuth, (req, res) => {
    try {
        const me = usersRepo.getUserById(req.session.userId);
        if (!me) return res.status(404).json({ error: 'Account not found' });
        if (me.discord_id) {
            return res.json({
                success: true,
                alreadyLinked: true,
                discordName: me.discord_name || null,
                message: 'This account is already linked to a Discord user. An admin has to clear it before it can be moved.'
            });
        }

        const bytes = crypto.randomBytes(8);
        let code = '';
        for (const b of bytes) code += LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length];

        const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
        db.transaction(() => {
            usersRepo.deleteUnusedLinkCodesForUser(me.id);
            usersRepo.deleteExpiredLinkCodes();
            usersRepo.mintLinkCode(code, me.id, expiresAt);
        })();

        res.json({
            success: true,
            alreadyLinked: false,
            code,
            expiresAt,
            expiresInSeconds: Math.round(LINK_CODE_TTL_MS / 1000),
            command: `!link ${code}`
        });
    } catch (err) {
        console.error('[Auth] Could not mint a Discord link code:', err);
        res.status(500).json({ error: 'Could not generate a link code' });
    }
});

// --- THE SPY TRAP NUKE ---
// Triggered by the Wrapper if a name mismatch is detected
router.post('/nuke', requireAuth, (req, res) => {
    const { detectedName } = req.body;
    const toolName = req.session.gameName;
    const userId = req.session.userId;
    const role = req.session.role;

    // 1. Admin Immunity Check
    if (role === 'admin' || toolName.toLowerCase() === 'admin') {
        console.log(`[Admin Override] Name mismatch ignored for Admin '${toolName}'.`);
        return res.json({ success: true, bypassed: true });
    }

    // 2. Test Environment Bypass
    if (process.env.NODE_ENV === 'development' || process.env.IS_TEST_SERVER === 'true') {
        console.log(`[Test Mode] Bypassing ban for tool account: '${toolName}'.`);
        return res.json({ success: true, bypassed: true });
    }

    console.error(`\n[!!! CRITICAL SECURITY ALERT !!!]`);
    console.error(`Tool Account '${toolName}' was caught sharing credentials.`);
    console.error(`In-Game Player detected: '${detectedName}'`);
    console.error(`Action: PERMANENT BAN EXECUTED.\n`);

    // Ban the account
    usersRepo.banUser(userId);

    // Destroy their session
    req.session.destroy();

    // Explicitly tell the front-end that a ban occurred
    res.json({ success: true, banned: true });
});

module.exports = router;
