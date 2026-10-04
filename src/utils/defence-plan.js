// The defence plan for one attack: who chose to land before / after (Defence panel) and
// who is covering (the panel, the Discord button, the News page). Every place that changes
// either calls planChanged() so open panels update at once (src/utils/defence-live.js).
const defenceChoicesRepo = require('../repositories/defenceChoices');
const { getCovering } = require('./covering');
const live = require('./defence-live');

function planState(alertKey) {
    return { key: alertKey, choices: defenceChoicesRepo.listChoices(alertKey), covering: getCovering(alertKey) };
}

// After a cover toggle from anywhere: withdrawing cover also withdraws a before/after
// choice (they are one commitment), then everyone watching gets the new plan.
function afterCoverToggle(alertKey, name, added) {
    try {
        if (!added) defenceChoicesRepo.removeChoice(alertKey, name);
        planChanged(alertKey);
    } catch (e) {
        console.error('[Defence] plan update failed:', e.message);
    }
}

function planChanged(alertKey) {
    live.broadcast(alertKey, 'plan', planState(alertKey));
}

module.exports = { planState, planChanged, afterCoverToggle };
