# AWT — Alliance Intelligence Hub

A private tool for an alliance in the browser strategy game
[astrowars.games](https://astrowars.games). It is one Node.js process that acts as a
reverse proxy in front of the game, collects what members see into a shared SQLite
database, and exposes that back through a dashboard and a Discord bot.

## How it fits together

Members reach the game *through* this server rather than directly. The proxy injects a
script into each game page; that script reads the page's DOM and posts what it finds to
the hub, so intel gathered by one member is available to everyone. The dashboard can also
query the game's own REST API (`/api/v1`, forwarded through the same proxy under one
globally rate-limited budget — see [`docs/game-api.md`](docs/game-api.md)) and feeds those
answers into the same database.

```
browser ──► AWT proxy ──► astrowars.games
               │  injects public/js/main.js
               ▼
         scrapers read the page DOM
               │  POST /hub-api/sync/*
               ▼
            awt.db (SQLite)
               │
       ┌───────┴────────┐
       ▼                ▼
   dashboard        Discord bot
```

## Layout

| Path | What lives there |
|---|---|
| `server.js` | Express app: host routing, sessions, static files, route mounting, proxy |
| `src/database.js` | Schema and migrations. Opens `awt.db` next to this file |
| `src/proxy.js` | Reverse proxy to the main game, injects the hub script |
| `src/redzone-proxy.js` | Open, login-free proxy for `redzone.astrowars.games` on the `rz.*` subdomain |
| `src/discord_bot.js` | Discord bot: commands, incoming alerts, note reminders |
| `src/routes/` | API under `/hub-api` — auth, sync, intel, trade, notes, admin, search, incoming |
| `src/utils/` | Game maths: travel time, battle model, interceptor analysis |
| `public/` | Dashboard (`Wrapper.html`), admin panel, login page |
| `public/js/utils/` | Dual-runtime shared modules: the formulas, the rate gate, the game API client |
| `public/js/scrapers/` | Page parsers injected into the game |
| `public/js/ui/` | Dashboard panel logic |
| `public/userscripts/` | Standalone Tampermonkey script for redzone |

## Running it

```bash
npm install
cp .env.example .env      # then fill it in
npm start                 # or: npm run dev  (nodemon)
```

**Node 22** — the version in [`.nvmrc`](.nvmrc) and `package.json#engines`. That is the
runtime the committed lockfile was resolved for: `better-sqlite3` ships a native binary
per Node ABI and its own range stops before Node 26, so a newer Node fails at startup
with an ABI mismatch (`was compiled against a different Node.js version`) even though
`npm install` went through. `nvm use` / `fnm use` / `volta pin` all read the same file.
The database file is created automatically on first start.

### Switching Node versions

The SQLite binary in `node_modules` is built for one Node ABI. After changing the Node
version (or restoring `node_modules` from a machine that ran a different one), rebuild it
before starting the hub:

```bash
npm ci                          # clean install for the current Node — what CI runs
# or, keeping the rest of node_modules:
npm rebuild better-sqlite3
```

Pull requests are checked by the workflow in `.github/workflows/ci.yml`: a clean
`npm ci` on the `.nvmrc` runtime followed by `npm test`, once in UTC and once in
Europe/Warsaw. It reports only — merging to `main` stays a human decision
(see `AGENTS.md`).

On a completely fresh database the server creates an `admin` account and prints a
**one-time password to the console**. Log in with it and change it in the admin panel
straight away — it is not stored anywhere else.

Configuration is entirely through `.env`; every variable is documented with its default
in [`.env.example`](.env.example). Nothing is required for the app to boot except
`DISCORD_TOKEN` if you want the bot.

In production it runs under pm2. Two settings matter there:

- `TRUST_PROXY=1` when behind nginx/Caddy/Cloudflare, so the real client IP is seen
- `COOKIE_SECURE=false` only if the hub is served over plain HTTP

### Behind a reverse proxy

