const express = require('express');
const { blockGuestWrites } = require('./_middleware');
const router = express.Router();

// The guest role is enforced here, in front of every domain router, so a new write
// endpoint is protected the moment it is added rather than whenever someone remembers.
// Guests keep every GET; see SAFE_POST_PATHS in _middleware.js for the handful of POSTs
// that only compute.
router.use(blockGuestWrites);

// Domain routers — split out of this file for maintainability.
// All mount at the same base path, so route URLs are unchanged.
router.use(require('./auth'));
router.use(require('./sync'));
router.use(require('./admin'));
router.use(require('./intel'));
router.use(require('./unicorn'));
router.use(require('./userSettings'));
router.use(require('./battleRace'));
router.use(require('./trade'));
router.use(require('./roadToTa'));
router.use(require('./myPlanets'));
router.use(require('./scienceResearch'));
router.use(require('./search'));
router.use(require('./incoming'));
router.use(require('./routes'));
router.use(require('./landRush'));

// A fingerprint of the client assets this process serves. An open tab polls it to notice
// that it is running code the server has replaced, and reloads itself once doing so costs
// the member nothing — see public/js/ui/version-watch.js and utils/build-version.js for
// why a long-lived tab otherwise never picks up a deploy at all. Deliberately unauthed and
// body-less: it has to keep answering for a tab whose session has lapsed (that tab is
// exactly the one most likely to be running something ancient), and a content hash of
// files already public discloses nothing.
// A tab that already knows which build it loaded also says so (?tab=&build=), so the admin
// page can list whose open tab is behind (src/utils/hub-tabs.js). Recorded only for a logged-in
// session; the answer is the same either way.
const { buildVersion } = require('../utils/build-version');
const { hubTabs } = require('../utils/hub-tabs');
const { browserFamily } = require('../utils/scan-run');
router.get('/version', (req, res) => {
    const userId = req.session && req.session.userId;
    if (Number.isInteger(userId) && req.query.tab && req.query.build) {
        const { browser, mobile } = browserFamily(req.get('user-agent'));
        hubTabs.report({ userId, tabId: String(req.query.tab), build: String(req.query.build), browser, mobile });
    }
    res.json({ version: buildVersion() });
});

module.exports = router;
