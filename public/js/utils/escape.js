// HTML escaping for values that reach the page through innerHTML.
//
// Almost everything the hub renders originates with another player: names, alliance
// tags and plan notes are scraped from the game, so an opponent picks them. Interpolating
// them into an innerHTML template makes that their markup, running on this origin with
// the viewer's session - and the proxy strips the game's Content-Security-Policy, so
// there is no second line of defence.
//
// Use esc() for text inside an element and escAttr() for a value inside a quoted
// attribute. When a value is pure text with no surrounding markup, prefer assigning
// .textContent instead; that cannot be got wrong.

const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;'
};

// Escapes the characters that can break out of element content or a quoted attribute.
// Null and undefined become an empty string rather than the words "null"/"undefined".
export function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, ch => HTML_ENTITIES[ch]);
}

// Same rules; named separately so attribute interpolation reads as deliberate at the
// call site.
export const escAttr = esc;
