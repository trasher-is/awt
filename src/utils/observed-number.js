const { parseLocaleNumber } = require('../../public/js/utils/parse-number.js');

// The display parser intentionally returns zero for garbage. An unknown observation
// must stay unknown in planning, where zero is a meaningful balance or hourly rate.
const NUMBER_TEXT = /^\+?(?:\d+(?:[.,]\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{1,3}(?:[ \u00a0\u202f\u2009\u2007]\d{3})+(?:[.,]\d+)?)$/;

function observedNumber(value, rate = false) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    const text = (rate ? value.replace(/\s*\/\s*h\s*$/i, '') : value).trim();
    if (!NUMBER_TEXT.test(text)) return null;
    // A leading zero makes a single separator unambiguously decimal. The general
    // display parser treats three trailing digits as grouping (1.234 -> 1234),
    // but applying that heuristic to 0.125 would inflate fractional hourly output.
    const number = /^\+?0[.,]\d+$/.test(text) ? Number(text.replace(',', '.')) : parseLocaleNumber(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

// Settings synchronized from the API use String(number), not localized display
// text: 0.125 is a fraction, even though a display parser can read it as grouping.
function positiveMachineNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? number : null;
}

module.exports = { observedNumber, positiveMachineNumber };
