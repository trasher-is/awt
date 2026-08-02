// JSON body handling for /hub-api.
//
// ─── WHY THIS IS NOT JUST express.json() ──────────────────────────────────────
// express.json() only fills req.body when the request's Content-Type matches. Anything
// else — a POST with no Content-Type at all, text/plain from sendBeacon, a form encoding,
// a request with no body — leaves req.body UNDEFINED.
//
// Twenty-six handlers under /hub-api destructure req.body. Nineteen of them do it without
// a guard, so any of those requests crashes the handler:
//
//   TypeError: Cannot destructure property 'systems' of 'req.body' as it is undefined.
//       at src/routes/sync.js:444:13
//
// That exact line was in the production error log. Express answers such a crash with its
// default error page, which means a 500 whose BODY contains the stack trace and absolute
// server paths — and POST /hub-api/login is reachable without logging in, so anyone could
// read it.
//
// Fixing nineteen call sites would leave the twentieth to be written next month. The
// mount point is the one place that can hold the invariant: below here, req.body is always
// an object, and every handler's existing validation then produces the 400 it was written
// to produce.
//
// Malformed JSON and oversized bodies are answered here too, in JSON, because the callers
// are all fetch() and an HTML error page is not something they can read.

const express = require('express');

function hubBody({
    // Galaxy and system syncs legitimately post megabytes of scraped rows; nothing else
    // does. Everything else gets a ceiling that stops one account tying up the process.
    syncLimit = '50mb',
    limit = '2mb',
    isSync = req => req.path.startsWith('/sync'),
    makeParser = options => express.json(options),
} = {}) {
    const syncJson = makeParser({ limit: syncLimit });
    const hubJson = makeParser({ limit });

    return function hubBodyMiddleware(req, res, next) {
        const parser = isSync(req) ? syncJson : hubJson;

        parser(req, res, (err) => {
            if (err) {
                const tooLarge = err.type === 'entity.too.large' || err.status === 413;
                return res.status(tooLarge ? 413 : 400).json({
                    error: tooLarge
                        ? 'Request body is too large.'
                        : 'Request body is not valid JSON.',
                });
            }

            // The invariant every handler below this point relies on.
            if (req.body === undefined || req.body === null) req.body = {};
            next();
        });
    };
}

module.exports = { hubBody };
