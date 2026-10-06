// For tests that run a sidebar UI file inside a vm context with its imports stripped: puts
// game-links.js's helpers on that context's globals, the way the stripped import would have
// provided them. Wrapped in a function so its private names (index, link, ...) cannot clash
// with the UI file's own top-level declarations. Needs `esc` already on the context.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/utils/game-links.js'), 'utf8')
    .replace(/^import\b[^\n]*\n/gm, '')
    .replace(/^export /gm, '');

function installGameLinks(context) {
    vm.runInContext(`(() => {\n${source}\nObject.assign(globalThis, { playerLink, allianceLink, systemLink, planetLink, setLinkIndex });\n})();`, context);
}

module.exports = { installGameLinks };