If something else terminates TLS in front of the hub, it **must forward the original
protocol**. Without it the app cannot tell the request arrived over HTTPS, so the session
cookie loses its `Secure` flag — and if you also set `COOKIE_SECURE=true`, no cookie is
sent at all and **nobody can log in** (people already holding a cookie stay logged in, so
it shows up as "after logging out I can't get back in"). The app warns once on startup
traffic when it spots this, naming the missing header.

nginx — inside the `location / { … }` that proxies to the app:

```nginx
proxy_pass http://localhost:3000;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;   # <- the one that is easy to forget
```

Then `nginx -t && systemctl reload nginx`.

Caddy and Traefik set `X-Forwarded-*` themselves — nothing to do. For Apache use
`ProxyPreserveHost On` plus `RequestHeader set X-Forwarded-Proto https`. Behind Cloudflare
the header arrives already set, but keep `TRUST_PROXY=1` so the real client IP is used.

Serving the hub over plain HTTP is supported (`COOKIE_SECURE=false`), it just means the
session cookie is not marked `Secure`.

### Deploying to a VPS

The steps above are the quick local/dev path. For putting AWT on a real server for an
alliance to use — SSH access, Node/pm2 setup, a domain with HTTPS via Nginx/Certbot, first
login, wiring up the Discord bot, and day-to-day operation — see the full walkthrough:
[Running AWT](https://claude.ai/code/artifact/de0752cc-dae1-409d-9736-c1b87c8eeab6).

## Backups and round resets

Both databases run in WAL mode, so copying `awt.db` while the hub is up is **not** a
backup. Use the operator script, which takes a consistent snapshot through SQLite's online
backup API, verifies it and prunes old ones:

```bash
node scripts/backup-db.js          # -> $AWT_BACKUP_DIR (set it outside this checkout)
node scripts/restore-db.js <backup-dir> --to /tmp/awt-check   # restore + verify, elsewhere
```

[`docs/operations.md`](docs/operations.md) has the full procedure — which files matter,
retention and permissions, the restore order, what happens to sessions, rollback — and the
list of which tables a round reset ("Nuke data") removes and which it keeps.

## Tests

```bash
npm test
```

Runs every suite in `src/utils/*.test.js` — they are discovered, not listed, so adding one
is a single new file. Among them: the travel-time and battle harnesses check the formulas
against timings and outcomes recorded in the game, and several suites assert on source
patterns rather than behaviour (that the rate limiter is actually called, that a rule
exists in only one place).

## Notes for anyone working on this

**Working on this repository with a coding agent, or alongside other people? Read
[`AGENTS.md`](AGENTS.md) first.** It covers the things that are expensive to rediscover:
the two JavaScript realms, the dual-runtime modules in `public/js/utils/`, the merge
discipline, and the rules that exist because of agreements outside this codebase.

- **Scrapers are tied to the game's HTML.** If the game changes its markup — or a member
  plays with a different interface language — parsing can return empty or shifted values.
  `public/js/utils/scrape-report.js` exists so that fails loudly instead of writing zeroes,
  and scrapers address elements structurally (header text, `href` shape, element ids)
  rather than by column position. This is still the first place to look when data goes
  wrong.
- **The formulas have one copy each.** Travel time lives in `public/js/utils/travel-model.js`
  and the battle model in `public/js/utils/battle-model.js`; the server, the Discord bot,
  the dashboard and the tests all load the same file. They used to be duplicated by hand,
  and the copies had drifted apart.
- **The battle model is fitted, not derived.** Its constants were tuned against samples
  from the in-game calculator. `src/utils/battle-calc.test.js` holds it to the recorded
  outcomes and the UI presents its answers as a band rather than a single number.
- **Five requests per second to the game is an agreement with its administrator**, not a
  tuning knob. See `public/js/utils/game-rate-limit.js`.
- `awt.db`, `sessions.db`, `.env`, `.session-secret` and `config.json` are gitignored and
  should stay that way.
