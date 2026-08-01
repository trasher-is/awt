// Server-side entry point to the battle model.
//
// This file used to hold its own hand-copied port of the model, which is exactly how
// the bot and the dashboard drifted apart. The model now lives in ONE place —
// public/js/utils/battle-model.js — which is written so that Node can require() it and
// the browser can import it, with no build step. This module only re-exports the parts
// the server uses (fleet-only interception: no starbase, so only ships + racial/science
// stats matter).
//
// Verified bit-exact against the previous implementation over 170,610 fleet/stat
// combinations at the time of the switch — no behaviour change for callers.

const model = require('../../public/js/utils/battle-model.js');

module.exports = {
    winChance: model.winChance,
    resolveStats: model.resolveStats,
    cvOf: model.cvOf,
    simulate: model.simulate,
    SHIPS: model.SHIPS
};
