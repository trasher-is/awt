# AWT — Alliance Intelligence Hub

A private tool for an alliance in the browser strategy game
[astrowars.games](https://astrowars.games). It is one Node.js process that acts as a
reverse proxy in front of the game, collects what members see into a shared SQLite
database, and exposes that back through a dashboard and a Discord bot.

## How it fits together

Members reach the game *through* this server rather than directly. The proxy injects a
script into each game page; that script reads the page's DOM and posts what it finds to
the hub, so intel gathered by one member is available to everyone.

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
| `public/js/scrapers/` | Page parsers injected into the game |
| `public/js/ui/` | Dashboard panel logic |
| `public/userscripts/` | Standalone Tampermonkey script for redzone |

## Running it

```bash
npm install
cp .env.example .env      # then fill it in
npm start                 # or: npm run dev  (nodemon)
```

Node 18 or newer. The database file is created automatically on first start.

On a completely fresh database the server creates an `admin` account and prints a
**one-time password to the console**. Log in with it and change it in the admin panel
straight away — it is not stored anywhere else.

Configuration is entirely through `.env`; every variable is documented with its default
in [`.env.example`](.env.example). Nothing is required for the app to boot except
`DISCORD_TOKEN` if you want the bot.

In production it runs under pm2. Two settings matter there:

- `TRUST_PROXY=1` when behind nginx/Caddy/Cloudflare, so the real client IP is seen
- `COOKIE_SECURE=false` only if the hub is served over plain HTTP

## Tests

```bash
npm test
```

Runs the travel-time harness, which checks the formula in `src/utils/travel-calc.js`
against timings recorded in the game and fails if the worst error exceeds 2%.

## Notes for anyone working on this

- **Scrapers are tied to the game's HTML.** They match on column positions and English
  label text. If the game changes its markup — or a member plays with a different
  interface language — parsing can return empty or shifted values *without raising an
  error*. That is the first place to look when data goes wrong.
- **Some formulas exist in more than one copy.** `src/utils/travel-calc.js` is mirrored
  by hand in `public/js/ui/travel-calc-ui.js`, and the battle constants in
  `src/utils/battle.js` are duplicated in `public/js/ui/battle-calc.js` and again inside
  the `!battle` command. Recalibrating one does not update the others.
- **The battle model is fitted, not derived.** Its constants were tuned against samples
  from the in-game calculator and it is accurate to roughly ±3%. There is no test for it.
- `awt.db`, `.env`, `.session-secret` and `config.json` are gitignored and should stay
  that way.
