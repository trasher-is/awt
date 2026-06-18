const express = require('express');
const router = express.Router();

// Domain routers — split out of this file for maintainability.
// All mount at the same base path, so route URLs are unchanged.
router.use(require('./auth'));
router.use(require('./sync'));
router.use(require('./admin'));
router.use(require('./intel'));
router.use(require('./search'));

module.exports = router;
