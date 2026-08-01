// Server-side entry point to the fleet travel-time formula.
//
// The formula itself lives in ONE place — public/js/utils/travel-model.js — which is
// written so that Node can require() it and the browser can import it, with no build
// step. This module used to hold a second copy that public/js/ui/travel-calc-ui.js
// mirrored by hand; both now call the same code, so the panel and the Discord alerts
// cannot disagree about a route.

const model = require('../../public/js/utils/travel-model.js');

module.exports = {
    calcTravelSeconds: model.calcTravelSeconds,
    formatTime: model.formatTime,
    systemDistance: model.systemDistance
};
