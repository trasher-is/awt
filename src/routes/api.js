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
router.use(require('./trade'));
router.use(require('./search'));
router.use(require('./incoming'));
router.use(require('./routes'));

module.exports = router;
