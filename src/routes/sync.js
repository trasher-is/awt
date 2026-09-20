const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { announceSystemChanges, announceSystemMilestones, sendVariousChangeEmbed } = require('../discord_bot');
const { friendlyAllianceTags, ownAllianceTags } = require('../utils/friendly-alliance-tags');
const { parseSqliteUtc } = require('../../public/js/utils/sqlite-time.js');
const { decideIntelVisibilityChange } = require('../utils/intel-visibility');

// Best Guarded / various-changes: "close by" means within this many straight-line systems
// of friendly territory (2026-09-12 — a flat radius, not per-player biology).
const BEST_GUARDED_AREA_RADIUS = 6;
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const playersRepo = require('../repositories/players');
const alliancesRepo = require('../repositories/alliances');
const settingsRepo = require('../repositories/settings');
const { mapApiReport, upsertReports, formatBattleEmbed } = require('../utils/battle-reports');
const battleReportsRepo = require('../repositories/battleReports');
const newsEventsRepo = require('../repositories/newsEvents');
const { resolveBombardmentCredit } = require('../utils/news-battle-matching');
const battlePointsRepo = require('../repositories/battlePoints');
const bonusGoalsRepo = require('../repositories/bonusGoals');
const { postEmbed, postBattleEmbed, defuseMentions, settingValue } = require('../utils/discord-post');
const { ownerChangeKind } = require('../utils/system-change-lines');
const router = express.Router();

// Attribution uses reports after the previous planet sync, capped at three hours.
// A scan only observes a population loss; the repository requires positive evidence
// for the same victim and one unambiguous attacker before naming anyone.
const POP_DROP_ATTACKER_WINDOW_MINUTES = 180;

// Confirmed live (2026-09-12f): the game's own regrowth rate is roughly 6-12h per
// population point, so a same-owner population figure that's HIGHER than last observed,
// sooner than this could plausibly explain, is far more likely a stale/inconsistent read
// than real growth — see the guard below, where this is used.
const MIN_HOURS_PER_POP_POINT_REGROWN = 4;

// A capture stamp is only useful if we can turn it into an instant we trust. The game's own
// stamps are plain ISO with an offset ("2026-09-13T00:00:00+02:00" — midnight at the daily
// reset, confirmed live), which parseSqliteUtc takes as-is; the engine parser behind it is
// only a fallback for a shape neither of us has seen yet. Anything landing implausibly far
// from now is a MISPARSE, not a real observation — a locale-flipped day/month, or a bare
// time read as year zero — and ordering by it would be worse than not ordering at all, so
// it is refused rather than trusted.
// Absent must stay absent. Number(null) and Number('') are both 0, and 0 is a perfectly real
// map coordinate, so coercing an absent value silently claims a position at the origin of
// the grid instead of admitting there isn't one.
function coordinateOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

const MAX_CAPTURE_SKEW_MS = 365 * 24 * 60 * 60 * 1000;
function parseObservationTime(value) {
    if (!value) return null;
    let parsed = parseSqliteUtc(value);
    if (!parsed) {
        const ms = Date.parse(value);
        parsed = Number.isFinite(ms) ? new Date(ms) : null;
    }
    if (!parsed) return null;
    return Math.abs(parsed.getTime() - Date.now()) > MAX_CAPTURE_SKEW_MS ? null : parsed;
}

