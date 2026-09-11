// Which alliance tags count as "friendly" for this hub — our own alliance (derived the
// same way the Galaxy Archive's own-tag detection works: via app-linked members' current
// alliance) plus whatever's configured in Admin -> Alliance Relations (the allied list
// from issue #114). Originally local to routes.js (issue #147's own-destination travel
// halving); extracted so intel.js's ally-name resolution (spy.js's "Allied Siege by X"
// pill) can use the SAME definition instead of the narrower "has a hub account" list it
// used before — a real alliance member with no hub login of their own (confirmed live,
// 2026-09-11: BaldWithABeard, a RAID member with full game-synced intel but no app_users
// row) was invisible to that older, name-list-only check.
const alliancesRepo = require('../repositories/alliances');
const playersRepo = require('../repositories/players');
const settingsRepo = require('../repositories/settings');

function friendlyAllianceTags() {
    const memberIds = alliancesRepo.getAllianceMemberStatIds().map(r => r.player_id);
    const ownTag = (playersRepo.getAllianceTagForMembers(memberIds) || {}).tag || null;
    const tags = new Set(settingsRepo.getTagListSetting('alliance_relations_allied'));
    if (ownTag) tags.add(String(ownTag).toUpperCase());
    return tags;
}

module.exports = { friendlyAllianceTags };