// --- MAP SCRAPER DATA RECEIVER ---
router.post('/sync/system', requireAuth, (req, res) => {
    const { system_id, planets, fleets, captured_at, observation_live, fleets_observed } = req.body;
    // Every detected change announces to Discord now (2026-09-12) — including from the
    // bulk galaxy auto-seed, which used to pass scan_mode: 'silent' to suppress this. That
    // guard is gone: event detection below only ever fires on a genuine transition against
    // a REAL prior observation (oldP must exist, and vision_uncertain data is excluded), so
    // there was never an actual flood risk from a bulk seed — a system with no real change
    // simply produces no event, seeded or not. Silencing it just meant a conquest or
    // pop-kill caught by the auto-seed announced nowhere at all.

    if (!system_id || !Array.isArray(planets)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    // STALE-OBSERVATION GUARD (2026-09-13): several members' tabs each sync the whole
    // galaxy every few minutes, independently, each from their OWN account's viewpoint —
    // and the game's Map/sectors response carries its own capturedAt per system, which is
    // how old THAT account's picture is. Without an ordering key this was last-write-wins,
    // so a member whose capture was an hour stale kept overwriting a fresher one and the
    // two ping-ponged forever: confirmed live on Ain #8 planet 12, alternating Free/pop-0
    // and owned/pop-1 every five minutes, logging an identical population-drop event (and
    // Discord alert) on each flip, indefinitely. A payload whose capture predates the
    // newest one already applied teaches us nothing and is dropped whole. A live DOM scrape
    // sends no captured_at at all — you cannot render a system page without vision of it,
    // so it is always "now" and always wins.
    //
    // An unreadable captured_at must NEVER cost us the payload (2026-09-13b): this first
    // rejected the whole sync with a 400, and because the game stamps its captures in a
    // format parseSqliteUtc does not accept, that silently blacklisted 274 of 381 systems —
    // the hub went blind to most of the galaxy while reporting success on the rest. An
    // optional ordering hint is not worth a single planet of intel. When it cannot be read,
    // the sync proceeds unordered, exactly as it did before this guard existed.
    //
    // THREE cases, and conflating any two of them breaks this (2026-09-13c):
    //   • captured_at set     — the game handed this account a CACHED picture and said how
    //                           old it is (always the daily reset, e.g. midnight +02:00).
    //   • observation_live    — the caller genuinely saw this system just now: a member with
    //                           vision of it, or a rendered system page. Stamped with the
    //                           SERVER's clock, not the browser's, so one member's wrong
    //                           system clock cannot outrank everybody else forever.
    //   • neither             — an older build that predates this field. Unordered: it
    //                           applies, but must never set the watermark.
    // The same system is live for one member and a midnight cache for another, so "live"
    // has to outrank a real stamp rather than being absent from the ordering: otherwise the
    // stale reader's midnight picture overwrites the live one every cycle, which is the
    // flip-flop this exists to stop, merely running in the other direction. And "neither"
    // cannot be treated as live, or an old build's payload manufactures a watermark newer
    // than any real capture and locks out the clients doing the right thing — confirmed
    // live, that is exactly what happened.
    const observedAt = captured_at
        ? parseObservationTime(captured_at)
        : (observation_live ? new Date() : null);
    const observedAtIso = observedAt ? observedAt.toISOString() : null;
    if (observedAtIso) {
        const applied = systemsRepo.getSystemObservedAt(system_id);
        if (applied && observedAtIso <= applied) {
            return res.json({ success: true, skipped: 'stale_observation', captured_at, applied });
        }
    }

    systemsRepo.upsertSystemStub(system_id);

    // Collect human-readable events for the Discord announcer (only used during a galaxy scan)
    const announceEvents = [];
    const nameOf = (id) => {
        if (!id) return null;
        const row = playersRepo.getPlayerNameWithTag(id);
        if (!row) return `#${id}`;
        return row.alliance_tag ? `[${row.alliance_tag}] ${row.name}` : row.name;
    };
    const tagOf = (id) => {
        if (!id) return null;
        const row = playersRepo.getPlayerNameWithTag(id);
        return row ? row.alliance_tag : null;
    };
    // Various Changes: possible friendly-fire/NAP violation (2026-09-12) — real damage
    // only (a conquest, or a bombardment with a confidently matched attacker), not just
    // any battle report existing between two friendlies: routine XP-farming duels between
    // allies/alliance-mates don't actually take territory or kill population, so gating on
    // real loss keeps this from firing on ordinary sparring.
    const friendlyTagsForFireCheck = new Set([...friendlyAllianceTags()].map(t => String(t).toUpperCase()));
    const isFriendlyTag = (tag) => !!tag && friendlyTagsForFireCheck.has(String(tag).toUpperCase());
    const flagPossibleFriendlyFire = (victimTag, attackerTag, description) => {
        if (isFriendlyTag(victimTag) && isFriendlyTag(attackerTag)) {
            sendVariousChangeEmbed('⚠️ Possible friendly-fire / NAP violation', description).catch(err =>
                console.error('[Discord] friendly-fire various-changes announce error:', err.message)
            );
        }
    };

    const syncTransaction = db.transaction((planetsData, fleetsData, ownMemberIds, fleetsObserved) => {

        // 1. Process Planets, Owners, and History
        for (const p of planetsData) {

            // Server-side guard: never store impossible planet ids / indices, no matter
            // what a (possibly mobile / hub-modified) client sends.
            if (p.game_planet_id != null && (!Number.isInteger(p.game_planet_id) || p.game_planet_id <= 0)) continue;
            if (!Number.isInteger(p.planet_index) || p.planet_index < 1 || p.planet_index > 99) continue;

            // Check for history events BEFORE upserting
            const oldP = systemsRepo.getOldPlanet(system_id, p.planet_index);

            let finalOwnerId = p.owner ? p.owner.id : null;
            let finalPopulation = p.population;
            let finalStarbase = p.starbase;
            // has_fleet: DOM scrapers send an explicit 0/1; the API-sourced payload cannot
            // see fleets at all and sends null. Absent means "this payload cannot see fleet
            // state", so keep the last observation rather than nulling out a scraped marker.
            let finalHasFleet = (p.has_fleet === undefined || p.has_fleet === null)
                ? (oldP ? oldP.has_fleet : null)
                : p.has_fleet;
            // is_sieged arrives from either the API-sourced sync path (the game's hasSiege
            // flag — a bare boolean, no attacker identity) or, since 2026-09-12b, the DOM
            // scraper (system-parser.js), which additionally knows whether the besieger is
            // friendly or hostile and their name (see siege-indicator-parser.js) — you
            // cannot be viewing a live system page without vision of it, so that's always
            // trustworthy. Absent means "this payload cannot see siege state", so keep
            // whatever we knew rather than zeroing it out.
            let finalIsSieged = (p.is_sieged === undefined || p.is_sieged === null)
                ? (oldP ? oldP.is_sieged : 0)
                : (p.is_sieged ? 1 : 0);
            // WHOSE siege (2026-09-13): the API's hasSiege is ALSO true for a friendly fleet
            // in orbit — confirmed live, an allied transit arriving at a RAID planet flipped
            // it on and the bot announced "under siege" at its own alliance. Only the live
            // DOM distinguishes the two, so its verdict is remembered here rather than used
            // once and discarded; an API-only sync leaves whatever the DOM last established
            // alone instead of overwriting it with a guess. Cleared when the siege lifts, so
            // the NEXT siege on this planet starts out unknown again rather than inheriting
            // the last one's allegiance.
            let finalSiegeIsFriendly = (p.siege_is_friendly === true || p.siege_is_friendly === false)
                ? (p.siege_is_friendly ? 1 : 0)
                : (oldP ? oldP.siege_is_friendly : null);
            if (!finalIsSieged) finalSiegeIsFriendly = null;

            // CRITICAL FOG OF WAR GUARD: protects historical stats from being nuked by a
            // payload the hub cannot currently trust. Gated on vision_uncertain, NOT
            // is_unknown (2026-09-02 fix — see api-galaxy-seed.js's comment): the two used to
            // be conflated, which meant a REAL "Unknown" owner (a resigned player's leftover
            // planet, or a game-spawned Unknown — see docs/game-rules.md's Colonizing
            // section) got silently frozen at whatever stale data the hub had, forever,
            // because visiting the system kept reporting is_unknown:true (correctly — it
            // really is Unknown) and this guard kept refusing to believe it. is_unknown is
            // only ever reported for a page/response the caller genuinely has in front of
            // them (live DOM, or a live single-system API call), so it is always trustworthy
            // on its own; vision_uncertain is the actual "this snapshot may not reflect
            // reality" signal (only ever set by the out-of-vision/stale branch of the bulk
            // galaxy seed). When there's no prior row (oldP is null — a never-seen-before
            // planet), there is nothing to fall back to, so fields fall back to their current
            // "no observation" defaults instead — crucially, ownership falls back to NULL
            // rather than trusting p.owner.id: an out-of-vision seed can carry an owner from
            // the API's cached snapshot for a player the hub has never seen (no players row
            // was created for them, since the upsert below also skips creating one when
            // vision_uncertain is true). Inserting a planets row with owner_id pointing at a
            // nonexistent player trips the FOREIGN KEY(owner_id) REFERENCES players(id)
            // constraint and rolls back the WHOLE system's transaction, not just this planet.
            // NOTE: updated_at below still stamps CURRENT_TIMESTAMP even when the guard
            // preserves stale values — it reflects "last synced", not "last confirmed fresh".
            // is_in_vision (systems table) is the actual freshness signal, not updated_at.
            if (p.vision_uncertain) {
                finalOwnerId = oldP ? oldP.owner_id : null;
                finalPopulation = oldP ? oldP.population : finalPopulation;
                finalStarbase = oldP ? oldP.starbase : finalStarbase;
                finalHasFleet = oldP ? oldP.has_fleet : finalHasFleet;
                finalIsSieged = oldP ? oldP.is_sieged : finalIsSieged;
                finalSiegeIsFriendly = oldP ? oldP.siege_is_friendly : finalSiegeIsFriendly;
            }

            // SOFT-UNKNOWN GUARD: a scan can fail to pick up the owner link while the
            // planet is clearly still inhabited (population > 0). Treat that like fog of
            // war — keep the last known owner instead of nulling it. Without this, the
            // owner gets wiped, the next scan re-detects it, and we log a bogus
            // "NULL → owner" event every cycle (destroying real history). Only let
            // ownership clear to NULL when the planet is genuinely empty (pop 0).
            if (!p.is_unknown && finalOwnerId == null && finalPopulation > 0 && oldP && oldP.owner_id != null) {
                finalOwnerId = oldP.owner_id;
            }

            // POPULATION REGROWTH SANITY GUARD (2026-09-12f): confirmed live — a planet's
            // population bouncing back UP between two real observations (a differently-
            // sourced sync, still claiming in-vision, handing back a stale higher cached
            // number) got treated as a genuine increase, silently undoing a real drop until
            // the next fresh read caught it "dropping" again — logging and announcing an
            // IDENTICAL population-drop event every single auto-seed tick. Confirmed in
            // planet_events: the exact same "6 -> 5" logged five times, exactly 5 minutes
            // apart (the auto-seed interval). Same-owner population reported higher than
            // last observed, sooner than natural regrowth could explain, is distrusted and
            // the last known (lower) value is kept instead. Doesn't touch an owner change —
            // that wipes/replaces population through a completely different branch below,
            // never diffed against the previous owner's number.
            //
            // Timed off population_observed_at, NOT updated_at (2026-09-14 fix): updated_at
            // advances on every sync regardless of whether this guard accepts or rejects the
            // value, so timing off it made a single false-positive rejection PERMANENT — the
            // very next scan (often minutes later, via the live-scan-on-launch-form-select
            // or the auto-seed) saw an equally-tiny "hours since last update" and rejected
            // again, forever, even though the real population kept climbing. Confirmed live:
            // system 41 #7 stuck reporting population 1 while the DOM plainly showed 3, and
            // re-stuck within a minute of every fresh scan. population_observed_at only
            // moves when a value is actually accepted (see systems.js's upsertPlanetStmt),
            // so a rejection now correctly leaves the guard's own clock right where it was.
            if (oldP && finalOwnerId === oldP.owner_id
                && Number.isFinite(finalPopulation) && Number.isFinite(oldP.population)
                && finalPopulation > oldP.population) {
                const lastPopObserved = parseSqliteUtc(oldP.population_observed_at);
                const hoursSinceLastPopObserved = lastPopObserved ? (Date.now() - lastPopObserved.getTime()) / 3600000 : Infinity;
                const pointsGained = finalPopulation - oldP.population;
                if (hoursSinceLastPopObserved < pointsGained * MIN_HOURS_PER_POP_POINT_REGROWN) {
                    finalPopulation = oldP.population;
                }
            }

            if (oldP && !p.vision_uncertain) {
                // Skip all event creation on genuinely uncertain (out-of-vision/stale) scans
                // only — a real transition TO or FROM the game's own "Unknown" owner state
                // (is_unknown) is real history and must be logged like any other change.
                const ownerChanged = oldP.owner_id !== finalOwnerId;
                const oldPop = Number(oldP.population);
                const newPop = Number(finalPopulation);
                const oldOwnerLabel = nameOf(oldP.owner_id);
                const newOwnerLabel = p.owner
                    ? (p.owner.alliance_tag ? `[${p.owner.alliance_tag}] ${p.owner.name}` : p.owner.name)
                    : nameOf(finalOwnerId);

                if (ownerChanged) {
                    systemsRepo.logPlanetEvent(system_id, p.planet_index, 1, oldP.owner_id, finalOwnerId); // 1 = OWNER_CHANGE (history)
                    // Issue #156: every owner change is announced WITH attribution — who
                    // conquered it from whom, that it was lost to Empty/Unknown, or that a
                    // free planet / an Unknown planet's leftover population was colonized,
                    // and by whom (the wording is in src/utils/system-change-lines.js).
                    // "Empty -> owner" used to be skipped as low-value and as a flood risk
                    // while the planets table healed from the old null-purge corruption;
                    // the maintainer now asks for every colonization, so it announces too.
                    announceEvents.push({
                        planet_index: p.planet_index,
                        type: 'OWNER_CHANGE',
                        kind: ownerChangeKind({ oldOwnerId: oldP.owner_id, newOwnerId: finalOwnerId, isUnknown: !!p.is_unknown, oldPop }),
                        old_owner: oldOwnerLabel,
                        new_owner: newOwnerLabel,
                        // Raw tag (not the "[TAG] Name" label above) so the per-system
                        // milestone router can tell a friendly takeover from an enemy one
                        // without re-parsing a formatted string — see
                        // announceSystemMilestones's "enemy entered via conquest" check.
                        new_owner_alliance_tag: p.owner ? (p.owner.alliance_tag || null) : null,
                        old_pop: Number.isFinite(oldPop) ? oldPop : null
                    });

                    flagPossibleFriendlyFire(tagOf(oldP.owner_id), p.owner ? p.owner.alliance_tag : null,
                        `🪐 **Planet ${p.planet_index}** in system #${system_id}: ${newOwnerLabel} took it from ${oldOwnerLabel} — both are friendly tags.`);
                }

                // SIEGE_STARTED (2026-09-12): a hostile fleet actively attacking. The 0->1
                // transition is a stronger, earlier "enemy entered" signal than waiting for
                // a conquest to complete. Routed only to the per-system Discord channel
                // (announceSystemMilestones) — not the main System Change/Population Drop
                // channels, which are about completed changes, not attacks in progress.
                // The raw owner tag rides along (not just the formatted label) so the
                // milestone router can tell "our planet just got besieged" (alarm-worthy)
                // apart from a siege on an enemy/unowned/unaffiliated planet — us besieging
                // THEM, or two other parties fighting — which isn't an "enemy entered"
                // event for us at all (2026-09-12 fix: this used to fire for every siege in
                // a watched system regardless of who owned the planet).
                // 2026-09-13: this used to fire on the raw is_sieged 0->1 edge, assuming any
                // fresh siege on a friendly planet had to be hostile. It does not: the API's
                // hasSiege is true for a friendly fleet in orbit too, and the bot duly
                // announced an allied transit as an enemy attack on its own alliance's
                // planet. So the edge that matters is "we now KNOW an enemy is besieging
                // this", which only the live DOM can establish. That also means a siege
                // first seen through the API (allegiance unknown) still alerts later, at the
                // moment a DOM scrape confirms it hostile — rather than being lost because
                // is_sieged was already 1 by then and the old edge never fired again.
                const wasConfirmedEnemySiege = !!(oldP.is_sieged && oldP.siege_is_friendly === 0);
                const isConfirmedEnemySiege = !!(finalIsSieged && finalSiegeIsFriendly === 0);
                if (!wasConfirmedEnemySiege && isConfirmedEnemySiege) {
                    announceEvents.push({
                        planet_index: p.planet_index,
                        type: 'SIEGE_STARTED',
                        owner: oldOwnerLabel,
                        owner_alliance_tag: tagOf(oldP.owner_id),
                        attacker_name: p.siege_attacker_name || null,
                    });
                }

                // POP DROP — logged on every population loss, owner change or not (it feeds
                // the !mortal population-killed leaderboard via /sync/news, which credits a
                // 'battle-conquer' news row against the closest POP_DROP row for the planet).
                //
                // Issue #156 — the math differs by case:
                //   • TAKEN BY A NEW OWNER: the previous owner's population is wiped to 0 the moment
                //     the planet is taken (conquest, or colonizing an Unknown planet's
                //     leftover people). Whatever population the NEW owner shows by the time
                //     this scan catches it is their own growth since, and must not be diffed
                //     against the old owner's number — "3 -> 2, dropped 1" was wrong; the
                //     truth is "3 -> 0, wiped 3". Logged as oldPop -> 0, credited to the new
                //     owner. An owner change with 0 previous population (a free planet) is
                //     not a population event at all.
                //   • OWNER CLEARED / SAME OWNER: only an observed decrease is a loss. A
                //     resignation can leave all inhabitants alive on an Unknown planet.
                //     A same-owner loss can be attributed when synced battle reports give
                //     reliable, unambiguous evidence; ownership clearing alone proves no attack.
                if (Number.isFinite(oldPop) && Number.isFinite(newPop)) {
                    if (ownerChanged && finalOwnerId != null && oldPop > 0) {
                        systemsRepo.logPlanetEvent(system_id, p.planet_index, 2, oldPop, 0); // 2 = POP_DROP
                        announceEvents.push({
                            planet_index: p.planet_index,
                            type: 'POP_DROP',
                            kind: oldP.owner_id != null ? 'conquest' : 'colonization',
                            old_pop: oldPop,
                            new_pop: 0,
                            victim: oldOwnerLabel,
                            by: newOwnerLabel
                        });
                    } else if (newPop < oldPop) {
                        systemsRepo.logPlanetEvent(system_id, p.planet_index, 2, oldPop, newPop); // 2 = POP_DROP
                        // updated_at also advances on uncertain/fog syncs. It is a
                        // conservative lower bound, not proof of a fresh observation:
                        // if it excludes a real battle, leave attribution unknown.
                        const battle = !ownerChanged && battleReportsRepo.findRecentAttackerAtPlanet(
                            system_id, p.planet_index, POP_DROP_ATTACKER_WINDOW_MINUTES,
                            { defenderId: oldP.owner_id, observedAfter: oldP.updated_at, observedLoss: oldPop - newPop }
                        );
                        announceEvents.push({
                            planet_index: p.planet_index,
                            type: 'POP_DROP',
                            kind: ownerChanged ? 'population_loss' : 'bombardment',
                            old_pop: oldPop,
                            new_pop: newPop,
                            owner: oldOwnerLabel,
                            attacker: battle && battle.att_player_name
                                ? (battle.att_alliance_tag ? `[${battle.att_alliance_tag}] ${battle.att_player_name}` : battle.att_player_name)
                                : null
                        });

                        if (battle && battle.att_player_name) {
                            const attackerLabel = battle.att_alliance_tag ? `[${battle.att_alliance_tag}] ${battle.att_player_name}` : battle.att_player_name;
                            flagPossibleFriendlyFire(tagOf(oldP.owner_id), battle.att_alliance_tag,
                                `🪐 **Planet ${p.planet_index}** in system #${system_id}: ${attackerLabel} bombarded ${oldOwnerLabel}, killing ${oldPop - newPop} population — both are friendly tags.`);
                        }
                    }
                }
            }

            // Standard Upsert (Skip structural updates for players/alliances if we can't see them clearly)
            if (p.owner && !p.vision_uncertain) {
                // A system scan only ever sees the tag, so it seeds `name` from the tag and
                // leaves name alone on conflict (the alliance-profile sync owns the real
                // name). `?? ''` because alliances.name is NOT NULL and a tag can be absent.
                if (p.owner.alliance_id) alliancesRepo.upsertAllianceBasic(p.owner.alliance_id, p.owner.alliance_tag ?? null, p.owner.alliance_tag ?? '');
                playersRepo.recordNameChangeIfDifferent(p.owner.id, typeof p.owner.name === 'string' ? p.owner.name : null);
                playersRepo.upsertPlayerBasic(p.owner.id, p.owner.name, p.owner.alliance_id || null);
            }

            // Pass the calculated final parameters securely down to the table updater.
            // Re-home the planet if its id currently lives at another slot (avoids the
            // game_planet_id UNIQUE collision that would otherwise roll back the system).
            if (p.game_planet_id != null) {
                systemsRepo.clearMovedPlanet(p.game_planet_id, system_id, p.planet_index);
            }
            systemsRepo.upsertPlanet(
                p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation,
                finalStarbase, finalHasFleet, finalIsSieged,
                typeof p.name === 'string' ? p.name : null,
                finalSiegeIsFriendly
            );
        }

        // OUR OWN fleet positions are still not derived from system scans — they are
        // sourced exclusively from the alliance scan (each member's own alliance page
        // lists their stationed fleets), which gives complete, self-cleaning coverage
        // including offline members, instead of whatever happened to be visible in
        // whichever system someone last browsed. See /sync/alliance-stats.
        //
        // ENEMY fleets, though, have no alliance-page equivalent — a live system-map DOM
        // view is the ONLY source of that intel there is, and until 2026-09-14 it was
        // discarded entirely: confirmed live, a hostile inbound fleet plainly visible on
        // the page (system 41 #1, Starius) never showed up anywhere in the hub, including
        // the fleet-launch target dossier this exact page feeds. ownMemberIds excludes our
        // own alliance so this can never step on the alliance-scan's authoritative rows —
        // by construction the two writers can never share an owner_id.
        //
        // Gated on fleetsObserved (2026-09-14), NOT just "fleetsData is non-empty": the
        // API-sourced galaxy seed always sends fleets: [] — it has no fleet visibility at
        // all, not "zero fleets seen" — and that seed runs every few minutes in the
        // background. Treating an empty-because-API array as authoritative would wipe out
        // a real DOM sighting within minutes of it being captured. See
        // system-parser.js's own comment on fleets_observed.
        if (fleetsObserved) {
            const ownIdSet = new Set(ownMemberIds);
            const enemyFleets = fleetsData.filter(f =>
                Number.isInteger(f.owner_id) && !ownIdSet.has(f.owner_id)
                // A fleet whose owner we've never stored as a player would trip the
                // FOREIGN KEY on fleets.owner_id and roll back this ENTIRE transaction —
                // planet updates included — for the sake of one fleet row. Skip it
                // instead; it's self-healing the moment that owner is seen anywhere else
                // (they usually own a planet in the same payload this scan already
                // processed above).
                && playersRepo.playerExistsById(f.owner_id)
                && Number.isInteger(f.planet_index)
            );
            fleetsRepo.replaceEnemyFleetsForSystem(system_id, enemyFleets, ownMemberIds);
        }
    });

    try {
        const ownMemberIds = fleetsRepo.getMemberIdsForTags([...ownAllianceTags()]);
        syncTransaction(planets, fleets || [], ownMemberIds, !!fleets_observed);
        // Applied — this is now the newest observation of this system, and anything captured
        // before it is stale (see the stale-observation guard above).
        systemsRepo.advanceSystemObservedAt(system_id, observedAtIso);

        const sys = systemsRepo.getSystemCoords(system_id) || { id: system_id };

        // "Secured" is recomputed on EVERY sync of this system, not only when something
        // announceable changed (2026-09-12g fix). Gating it on announceEvents.length was
        // wrong in both directions, because plenty of real secured/unsecured transitions
        // produce no announceEvents at all: a siege simply ENDING logs nothing, and a
        // system sitting quietly fully-owned never generates another event to ride along
        // with. Confirmed live: Alshemali [42] was genuinely closed (12/12 owned, 8 RAID +
        // 4 NAP, no siege) yet still flagged 0, while three systems that had long since
        // stopped qualifying were still flagged 1 — inflating the "We now hold N fully
        // secured systems" milestone to 3 when the real answer was 1.
        // This is one cheap read over a dozen planet rows, and checkAndUpdateSystemSecured
        // itself only returns non-null on a real 0->1/1->0 transition, so announcing stays
        // exactly once per actual change.
        const secured = systemsRepo.checkAndUpdateSystemSecured(system_id, friendlyAllianceTags(), ownAllianceTags());

        // Announce detected planet events to Discord — both during a full galaxy scan
        // and during normal map browsing.
        if (announceEvents.length > 0) {
            announceSystemChanges(sys, announceEvents).catch(err =>
                console.error('[Discord] announce error:', err.message)
            );
        }

        {
            // Per-system milestone channel (2026-09-12): an "enemy entered"/"system
            // closed" curated feed for whichever channel a member has already created
            // for this system (matched by name, no admin config needed — see
            // announceSystemMilestones).
            const milestoneEvents = secured === 'secured' ? [...announceEvents, { type: 'SYSTEM_SECURED' }] : announceEvents;
            if (milestoneEvents.length > 0) {
                announceSystemMilestones(sys, milestoneEvents).catch(err =>
                    console.error('[Discord] system-milestone announce error:', err.message)
                );
            }

            // Various Changes: alliance-wide secured-systems milestone (2026-09-12) — a
            // DIFFERENT message than the per-system celebration above: that one says
            // "THIS system is secured", this one says how many total the alliance holds.
            // Only worth recomputing when a transition actually happened this sync.
            if (secured === 'secured' || secured === 'lost') {
                const totalSecured = systemsRepo.countSecuredSystems();
                sendVariousChangeEmbed(
                    '🏰 Secured systems',
                    `We now hold **${totalSecured}** fully secured system${totalSecured === 1 ? '' : 's'}.`,
                ).catch(err => console.error('[Discord] secured-systems various-changes announce error:', err.message));
            }
        }

        // siege_unconfirmed tells the bulk seed "there's a siege here the API can't explain"
        // — its cue to spend one DOM page fetch on this system and settle whose it is (see
        // api-galaxy-seed.js). Page fetches are not charged against the game's 200-per-5min
        // API budget, only the shared 5/sec gate, so a confirm-scrape is genuinely cheap.
        res.json({
            success: true,
            synced_count: planets.length,
            siege_unconfirmed: systemsRepo.countUnconfirmedSieges(system_id) > 0,
        });
    } catch (err) {
        console.error(`[DB Error] Failed to sync system ${system_id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- PLAYER PROFILE SCRAPER RECEIVER ---
router.post('/sync/player', requireAuth, (req, res) => {
    const p = req.body;

    if (!p || !p.id || !p.name) {
        return res.status(400).json({ error: 'Invalid player payload: Missing ID or Name' });
    }

    console.log(`\n[API] Incoming profile sync for Player ID: ${p.id} (${p.name}) [Has Intel: ${p.has_intel || 0}]`);

    // A hidden/missing Origin is no observation. Keep the last recorded system below,
    // unless a login-counter reset establishes that the old origin belongs to an old
    // account. Do not coerce booleans, partial numbers or fractions into system ids.
    const originValue = typeof p.origin_system === 'string' && /^\s*\d+\s*$/.test(p.origin_system)
        ? Number(p.origin_system) : p.origin_system;
    const observedOrigin = Number.isSafeInteger(originValue) && originValue > 0 ? originValue : null;

    const safePlayer = {
        id: p.id,
        name: p.name || null,
        alliance_id: p.alliance_id || null,
        alliance_tag: p.alliance_tag || null,
        country: p.country || null,
        local_time: p.local_time || null,
        idle_time: p.idle_time || null,
        // A DOM scrape's best guess, derived from idle_time client-side (player-parser.js) —
        // validated here rather than trusted blindly, same caution as origin_system above.
        last_activity_at: (typeof p.last_activity_at === 'string' && !isNaN(Date.parse(p.last_activity_at)))
            ? p.last_activity_at : null,
        origin_system: observedOrigin,
        level: p.level || 0,
        ranking: p.ranking || null,
        points: p.points || 0,
        science_level: p.science_level || 0,
        culture_level: p.culture_level || 0,
        biology: p.biology || 0,
        economy: p.economy || 0,
        energy: p.energy || 0,
        mathematics: p.mathematics || 0,
        physics: p.physics || 0,
        social: p.social || 0,
        trade_revenue: p.trade_revenue || 0,
        artefact: p.artefact || null,
        eco_bonus: p.eco_bonus || 0,
        joined: p.joined || null,
        logins: p.logins || 0,
        race_growth: p.race_growth || 0,
        race_science: p.race_science || 0,
        race_culture: p.race_culture || 0,
        race_production: p.race_production || 0,
        race_speed: p.race_speed || 0,
        race_attack: p.race_attack || 0,
        race_defense: p.race_defense || 0,
        race_trader: p.race_trader || 0,
        race_sul: p.race_sul || 0,
        has_intel: p.has_intel || 0,

        home_planet_id: p.home_planet_id || null,
        home_system_id: p.home_system_id || null,
        home_planet_index: p.home_planet_index || null,
        possible_homes: p.possible_homes ? JSON.stringify(p.possible_homes) : '[]',

        // Infrastructure Trackers (Parsed from page elements but distinct from Intel state changes)
        total_planets: p.total_planets || 0,
        total_population: p.total_population || 0,
        total_farms: p.total_farms || 0,
        total_factories: p.total_factories || 0,
        total_labs: p.total_labs || 0,
        total_cybernetics: p.total_cybernetics || 0,
        // Highest single-planet count per type — null (not 0) when the stats-history fetch
        // came back empty, so an unknown max is never shown as a real "biggest planet: 0".
        max_farms: Number.isInteger(p.max_farms) ? p.max_farms : null,
        max_factories: Number.isInteger(p.max_factories) ? p.max_factories : null,
        max_labs: Number.isInteger(p.max_labs) ? p.max_labs : null,
        max_cybernetics: Number.isInteger(p.max_cybernetics) ? p.max_cybernetics : null,
        cv_used: p.cv_used || 0,
        cv_limit: p.cv_limit || 0
    };

    const oldPlayer = playersRepo.getPlayerRestartCheck(p.id);

    // Alliance-wide intel visibility. Read BEFORE the upsert: upsertPlayerFull latches
    // has_intel to 1 and that latch is the only thing separating a first-ever capture from
    // a regain. See announceIntelVisibility for why this lives on the SCRAPE path.
    const priorIntel = playersRepo.getIntelVisibility(p.id);

    playersRepo.recordNameChangeIfDifferent(p.id, safePlayer.name);

    const syncTransaction = db.transaction((player) => {
        // Restart detection. Planet ownership is NEVER touched here — that belongs to
        // system scans (authoritative, logged, fog-of-war guarded); nulling planets from a
        // profile heuristic was what corrupted 1200+ rows and spammed Discord. This block
        // only resets a genuinely-restarted player's own stale profile stats.
        //
        // A changed origin alone is not enough evidence to delete fleet intel: a single
        // incorrect profile link used to trigger this destructive path (issue #164).
        // Retain the independent login-counter signal: require a large relative fall
        // from a meaningful base, so ordinary jitter (500 -> 498) never counts.
        // Points are deliberately NOT a signal: players lose points normally when their
        // planets get pop-killed, so a points crash does not imply a restart.
        const originChanged = oldPlayer
            && Number.isInteger(player.origin_system) && player.origin_system > 0
            && Number.isInteger(oldPlayer.origin_system) && oldPlayer.origin_system > 0
            && player.origin_system !== oldPlayer.origin_system;
        const loginsReset = oldPlayer
            && oldPlayer.logins >= 10 && player.logins > 0
            && player.logins < oldPlayer.logins * 0.5;

        if (loginsReset) {
            console.log(`[SYSTEM] Player ${player.id} restart detected (logins reset${originChanged ? ', origin moved' : ''}); resetting stale profile stats.`);

            fleetsRepo.deleteFleetsByOwner(player.id);
            playersRepo.resetPlayerOnRestart(player.id);
        } else {
            if (player.origin_system === null && oldPlayer && Number.isSafeInteger(oldPlayer.origin_system) && oldPlayer.origin_system > 0) {
                player.origin_system = oldPlayer.origin_system;
            }
            if (originChanged) {
                console.log(`[SYSTEM] Player ${player.id} origin changed ${oldPlayer.origin_system} -> ${player.origin_system} without a login reset; keeping recorded fleet intel.`);
            }
        }

        if (player.alliance_id) {
            // As in the system scan above: seed name from the tag, `?? ''` because
            // alliances.name is NOT NULL and the tag may be missing.
            alliancesRepo.upsertAllianceTagOnly(player.alliance_id, player.alliance_tag ?? null, player.alliance_tag ?? '');
        }
        playersRepo.upsertPlayerFull(player);

        if (player.logins > 0 && (!oldPlayer || oldPlayer.logins !== player.logins)) {
            playersRepo.insertPlayerLogin(player.id, player.logins);
        }

        // Issue #137: the scan itself is the observation, whether or not the counter moved.
        // A scrape that did not carry the counter (0) is no observation and records nothing.
        const observedLogins = Number(player.logins);
        if (Number.isInteger(observedLogins) && observedLogins > 0) {
            playersRepo.recordLoginSample(player.id, observedLogins);
        }
    });

    try {
        syncTransaction(safePlayer);
        announceIntelVisibility(p, safePlayer, priorIntel);
        // Stat milestones, for the same reason the visibility announcement moved here
        // (2026-09-16): this is the only route that ever sees a real intelligence report, so
        // it is the only place a player's sciences actually change. Gated on has_intel
        // because otherwise the columns this reads were not touched by this write at all and
        // re-checking them would just re-derive the same answer. Never let a bonus-goal bug
        // fail the profile sync itself.
        if (safePlayer.has_intel === 1) {
            try { bonusGoalsRepo.evaluatePlayerStatsForGoals(p.id); } catch (err) {
                console.error(`[DB Error] Bonus-goal stat-milestone evaluation failed for player ${p.id}:`, err.message);
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync player ${p.id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- PLAYER API-SCAN CLAIM ---
// Hands out the next batch of stale player ids for the background Player/{id} sweep. A
// "claim" here is just bumping last_api_scan_at now — an optimistic claim, not a locked
// reservation. If the caller's browser fails to actually scan them, they simply become
// stale again after one full sweep cycle and get offered to whoever asks next. See this
// plan's Global Constraints for why a full claims table wasn't built.
// POST, not GET: this mutates last_api_scan_at for up to 200 rows on every call, which
// would otherwise be a write reachable via a bare GET (accidental browser prefetch/retry),
// bypassing the guest-write gate that only inspects the verb (see _middleware.js).
router.post('/sync/player-scan-claim', requireAuth, (req, res) => {
    const rawLimit = (req.body && req.body.limit != null) ? req.body.limit : req.query.limit;
    const limit = Math.min(parseInt(rawLimit, 10) || 20, 200);
    const ids = playersRepo.getStalePlayerIdsForApiScan(limit);
    if (ids.length) playersRepo.markPlayersApiScanned(ids);
    res.json({ success: true, ids });
});

// --- PLAYER API-SCAN STATUS ---
// Read-only counterpart to the claim above, for the "Deep scan" button's status line: how
// many players are on record at all, how many are still stale by the exact same staleness
// rule a claim would use (so this number never disagrees with what clicking the button
// actually does), and when the most recent claim of any size last touched a row.
router.get('/sync/player-scan-status', requireAuth, (req, res) => {
    res.json({ success: true, ...playersRepo.getPlayerApiScanStats() });
});

// --- PLAYER LIST RECEIVER (ListPlayer bulk sync) ---
router.post('/sync/player-list', requireAuth, (req, res) => {
    const { players } = req.body;
    if (!Array.isArray(players) || players.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    // Various Changes: resigned/returned enemy (2026-09-12) — scoped to players with a
    // KNOWN non-friendly alliance (not random unaffiliated churn, which would be
    // extremely noisy in a game with this much turnover).
    const friendlyTagsForResignCheck = new Set([...friendlyAllianceTags()].map(t => String(t).toUpperCase()));
    let stored = 0;
    for (const p of players) {
        if (!Number.isInteger(p.id) || p.id <= 0) continue;
        const newName = typeof p.name === 'string' ? p.name : null;
        const before = playersRepo.getPlayerJoinedWithTag(p.id);
        playersRepo.recordNameChangeIfDifferent(p.id, newName);
        // As in the single-player scan and system scan: seed the alliances row (FOREIGN
        // KEY on players.alliance_id) BEFORE writing a player who belongs to an alliance
        // this sync has never seen before, or the INSERT throws SqliteError: FOREIGN KEY
        // constraint failed — this is exactly what happened on a brand-new round's first
        // ListPlayer pull (2026-08-30). `?? ''` because alliances.name is NOT NULL and the
        // tag may be missing.
        if (Number.isInteger(p.alliance_id) && p.alliance_id) {
            alliancesRepo.upsertAllianceTagOnly(p.alliance_id, p.alliance_tag ?? null, p.alliance_tag ?? '');
        }
        playersRepo.upsertPlayerFromApiList(
            p.id, newName,
            Number.isInteger(p.alliance_id) ? p.alliance_id : null,
            Number.isInteger(p.level) ? p.level : null,
            Number.isInteger(p.points) ? p.points : null,
            Number.isInteger(p.rank) ? p.rank : null,
            typeof p.country === 'string' ? p.country : null,
            p.is_active_player ? 1 : 0,
            typeof p.joined === 'string' ? p.joined : null
        );

        // Resigned/returned enemy: only for a player whose alliance tag was already known
        // and is NOT friendly — a brand-new row (before === undefined) or an unaffiliated
        // player (no alliance_tag) never qualifies. upsertPlayerFromApiList's own COALESCE
        // means a null incoming `joined` keeps the old value, so that's the same fallback
        // used here to know what "after" actually became.
        if (before && before.alliance_tag && friendlyTagsForResignCheck.has(String(before.alliance_tag).toUpperCase()) === false) {
            const beforeJoined = before.joined;
            const afterJoined = typeof p.joined === 'string' ? p.joined : beforeJoined;
            const resignedNow = beforeJoined !== 'N/A' && afterJoined === 'N/A';
            const returnedNow = beforeJoined === 'N/A' && afterJoined && afterJoined !== 'N/A';
            if (resignedNow || returnedNow) {
                const label = `[${before.alliance_tag}] ${before.name || newName || `#${p.id}`}`;
                sendVariousChangeEmbed(
                    resignedNow ? '🏳️ Enemy resigned' : '🔁 Enemy returned',
                    resignedNow ? `${label} has resigned.` : `${label} has rejoined the round.`,
                ).catch(err => console.error('[Discord] resigned-enemy various-changes announce error:', err.message));
            }
        }
        stored++;
    }

    // New-player announcements: same "queue driven by the column, not this batch" idiom as
    // the battle-report announcer above (a player who joined before the channel was
    // configured still gets announced once it is). Unlike battle reports (one embed per
    // report — each is a distinct event worth its own post), a backlog of new players is
    // one story ("N players joined"), so it's aggregated into a SINGLE embed, one name per
    // line, rather than a message-per-player + a trailing "...and N more" ever having been
    // sent as its own message (that produced 5 separate pings plus an unhelpful "56 more,
    // no names" message the first time this ran against the existing backlog). Capped at 40
    // named lines — comfortably inside Discord's 4096-char embed description limit even for
    // long names — with any further overflow folded into the same embed's last line instead
    // of a second message. Posted via postBattleEmbed (kombat bot / BATTLE_DISCORD_TOKEN) at
    // the user's request — same identity that already posts the battle-points leaderboard,
    // not the main raider bot.
    if (settingValue('discord_new_player_channel')) {
        const pending = playersRepo.getPendingNewPlayerAnnouncements();
        if (pending.length > 0) {
            const NAMED_LINE_CAP = 40;
            const named = pending.slice(0, NAMED_LINE_CAP);
            const lines = named.map(row =>
                `**${defuseMentions(row.name)}**${row.alliance_tag ? ` [${defuseMentions(row.alliance_tag)}]` : ''}`);
            if (pending.length > named.length) {
                lines.push(`…and ${pending.length - named.length} more.`);
            }
            postBattleEmbed('discord_new_player_channel', {
                title: pending.length === 1 ? 'New player joined' : `${pending.length} new players joined`,
                description: lines.join('\n'),
                color: 0x3ba55d,
            }).catch(err => console.error('[Discord] new-player announce error:', err.message));
            const flip = db.transaction((ids) => { for (const id of ids) playersRepo.markNewPlayerAnnounced(id); });
            flip(pending.map(r => r.id));
        }
    }

    res.json({ success: true, count: stored });
});

// Every intel field a valid API IntelligenceReport is expected to carry when it's present
// at all. artefact is deliberately excluded from the "must be a finite number" check below
// (it's a nullable string column — legitimately null whenever the player has no active
// artefact, same as the scrape path's safePlayer treats it) — it's checked separately.
const INTEL_NUMERIC_FIELDS = [
    'biology', 'economy', 'energy', 'mathematics', 'physics', 'social', 'trade_revenue',
    'race_growth', 'race_science', 'race_culture', 'race_production', 'race_speed',
    'race_attack', 'race_defense', 'race_trader', 'race_sul',
];
const RACE_FIELDS = [
    'race_growth', 'race_science', 'race_culture', 'race_production', 'race_speed',
    'race_attack', 'race_defense', 'race_trader', 'race_sul',
];

// Guards against Finding 1's failure class (see issues #46/#48): the scrape path normalizes
// every field before binding (safePlayer above), so upsertPlayerFull's has_intel CASE guard
// is only ever fed a fully-formed row. The API detail path has no equivalent normalization
// upstream — player-api-sync.js maps each intel field independently from the API's
// IntelligenceReport, so a missing/misnamed sub-object (e.g. `race`) can silently produce a
// payload with has_intel:1 and every race_* field null. Trusting that signal would permanently
// null out a player's hard-won intel through the CASE guard. So: has_intel is only honored
// when EVERY numeric intel field actually arrived as a real number, and artefact is either a
// string or explicitly null.
function hasCompleteIntel(p) {
    if (!INTEL_NUMERIC_FIELDS.every(f => typeof p[f] === 'number' && Number.isFinite(p[f]))) return false;
    if (p.artefact !== null && typeof p.artefact !== 'string') return false;
    return true;
}

// Records this sync's alliance-wide intel visibility and posts to Various Changes when it
// amounts to real news. `detail.has_intel` is the normalized flag, so whatever validation
// the calling route applies to protect the stat columns also decides what counts as "we can
// see them" — a half-arrived report is not vision.
//
// WHY THIS RUNS ON THE PROFILE SCRAPE, NOT THE API SWEEP (2026-09-15): it was originally
// hooked onto /sync/player-detail, because that sweep walks the whole roster continuously
// and so observes every player rather than only whoever someone happened to open. That
// reasoning was sound and the signal was not: the API's Player/{id} response does not carry
// an intelligenceReport for us AT ALL. Measured, not inferred — across two days and roughly
// a hundred full sweep cycles, intel_visible was 0 or NULL for all 160 players and never
// once 1, while 17 of them held intel the whole time; a probe on the receiving route then
// caught a sweep of Kronic (has_intel = 1) arriving with has_intel falsy. So every zero that
// path recorded meant "this source cannot see intel", not "the alliance cannot see them" —
// the same absence-of-capability-as-observed-absence trap that fleets_observed exists to
// close on /sync/system. Feeding those zeros in kept the confirmed state pinned at 0, which
// is why no capture was ever announced, Karmakazi's included.
//
// The profile scrape is the honest observer: player-parser.js reads visibility off whether
// the page actually rendered its table.ir-summary block. It only fires when a member opens
// a profile, so it samples sparsely — but a sparse true signal beats a dense blind one, and
// first_ever (the case that matters, and the one this bug swallowed) is exempt from the
// two-consecutive-observations rule anyway, so a fresh capture announces on the spot.
function announceIntelVisibility(raw, detail, priorIntel) {
    const change = decideIntelVisibilityChange({ prior: priorIntel, observedVisible: !!detail.has_intel });
    playersRepo.setIntelVisibility(detail.id, {
        intelVisible: change.confirmedVisible,
        intelSeenRaw: change.seenRaw,
    });
    if (!change.announce) return;

    const label = raw.alliance_tag ? `[${raw.alliance_tag}] ${detail.name || raw.name}` : (detail.name || raw.name);
    // Names the member the alliance is seeing them THROUGH, which is what makes this
    // actionable rather than merely true: it says whose eyes to keep in range.
    const capturedBy = typeof raw.intel_captured_by === 'string' && raw.intel_captured_by
        ? ` (seen by **${raw.intel_captured_by}**)` : '';
    const embed = {
        first_ever: ['🔍 First intel captured', `We have never had eyes on ${label} before — the alliance can now see their report${capturedBy}.`],
        regained: ['🔭 Intel regained', `The alliance can see ${label}'s report again${capturedBy}.`],
        lost: ['🌑 Intel lost', `Nobody in the alliance can see ${label}'s report any more — we are working from last known values.`],
    }[change.announce];
    playersRepo.markIntelAnnounced(detail.id, change.announce);
    sendVariousChangeEmbed(embed[0], embed[1]).catch(err =>
        console.error('[Discord] intel-visibility announce error:', err.message)
    );
}

router.post('/sync/player-detail', requireAuth, (req, res) => {
    const p = req.body && req.body.player;
    if (!p || !Number.isInteger(p.id) || p.id <= 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const newName = typeof p.name === 'string' ? p.name : null;
    playersRepo.recordNameChangeIfDifferent(p.id, newName);

    // Normalize before touching SQL — see hasCompleteIntel above. Never trust the API
    // path's own has_intel flag directly; only honor it when every intel field it implies
    // actually arrived intact. A partial/malformed payload falls back to has_intel:0, so
    // the upsert's CASE guard preserves ALL existing intel columns together rather than
    // risking a partial (silently corrupting) overwrite.
    const detail = { ...p, name: newName, has_intel: (p.has_intel && hasCompleteIntel(p)) ? 1 : 0 };
    // upsertPlayerFromApiDetail's statement binds every one of these as a named parameter
    // regardless of has_intel (the CASE guards only decide which value WINS, not whether one
    // must be bound) — better-sqlite3 throws "Missing named parameter" if a key is absent
    // rather than merely null. Not every player race carries all nine race_* bonuses, and a
    // JS `undefined` for a present-but-incomplete sub-object is dropped entirely by
    // JSON.stringify on the way from the client, so this can't rely on the client always
    // sending every key.
    for (const f of [...INTEL_NUMERIC_FIELDS, 'artefact']) {
        if (detail[f] === undefined) detail[f] = null;
    }

    // Race is write-once per round: once a player has ANY race_* value on record, a later
    // detail sync must not be allowed to change it, even when has_intel validly resolves to
    // 1. Overwrite the incoming payload's race_* fields with whatever is already stored, so
    // the upsert's own CASE guard just re-writes the same values (a no-op in effect). A
    // player with no race on record yet still gets the API's values written normally.
    if (detail.has_intel === 1) {
        const existingRace = playersRepo.getPlayerRaceValues(p.id);
        // has_intel, not "is the column non-zero", is the real "race already on record"
        // signal — race_* columns default to 0 for every player row, so testing the raw
        // value would lock in zeros for every player on their very first detail sync.
        if (existingRace && existingRace.has_intel) {
            for (const f of RACE_FIELDS) detail[f] = existingRace[f];
        }
    }

    // ORIGIN: the system a player started in, which is where the game measures their vision
    // radius from — so it decides who can see whom. The API hands it back as coordinates
    // (all 381 system coordinates are distinct, so this resolves exactly), and only for a
    // system we ourselves have vision of; it is simply absent for everyone further out.
    // Worth capturing here because this sweep walks the WHOLE roster every pass, whereas the
    // profile scrape that used to be the only source only fires for a player someone has
    // opened by hand. Never overwritten with null: losing vision of a system does not
    // un-know where somebody started.
    // Always bound, even when unresolved: better-sqlite3 requires every named parameter the
    // statement mentions to be present, and the upsert COALESCEs a null away rather than
    // letting it erase an origin we already know.
    //
    // Coordinates must survive as null rather than being coerced (2026-09-13b). Number(null)
    // is 0 and ZERO IS A REAL COORDINATE — Rana sits at exactly (0,0) — so wrapping these in
    // Number() turned "this player has no visible origin" into "this player started in
    // Rana", and did it for 116 of 159 players before anyone noticed, because the resulting
    // origin looked perfectly plausible. getSystemIdByCoords itself rejects null correctly
    // (Number.isFinite does not coerce); it was the call site that destroyed the distinction.
    const originX = coordinateOrNull(p.origin_x);
    const originY = coordinateOrNull(p.origin_y);
    const originSystemId = (originX === null || originY === null)
        ? null
        : systemsRepo.getSystemIdByCoords(originX, originY);
    detail.origin_system = Number.isInteger(originSystemId) ? originSystemId : null;

    try {
        playersRepo.upsertPlayerFromApiDetail(detail);
        // Deliberately does NOT touch intel visibility: this route's has_intel is always 0
        // because the API carries no intelligenceReport, so recording it would only pin the
        // confirmed state at "not visible" forever. See announceIntelVisibility.
        // Issue #137: the API detail carries the same login counter the profile scrape does,
        // and the background sweep reaches far more players — so it is the denser source of
        // "counter unchanged at time T" observations for the profile's quiet-window analysis.
        const observedLogins = Number(p.logins);
        if (Number.isInteger(observedLogins) && observedLogins > 0) {
            playersRepo.recordLoginSample(p.id, observedLogins);
        }
        // Stat milestones used to hang here, gated on detail.has_intel === 1 — a condition
        // this route can never meet, because the API carries no intelligenceReport at all
        // (measured 2026-09-15, see announceIntelVisibility). So the Science-milestones goal
        // had never once been evaluated in the life of the feature. It moved to /sync/player,
        // the only route that sees a real report. Nothing is gated here any more rather than
        // left looking like a live trigger.
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync player detail ${p.id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- ROUND AGE (for client-side cadence decisions, e.g. ListPlayer pull frequency) ---
router.get('/round-age', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT MAX(archived_at) as last_archived FROM rounds`).get();
    if (!row || !row.last_archived) return res.json({ success: true, days_since: null });
    const days = Math.floor((Date.now() - Date.parse(row.last_archived)) / (24 * 3600 * 1000));
    res.json({ success: true, days_since: days });
});

// --- ALLIANCE PROFILE SCRAPER RECEIVER ---
router.post('/sync/alliance', requireAuth, (req, res) => {
    const body = req.body;

    if (!body || !body.id) return res.status(400).json({ error: 'Invalid alliance payload' });

    // Normalise before touching SQL. Two reasons:
    //   • The game allows an alliance with NO name (only a tag) — e.g. ZiK, PUNX. The
    //     parser sends name:null for those, and alliances.name is NOT NULL, so the upsert
    //     died with "NOT NULL constraint failed: alliances.name" on every scan of them.
    //     Nameless alliances are stored as '' (which is what the existing rows use).
    //   • The row was passed straight to a named-parameter statement, so a payload missing
    //     any single field threw "Missing named parameter" instead of syncing.
    const ally = {
        id: body.id,
        name: body.name == null ? '' : String(body.name),
        tag: body.tag == null ? null : String(body.tag),
        leader_id: body.leader_id ?? null,
        ranking: body.ranking ?? null,
        points: body.points ?? null,
        members: body.members
    };

    console.log(`\n[API] Incoming profile sync for Alliance ID: ${ally.id} (${ally.tag})`);

    const syncTransaction = db.transaction((a) => {
        // 1. Upsert Alliance Data
        alliancesRepo.upsertAllianceFull(a);

        // 2. Map all members to this Alliance
        if (Array.isArray(a.members)) {
            for (const member of a.members) {
                playersRepo.recordNameChangeIfDifferent(member.id, typeof member.name === 'string' ? member.name : null);
                playersRepo.upsertAllianceMemberBasic(member.id, member.name, a.id);
            }
        }
    });

    try {
        syncTransaction(ally);
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync alliance ${ally.id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- ALLIANCE SEARCH RESULT RECEIVER ---
// API-search-sourced, distinct from /sync/alliance's scrape shape above (no leader_id,
// ranking, points, or members[] — Alliance/search doesn't return any of those). Batch:
// the member's browser can send everything Alliance/search returned in one call.
router.post('/sync/alliance-search', requireAuth, (req, res) => {
    const { alliances } = req.body;
    if (!Array.isArray(alliances) || alliances.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let stored = 0;
    const syncTransaction = db.transaction((list) => {
        for (const a of list) {
            if (!Number.isInteger(a.id) || a.id <= 0) continue;
            alliancesRepo.upsertAllianceFromApiSearch(
                a.id,
                a.name == null ? '' : String(a.name),
                a.tag == null ? null : String(a.tag),
                typeof a.full_name === 'string' ? a.full_name : null,
                Number.isInteger(a.member_count) ? a.member_count : null
            );
            stored++;
        }
    });

    try {
        syncTransaction(alliances);
        res.json({ success: true, count: stored });
    } catch (err) {
        console.error('[DB Error] Failed to sync alliance search results:', err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- ALLIANCE LIST RECEIVER (Map/sectors-sourced) ---
// There is no dedicated "list every alliance" API — Map/sectors is the only endpoint that
// hands back every alliance active on the map in one call (each sector object carries its
// own alliances[], deduped client-side before this hits the wire). Its shape is sparser
// than Alliance/search (no full_name/member_count), so this uses upsertAllianceFromMapSector
// — NOT upsertAllianceFromApiSearch — specifically because that one unconditionally
// overwrites full_name/member_count and would null them out for every alliance this route
// ever touches.
router.post('/sync/alliances-from-map', requireAuth, (req, res) => {
    const { alliances } = req.body;
    if (!Array.isArray(alliances) || alliances.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let stored = 0;
    const syncTransaction = db.transaction((list) => {
        for (const a of list) {
            if (!Number.isInteger(a.id) || a.id <= 0) continue;
            alliancesRepo.upsertAllianceFromMapSector(a.id, a.name, a.tag);
            stored++;
        }
    });

    try {
        syncTransaction(alliances);
        res.json({ success: true, count: stored });
    } catch (err) {
        console.error('[DB Error] Failed to sync alliances from Map/sectors:', err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- FLEET ID BACKFILL ---
// Alliance scans give fleet positions but not game fleet ids (those only appear on the
// system map). The News refresh parses the relevant systems and posts the ids here so we
// can build Game/Fleets/Launch deep-links. Matches existing fleet rows by owner+location.
router.post('/sync/fleet-ids', requireAuth, (req, res) => {
    const list = Array.isArray(req.body.fleets) ? req.body.fleets : [];
    if (!list.length) return res.json({ success: true, updated: 0 });
    try {
        let updated = 0;
        const tx = db.transaction((rows) => {
            for (const f of rows) {
                if (!Number.isInteger(f.game_fleet_id) || !Number.isInteger(f.owner_id)) continue;
                if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                updated += fleetsRepo.updateFleetGameId(f.game_fleet_id, f.owner_id, f.system_id, f.planet_index).changes;
            }
        });
        tx(list);
        res.json({ success: true, updated });
    } catch (err) {
        console.error('[DB Error] fleet-id backfill failed:', err.message);
        res.status(500).json({ error: 'Fleet id sync failed' });
    }
});

// --- GALAXY MASTER INDEX RECEIVER ---
router.post('/sync/galaxy', requireAuth, (req, res) => {
    const { systems } = req.body;

    if (!Array.isArray(systems) || systems.length === 0) {
        return res.status(400).json({ error: 'Invalid galaxy payload' });
    }

    console.log(`\n[API] Incoming Galaxy Index sync (${systems.length} systems)`);

    // x/y land in INTEGER-affinity columns, but a bound non-numeric string is stored as
    // TEXT and later reaches the map UI, so coerce here at the trust boundary: a system id
    // must be a positive integer, and x/y become real numbers or the row is skipped. This
    // keeps a member-supplied string from ever persisting as coordinates (defence in depth
    // for the map's own esc(); one bad row is skipped, never aborts the batch).
    const coord = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    let stored = 0;
    const syncTransaction = db.transaction((sysList) => {
        for (const s of sysList) {
            if (!Number.isInteger(s.id) || s.id <= 0) continue;
            const x = coord(s.x);
            const y = coord(s.y);
            if (x === null || y === null) continue;
            systemsRepo.upsertSystemFull(
                s.id,
                typeof s.name === 'string' ? s.name : null,
                x, y,
                typeof s.full_name === 'string' ? s.full_name : null,
                typeof s.info === 'string' ? s.info : null,
                Number.isInteger(s.population_level) ? s.population_level : null
            );
            stored++;
        }
    });

    try {
        syncTransaction(systems);
        res.json({ success: true, count: stored });
    } catch (err) {
        console.error(`[DB Error] Failed to sync galaxy index:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- SYSTEM VISIBILITY FLAG RECEIVER ---
// Map/sectors reports isInVision per system: whether the returned planet data is live or
// the game's last-known cache for territory outside anyone's current vision. This is
// purely a staleness signal for later UI use — it does not affect the fog-of-war merge in
// /sync/system (the client marks affected planets vision_uncertain before calling that
// route, see api-galaxy-seed.js); this route only records the flag itself for display.
router.post('/sync/system-in-vision', requireAuth, (req, res) => {
    const { systems } = req.body;
    if (!Array.isArray(systems) || systems.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let updated = 0;
    for (const s of systems) {
        if (!Number.isInteger(s.id) || s.id <= 0) continue;
        if (systemsRepo.setSystemInVision(s.id, !!s.is_in_vision) > 0) updated++;
    }
    res.json({ success: true, updated });
});

// --- RANKING: BEST GUARDED DATA INGESTION SYNC LAYER ---
router.post('/sync/best-guarded', requireAuth, (req, res) => {
    const { last_update, entries } = req.body;
    if (!last_update || !Array.isArray(entries)) {
        return res.status(400).json({ error: 'Invalid rank tracking payload payload data structures' });
    }

    // Daily lock guard check against the exact server tick date signature
    const existingCheck = { count: systemsRepo.countBestGuardedAt(last_update) };
    if (existingCheck.count > 0) {
        return res.json({ success: true, skipped: true, message: 'Rankings already updated for today.' });
    }

    console.log(`[API] Processing fresh Best Guarded ranking sync batch updated at: ${last_update}`);

    const syncTx = db.transaction((rows) => {
        systemsRepo.clearBestGuarded(); // Clear stale indices safely

        for (const row of rows) {
            systemsRepo.insertBestGuarded(row.planet_id, row.cv, last_update);
        }
    });

    try {
        syncTx(entries);

        // Various Changes: "all top50 in the area", not just #1/top10 (2026-09-12) —
        // filter the WHOLE fresh snapshot to planets owned by, or within
        // BEST_GUARDED_AREA_RADIUS systems of, friendly territory, then announce only
        // what actually entered or left that filtered set since last time.
        const inArea = systemsRepo.getBestGuardedInArea(
            new Set([...friendlyAllianceTags()].map(t => String(t).toUpperCase())),
            BEST_GUARDED_AREA_RADIUS,
        );
        const { entered, left } = systemsRepo.diffAndReplaceBestGuardedAreaWatch(inArea.map(r => r.game_planet_id));
        if (entered.length || left.length) {
            const areaByGameId = new Map(inArea.map(r => [r.game_planet_id, r]));
            const lines = [];
            for (const id of entered) {
                const r = areaByGameId.get(id);
                if (!r) continue;
                const owner = r.owner_name
                    ? (r.owner_tag ? `[${r.owner_tag}] ${r.owner_name}` : r.owner_name)
                    : 'Free Planet';
                lines.push(`🛡️ **${r.system_name || 'System'} [${r.system_id}]** #${r.planet_index} (${owner}): newly guarded at **${r.cv}** CV`);
            }
            for (const id of left) {
                const loc = systemsRepo.getPlanetLocationByGameId(id);
                lines.push(loc
                    ? `📤 **${loc.name || 'A planet'}** (system #${loc.system_id} #${loc.planet_index}) dropped off the Best Guarded list`
                    : `📤 Planet #${id} dropped off the Best Guarded list`);
            }
            sendVariousChangeEmbed('🛡️ Best Guarded — near your territory', lines.join('\n')).catch(err =>
                console.error('[Discord] best-guarded various-changes announce error:', err.message)
            );
        }

        res.json({ success: true, skipped: false });
    } catch (err) {
        console.error('[DB Error] Best Guarded sync process failure:', err);
        res.status(500).json({ error: 'Database ranking sync error event' });
    }
});

// --- RANKING: BEST PLANETS COVERAGE (Various Changes, 2026-09-12) ---
// Public and aggregate-only, deliberately separate from the SECRET bonus-goals
// ranking_match mechanism (src/repositories/bonusGoals.js) even though both watch
// /Ranking/BestPlanets: an admin may never configure that secret goal at all, and this
// count ("how many of the top-N are ours") reveals nothing about tier/point values the
// way that system's targeting does — see database.js's bonus_goals comment for why THAT
// stays admin-configured-and-hidden. This one is a standalone daily snapshot with no
// secrecy requirement, so it needs none of that machinery.
//
// No same-tick dedup guard (unlike /sync/best-guarded, which has a real page-supplied
// timestamp to key off): the client checks hourly regardless, and re-processing an
// unchanged page here is harmless — a wholesale replace of identical rows, then a
// friendly-coverage recompute that matches the last-announced count and so announces
// nothing. Correctness (never missing a real change) wins over skipping a cheap no-op.
router.post('/sync/best-planets-snapshot', requireAuth, (req, res) => {
    const { rows } = req.body;
    if (!Array.isArray(rows)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const syncedAt = new Date().toISOString();

    const syncTx = db.transaction((entries) => {
        systemsRepo.clearBestPlanetsSnapshot();
        for (const row of entries) {
            if (!Number.isInteger(row.game_planet_id) || !Number.isInteger(row.rank)) continue;
            systemsRepo.insertBestPlanetsSnapshot(row.game_planet_id, row.rank, syncedAt);
        }
    });

    try {
        syncTx(rows);

        // "We hold" means RAID itself here (2026-09-12d fix), NOT RAID+NAP like the
        // closed-system/siege features — a NAP partner's planet ranking well isn't
        // something WE hold, and counting it inflated this specific number.
        const { friendly, total } = systemsRepo.getBestPlanetsFriendlyCoverage(ownAllianceTags());
        const lastAnnounced = settingsRepo.getSetting('best_planets_friendly_count_last_announced');
        const lastCount = lastAnnounced ? parseInt(lastAnnounced.value, 10) : null;
        if (total > 0 && friendly !== lastCount) {
            const delta = Number.isFinite(lastCount) ? friendly - lastCount : null;
            const trend = delta == null ? '' : delta > 0 ? ` (+${delta})` : delta < 0 ? ` (${delta})` : '';
            sendVariousChangeEmbed(
                '🌍 Best Planets coverage',
                `We now hold **${friendly}/${total}**${trend} of the Best Planets ranking.`,
            ).catch(err => console.error('[Discord] best-planets various-changes announce error:', err.message));
            settingsRepo.setSetting('best_planets_friendly_count_last_announced', String(friendly));
        }

        res.json({ success: true, skipped: false });
    } catch (err) {
        console.error('[DB Error] Best Planets snapshot sync failure:', err);
        res.status(500).json({ error: 'Database ranking sync error event' });
    }
});

// --- RANKING: HIGHEST POPULATION COVERAGE (Various Changes, 2026-09-18) ---
// Same shape and reasoning as /sync/best-planets-snapshot above, including the "separate
// from whichever /Ranking/... page an admin may have pointed the SECRET bonus-goals
// ranking_match mechanism at" caveat — that goal type isn't hardcoded to BestPlanets, so
// it could equally be configured against HighestPopulation. Public, aggregate-only, no
// dedup guard (identical reasoning: the hourly re-check is harmless when unchanged).
router.post('/sync/highest-population-snapshot', requireAuth, (req, res) => {
    const { rows } = req.body;
    if (!Array.isArray(rows)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const syncedAt = new Date().toISOString();

    const syncTx = db.transaction((entries) => {
        systemsRepo.clearHighestPopulationSnapshot();
        for (const row of entries) {
            if (!Number.isInteger(row.game_planet_id) || !Number.isInteger(row.rank)) continue;
            systemsRepo.insertHighestPopulationSnapshot(row.game_planet_id, row.rank, syncedAt);
        }
    });

    try {
        syncTx(rows);

        const { friendly, total } = systemsRepo.getHighestPopulationFriendlyCoverage(ownAllianceTags());
        const lastAnnounced = settingsRepo.getSetting('highest_population_friendly_count_last_announced');
        const lastCount = lastAnnounced ? parseInt(lastAnnounced.value, 10) : null;
        if (total > 0 && friendly !== lastCount) {
            const delta = Number.isFinite(lastCount) ? friendly - lastCount : null;
            const trend = delta == null ? '' : delta > 0 ? ` (+${delta})` : delta < 0 ? ` (${delta})` : '';
            sendVariousChangeEmbed(
                '👥 Highest Population coverage',
                `We now hold **${friendly}/${total}**${trend} of the Highest Population ranking.`,
            ).catch(err => console.error('[Discord] highest-population various-changes announce error:', err.message));
            settingsRepo.setSetting('highest_population_friendly_count_last_announced', String(friendly));
        }

        res.json({ success: true, skipped: false });
    } catch (err) {
        console.error('[DB Error] Highest Population snapshot sync failure:', err);
        res.status(500).json({ error: 'Database ranking sync error event' });
    }
});

// --- ALLIANCE STATS RECEIVER & SYNC ---
router.post('/sync/alliance-stats', requireAuth, (req, res) => {
    const s = req.body;
    if (!s || !s.player_id) return res.status(400).json({ error: 'Missing Player ID' });

    let nextCultureAt = null;
    if (s.next_culture_seconds !== null && !isNaN(s.next_culture_seconds)) {
        nextCultureAt = new Date(Date.now() + s.next_culture_seconds * 1000).toISOString();
    }

    const fleets = Array.isArray(s.fleets) ? s.fleets : null;

    try {
        const tx = db.transaction(() => {
            alliancesRepo.upsertAllianceMemberStats(
                s.player_id, s.planets_text, nextCultureAt, s.science_rate, s.culture_rate, s.production_rate,
                s.astro_dollars, s.production_points, s.artefact, s.level_text, s.cv_limit_text,
                s.economy, s.energy, s.mathematics, s.physics, s.population
            );

            playersRepo.recordNameChangeIfDifferent(s.player_id, typeof s.name === 'string' ? s.name : null);
            playersRepo.upsertPlayerNameOnly(s.player_id, s.name);

            // Replace this member's stationed fleets so positions stay fresh and stale
            // ones are dropped. Only touch fleets when the scrape actually carried a
            // fleet array (avoids wiping data on a stats-only payload).
            if (fleets) {
                fleetsRepo.deleteFleetsByOwner(s.player_id);
                for (const f of fleets) {
                    if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                    fleetsRepo.insertFleetForAllianceStats(
                        s.player_id, f.system_id, f.planet_index,
                        f.transports || 0, f.colony_ships || 0, f.destroyers || 0, f.cruisers || 0, f.battleships || 0,
                        f.arrival_at || null
                    );
                }
            }
        });
        tx();

        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Alliance member stats sync failed:", err);
        res.status(500).json({ error: 'Database transaction failed' });
    }
});

// --- ALLIANCE ROSTER RECONCILE ---
// Body: { member_ids: [..] } — the full set of player_ids currently in the alliance.
// Stats rows for anyone NOT in this set (i.e. resigned/left) are removed so they
// stop appearing in alliance stats and on the trade-agreements board.
router.post('/sync/alliance-roster', requireAuth, (req, res) => {
    const ids = Array.isArray(req.body.member_ids)
        ? req.body.member_ids.map(Number).filter(Number.isInteger)
        : [];
    // Guard against wiping everything if the roster scrape came back empty.
    if (ids.length === 0) return res.json({ success: true, removed: 0 });

    try {
        const info = alliancesRepo.deleteStaleAllianceMembers(ids);
        if (info.changes > 0) console.log(`[API] Alliance roster reconcile: removed ${info.changes} stale member(s).`);
        res.json({ success: true, removed: info.changes });
    } catch (err) {
        console.error("[DB Error] Alliance roster reconcile failed:", err);
        res.status(500).json({ error: 'Database transaction failed' });
    }
});

// --- BATTLE REPORT WATERMARK (for the sidebar "synced through" label) ---
// Same value POST /sync/battle-reports already returns as newest_started_at — exposed as
// its own GET so the dashboard can show it on page load, before any sync has run this
// session (battle-sync.js's own newestStartedAt is a per-tab module variable that starts
// null on every fresh load; this reads the hub-wide truth straight from the DB instead).
router.get('/sync/battle-reports-watermark', requireAuth, (req, res) => {
    const lastRun = settingsRepo.getSetting('battle_sync_last_run_at');
    const lastCount = settingsRepo.getSetting('battle_sync_last_inserted_count');
    res.json({
        newest_started_at: battleReportsRepo.getNewestStartedAt(),
        last_run_at: lastRun ? lastRun.value : null,
        last_inserted_count: lastCount ? (parseInt(lastCount.value, 10) || 0) : null,
    });
});

// Which alliance tags' battles are worth a Discord post. battle-sync.js pulls EVERY report
// on the server now (2026-09-02 — see that file's header), not just the tracked account's
// own alliance, so without this every random battle anywhere in the game would spam the
// channel. Comma-separated, same parsing convention as battlePoints.js's
// getExcludedAllianceTags — except this is an INCLUDE list, not an exclude one. Empty means
// "not configured yet": announce nothing rather than silently falling back to the old
// firehose behavior, so an admin who hasn't set this notices a quiet channel instead of a
// noisy one.
function getBattleReportAllianceTags() {
    const row = settingsRepo.getSetting('discord_battlereport_alliance_tags');
    if (!row || !row.value) return [];
    return row.value.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
}

// --- BATTLE REPORT RECEIVER (game REST API) ---
// Body: { reports: [<raw /api/v1 battle-report objects>] }. Mapping/validation lives in
// src/utils/battle-reports.js: a malformed report is skipped, never aborts the batch,
// and INSERT OR IGNORE makes re-syncs idempotent (the game report id is the PK).
//
// Discord announcements are fired AFTER the commit, fire-and-forget, only for reports
// the hub had never seen (freshly inserted, announced=0) AND involving a tracked alliance
// tag (see getBattleReportAllianceTags — sync itself is global, so this is the only
// relevance filter left), capped at 5 embeds per sync with the overflow summarized in one
// line. Names are player-controlled strings on their way to Discord, so they pass through
// defuseMentions first.
router.post('/sync/battle-reports', requireAuth, (req, res) => {
    const list = Array.isArray(req.body.reports) ? req.body.reports : null;
    if (!list) return res.status(400).json({ error: 'Invalid payload' });

    const rows = [];
    for (const r of list) {
        const row = mapApiReport(r);
        if (row) rows.push(row);
    }

    try {
        const { inserted, skipped } = upsertReports(db, rows);

        // Announce the ones the alliance has not seen yet. The pass is driven from the
        // table (WHERE announced = 0), not just this batch's freshly inserted rows, so a
        // report that was synced BEFORE the Discord channel was configured still gets
        // announced once the channel exists (INSERT OR IGNORE would otherwise send it to
        // `skipped` on a re-sync and it could never announce). announced=1 is flipped only
        // when a channel is actually configured — otherwise the rows stay a retry queue.
        if (settingValue('discord_battlereport_channel')) {
            const pending = battleReportsRepo.getPendingAnnouncements();
            if (pending.length > 0) {
                // Relevance filter: sync is global (every battle on the server), so only
                // announce the ones touching a tag this alliance actually cares about.
                // Irrelevant rows are NOT re-queued forever — they're still marked announced
                // below, same as relevant ones, since "not relevant" is a final answer, not
                // a transient failure worth retrying.
                const trackedTags = getBattleReportAllianceTags();
                const relevant = trackedTags.length === 0 ? [] : pending.filter(row =>
                    (row.att_alliance_tag && trackedTags.includes(row.att_alliance_tag.toUpperCase()))
                    || (row.def_alliance_tag && trackedTags.includes(row.def_alliance_tag.toUpperCase())));

                const toEmbed = relevant.slice(0, 5);
                for (const row of toEmbed) {
                    const embed = formatBattleEmbed({
                        ...row,
                        att_player_name: row.att_player_name == null ? null : defuseMentions(row.att_player_name),
                        def_player_name: row.def_player_name == null ? null : defuseMentions(row.def_player_name),
                        att_alliance_tag: row.att_alliance_tag == null ? null : defuseMentions(row.att_alliance_tag),
                        def_alliance_tag: row.def_alliance_tag == null ? null : defuseMentions(row.def_alliance_tag),
                        winner: row.winner == null ? null : defuseMentions(row.winner),
                    });
                    postEmbed('discord_battlereport_channel', embed).catch(err =>
                        console.error('[Discord] battle-report announce error:', err.message));
                }
                if (relevant.length > toEmbed.length) {
                    postEmbed('discord_battlereport_channel', {
                        title: 'More battle reports',
                        description: `…and ${relevant.length - toEmbed.length} more new battle reports synced.`,
                        color: 0x99aab5,
                    }).catch(err => console.error('[Discord] battle-report announce error:', err.message));
                }
                // Fire-and-forget above: the flag is flipped for every PENDING row (relevant
                // or not) now, so a Discord hiccup drops that one embed rather than replaying
                // the whole backlog on the next sync (matches how reminders/timers mark
                // themselves sent) — and an irrelevant row never gets a second look.
                const flip = db.transaction((ids) => { for (const id of ids) battleReportsRepo.markAnnounced(id); });
                flip(pending.map(r => r.id));
            }
        }

        // --- BATTLE POINTS: automated twice-daily leaderboard post ---
        // This app has no server-side scheduler anywhere (every periodic-feeling behavior
        // here is actually driven by client sync traffic) — so this piggybacks on real
        // battle-report sync activity instead of adding a new timer. Any sync that
        // actually inserts new rows is treated as "fresh data just arrived"; if at least
        // 12 hours have passed since the last automated post, it fires again. In practice
        // this lands once after the first sync following local midnight (when yesterday's
        // reports become visible) and again roughly 12 hours later.
        if (inserted.length > 0 && settingValue('discord_battlepoints_channel')) {
            const lastPostRaw = settingValue('battle_points_last_auto_post_at');
            const lastPostMs = lastPostRaw ? Date.parse(lastPostRaw) : NaN;
            const hoursSince = Number.isFinite(lastPostMs) ? (Date.now() - lastPostMs) / (60 * 60 * 1000) : Infinity;
            if (hoursSince >= 12) {
                const { cv, pop } = battlePointsRepo.getLeaderboards(null, 10);
                const formatLines = (rows, unit) => rows.length
                    ? rows.map((r, i) => `**${i + 1}.** ${r.player_name || 'Unknown'} — ${r.points} pts (${r.raw.toLocaleString()} ${unit})`).join('\n')
                    : '_No battles recorded yet._';
                postBattleEmbed('discord_battlepoints_channel', {
                    title: '⚔️ Battle Challenge Update',
                    fields: [
                        { name: '💥 CV Killed', value: formatLines(cv, 'CV') },
                        { name: '☠️ Population Killed', value: formatLines(pop, 'pop') },
                    ],
                    color: 0xe11d48,
                }).catch(err => console.error('[Discord] battle-points auto-post error:', err.message));
                settingsRepo.setSetting('battle_points_last_auto_post_at', new Date().toISOString());
            }
        }

        // newest_started_at is the dashboard scheduler's contract: the next pull uses it
        // as BattleDateFrom so the search window only ever moves forward.
        const newest = battleReportsRepo.getNewestStartedAt();

        // battle-sync.js now runs once a day (2026-09-12), not every 30 min — recording
        // when this last ran and how many were genuinely new is how a member confirms the
        // daily pull actually happened, instead of guessing from watermark staleness alone.
        settingsRepo.setSetting('battle_sync_last_run_at', new Date().toISOString());
        settingsRepo.setSetting('battle_sync_last_inserted_count', String(inserted.length));

        res.json({ success: true, inserted: inserted.length, skipped, newest_started_at: newest });
    } catch (err) {
        console.error('[DB Error] Battle report sync failed:', err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- BATTLE REPORT SHIP-DETAIL CLAIM ---
// Same optimistic-claim pattern as /sync/player-scan-claim (Plan 3): "claiming" is just
// bumping ship_detail_scraped_at now. A battle report's ship detail never changes once
// scraped (it's an immutable historical record), so unlike the player sweep this needs no
// staleness re-check — a report is either scraped or it isn't.
router.post('/sync/battle-report-ship-detail-claim', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 10, 50);
    const ids = battleReportsRepo.getReportsNeedingShipDetail(limit);
    if (ids.length) battleReportsRepo.markShipDetailScraped(ids);
    res.json({ success: true, ids });
});

// --- BATTLE REPORT LOCATION BACKFILL CLAIM ---
// One-time legacy pass for reports already marked ship_detail_scraped_at but with no
// system_id (scraped before planet capture shipped, or by a stale browser tab still
// running old JS — see getReportsNeedingLocationBackfill). The RECEIVER is the same
// /sync/battle-report-ship-detail route below — re-sending the ship-count/win_chance
// fields for an already-scraped report is a harmless idempotent overwrite with identical
// values; only system_id/planet_index are actually new for these rows.
router.post('/sync/battle-report-location-backfill-claim', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 10, 50);
    const ids = battleReportsRepo.getReportsNeedingLocationBackfill(limit);
    if (ids.length) battleReportsRepo.markLocationBackfillAttempted(ids);
    res.json({ success: true, ids });
});

// The 24 per-ship-type integer columns updateShipDetail writes (6 ship types x
// att/def x count/lost) — kept in one place so the coercion loop below and the schema
// can't silently drift apart.
const SHIP_DETAIL_INT_FIELDS = [
    'att_destroyers', 'att_destroyers_lost', 'def_destroyers', 'def_destroyers_lost',
    'att_cruisers', 'att_cruisers_lost', 'def_cruisers', 'def_cruisers_lost',
    'att_battleships', 'att_battleships_lost', 'def_battleships', 'def_battleships_lost',
    'att_transports', 'att_transports_lost', 'def_transports', 'def_transports_lost',
    'att_colony_ships', 'att_colony_ships_lost', 'def_colony_ships', 'def_colony_ships_lost',
    'att_starbases', 'att_starbases_lost', 'def_starbases', 'def_starbases_lost',
];

// --- BATTLE REPORT SHIP-DETAIL RECEIVER ---
router.post('/sync/battle-report-ship-detail', requireAuth, (req, res) => {
    const { id, ...detail } = req.body || {};
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    // Coerce every field before it reaches SQL — a string value could otherwise bind
    // straight into an INTEGER column. Matches the coercion discipline already used by
    // /sync/player-list and /sync/player-detail above.
    const normalized = {};
    for (const field of SHIP_DETAIL_INT_FIELDS) {
        normalized[field] = Number.isInteger(detail[field]) ? detail[field] : null;
    }
    normalized.win_chance = typeof detail.win_chance === 'number' && Number.isFinite(detail.win_chance)
        ? detail.win_chance
        : null;
    normalized.system_id = Number.isInteger(detail.system_id) ? detail.system_id : null;
    normalized.planet_index = Number.isInteger(detail.planet_index) ? detail.planet_index : null;
    try {
        battleReportsRepo.updateShipDetail(id, normalized);
        // A report's system_id/planet_index (and therefore whether it lands on a
        // currently-ranked planet) are only known from this point on — see
        // bonusGoalsRepo.evaluateBattleReportForGoals's own comment. Never let a bonus-goal
        // bug fail the ship-detail sync itself; the report's own data is already saved.
        try { bonusGoalsRepo.evaluateBattleReportForGoals(id); } catch (err) {
            console.error(`[DB Error] Bonus-goal evaluation failed for report ${id}:`, err.message);
        }
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync battle report ship detail ${id}:`, err.message);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- BONUS GOALS: ranking-page snapshot sync (feeds the 'ranking_match' goal type) ---
// There is no server-side game session (see player-api-sync.js's header comment) — every
// scrape in this hub runs from a member's own browser, this one included. The specific
// ranking page and point tiers are pure DB config (see bonusGoals.js/secretOps.js); this
// route only knows how to store whatever rows it's handed, generically.
router.get('/sync/bonus-goals/ranking-targets', requireAuth, (req, res) => {
    try {
        res.json({ success: true, targets: bonusGoalsRepo.getStaleRankingGoals() });
    } catch (err) {
        console.error('[DB Error] Failed to fetch ranking-goal targets:', err.message);
        res.status(500).json({ error: 'Failed to fetch ranking-goal targets' });
    }
});

router.post('/sync/bonus-goals/ranking-snapshot', requireAuth, (req, res) => {
    const goalId = parseInt(req.body && req.body.goal_id, 10);
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!Number.isInteger(goalId) || !rows) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    // Coerced the same way every other sync receiver in this file does — the payload
    // travelled through a member's browser and a DOM parse before it got here. A row with
    // no game_planet_id at all is dropped, not just left unresolved: it can never match a
    // battle report's system_id/planet_index (both stay NULL), so keeping it is pure noise.
    const normalized = rows
        .filter(r => r && Number.isInteger(r.rank) && Number.isInteger(r.game_planet_id))
        .map(r => ({
            rank: r.rank,
            game_planet_id: r.game_planet_id,
            owner_name: typeof r.owner_name === 'string' ? r.owner_name.slice(0, 100) : null,
            owner_alliance_tag: typeof r.owner_alliance_tag === 'string' ? r.owner_alliance_tag.slice(0, 20) : null,
        }));
    try {
        bonusGoalsRepo.replaceRankingSnapshot(goalId, normalized);
        res.json({ success: true, count: normalized.length });
    } catch (err) {
        console.error(`[DB Error] Failed to sync ranking snapshot for goal ${goalId}:`, err.message);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- BONUS GOALS: active random_target (feeds the map marker / in-system highlight) ---
// Unlike everything else about a goal's config, the active target's LOCATION is meant to
// be visible to every member — the whole point is a race to find it first — so this is a
// plain requireAuth route, not behind the admin token gate (see secretOps.js).
router.get('/sync/bonus-goals/active-target', requireAuth, (req, res) => {
    try {
        res.json({ success: true, targets: bonusGoalsRepo.getActiveTargetsForDisplay() });
    } catch (err) {
        console.error('[DB Error] Failed to fetch active bonus-goal targets:', err.message);
        res.status(500).json({ error: 'Failed to fetch active targets' });
    }
});

// --- STARBASE ORDER AUDIT RECEIVER ---
// One row per starbase-order geometry PUT the member's browser confirmed against the
// game API (the hub never sends that PUT itself). The actor comes from the session, not
// the payload — the payload only says what was sent, never who sent it.
router.post('/sync/starbase-audit', requireAuth, (req, res) => {
    const b = req.body;
    const orderId = Number(b.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order_id' });
    }

    const intOrNull = v => (Number.isInteger(v) ? v : null);
    const realOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    try {
        db.prepare(`
            INSERT INTO starbase_order_audit
                (order_id, system_id, planet_index, range, angle1, angle2, actor_user_id, actor_game_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            orderId,
            intOrNull(b.system_id), intOrNull(b.planet_index),
            realOrNull(b.range), realOrNull(b.angle1), realOrNull(b.angle2),
            req.session.userId, req.session.gameName || null
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Starbase order audit failed:', err);
        res.status(500).json({ error: 'Audit write failed' });
    }
});

// --- TRADE MARKET PRICE RECEIVER (Production Point / Supply Unit) ---
router.post('/sync/trade-prices', requireAuth, (req, res) => {
    const { pp_price, su_price } = req.body;

    try {
        if (pp_price != null && !isNaN(pp_price)) settingsRepo.setSetting('pp_price', String(pp_price));
        if (su_price != null && !isNaN(su_price)) settingsRepo.setSetting('su_price', String(su_price));
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to store trade prices:', err);
        res.status(500).json({ error: 'Failed to store trade prices' });
    }
});

// --- NEWS-PAGE WATERMARK (for the client's pagination-walk stop condition) ---
router.get('/sync/news-watermark', requireAuth, (req, res) => {
    const row = playersRepo.getPlayerIdByName(req.session.gameName || '');
    const playerId = row ? row.id : null;
    if (!playerId) return res.json({ watermark: null });
    res.json({ watermark: newsEventsRepo.getWatermark(playerId) });
});

// --- NEWS-PAGE EVENT RECEIVER ---
// Body: { entries: [{ message_type, occurred_at, game_planet_id, system_id,
// other_player_id, population_delta, direction }] }. Parsing lives entirely on the
// client (public/js/ui/news-battle-events.js reading the member's own /Game/News page);
// this route only resolves crediting/matching and stores the result. `direction`
// ('killed'|'lost') only matters for battle-bombarded rows.
router.post('/sync/news', requireAuth, (req, res) => {
    const entries = Array.isArray(req.body.entries) ? req.body.entries : null;
    if (!entries) return res.status(400).json({ error: 'Invalid payload' });

    const row = playersRepo.getPlayerIdByName(req.session.gameName || '');
    const playerId = row ? row.id : null;
    if (!playerId) return res.status(400).json({ error: 'Session player not recognized' });

    let inserted = 0;
    let maxOccurredAt = null;

    try {
        for (const raw of entries) {
            if (!raw || !raw.message_type || !raw.occurred_at) continue;

            // A garbage/unparseable timestamp must never reach matching (new Date(NaN...)
            // throws RangeError) or the watermark (a string that string-compares as
            // "greater than" every real ISO-8601 value would push the watermark past all
            // real events, permanently halting this player's News pagination). Validate
            // BEFORE this entry touches anything else, so one bad entry never sinks the
            // good entries around it.
            if (isNaN(Date.parse(raw.occurred_at))) {
                console.warn(`[News Sync] player ${playerId}: skipping entry with unparseable occurred_at`, raw.occurred_at);
                continue;
            }

            if (maxOccurredAt === null || raw.occurred_at > maxOccurredAt) maxOccurredAt = raw.occurred_at;

            // A News row can name a player the hub has never scanned (no players row
            // exists for them yet) — other_player_id has a FOREIGN KEY to players(id), so
            // using it verbatim would throw on INSERT. Never fabricate a players row for
            // them; just drop the reference. For battle-bombarded rows this also nulls out
            // credited_player_id (via resolveBombardmentCredit's own "no other_player_id"
            // guard below) — population credit needs a valid, existing player to attribute
            // to.
            let otherPlayerId = raw.other_player_id || null;
            if (otherPlayerId && !playersRepo.playerExistsById(otherPlayerId)) {
                console.warn(`[News Sync] player ${playerId}: other_player_id ${otherPlayerId} has no players row, dropping reference`);
                otherPlayerId = null;
            }

            let credited_player_id = null;
            let matched_battle_report_id = null;
            let population_delta = raw.population_delta || null;

            if (raw.message_type === 'battle-bombarded') {
                // Don't gate this call on otherPlayerId: direction "killed" credits the
                // scraping player regardless of whether the opponent is known (see
                // resolveBombardmentCredit). Only the cross-reference lookup below needs
                // a known otherPlayerId.
                const credit = resolveBombardmentCredit({ ...raw, other_player_id: otherPlayerId }, playerId);
                if (credit) {
                    credited_player_id = credit.credited_player_id;
                    if (credit.otherPlayerId) {
                        matched_battle_report_id = battleReportsRepo.findByPlayerPairNear(
                            credit.credited_player_id, credit.otherPlayerId, raw.occurred_at, 15
                        );
                    }
                }
            } else if (raw.message_type === 'battle-conquer' && raw.game_planet_id) {
                // The News-page conquest text carries no population number (see
                // news-battle-events.js's parseConquestRow) — recover it from the closest
                // logged population drop for this planet, which /sync/system's system-sync
                // now logs unconditionally rather than only on same-owner ticks. Without
                // this, every non-battle conquest (an undefended planet, or colonizing an
                // Unknown planet's leftover population) was invisible to the !mortal
                // population-killed leaderboard.
                const loc = systemsRepo.getPlanetLocationByGameId(raw.game_planet_id);
                if (loc) {
                    const drop = systemsRepo.getRecentPopDrop(loc.system_id, loc.planet_index, raw.occurred_at);
                    if (drop && drop.old_value != null && drop.new_value != null && drop.old_value > drop.new_value) {
                        population_delta = drop.old_value - drop.new_value;
                        credited_player_id = playerId; // "We conquered..." always refers to the scraping player
                    }
                }
            }

            // Insert each entry independently — a constraint violation on one bad entry
            // (however it slipped past the guards above) must not abort the rest of the
            // batch. insertNewsEvent's own INSERT OR IGNORE dedup semantics are unchanged;
            // this only adds a safety net around it.
            try {
                const wasInserted = newsEventsRepo.insertNewsEvent({
                    player_id: playerId,
                    message_type: raw.message_type,
                    occurred_at: raw.occurred_at,
                    game_planet_id: raw.game_planet_id || null,
                    system_id: raw.system_id || null,
                    other_player_id: otherPlayerId,
                    population_delta,
                    credited_player_id,
                    matched_battle_report_id,
                });
                if (wasInserted) inserted++;
            } catch (entryErr) {
                console.warn(`[News Sync] player ${playerId}: skipping entry that failed to insert:`, entryErr.message);
            }
        }

        if (maxOccurredAt) newsEventsRepo.advanceWatermark(playerId, maxOccurredAt);

        res.json({ success: true, inserted });
    } catch (err) {
        console.error(`[DB Error] News sync failed for player ${playerId}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

module.exports = router;
