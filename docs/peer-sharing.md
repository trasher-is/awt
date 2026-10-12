# Peer sharing between alliance hubs

Several alliances can each run their own AWT hub on their own server and share intel
with each other. Nothing is pooled. Every hub keeps its own database, and every alliance
decides, partner by partner, what it lets that partner read.

## How it works

```
 Alliance A's hub                          Alliance B's hub
 ───────────────                           ───────────────
 Admin → Peer Sharing → What we share      Admin → Peer Sharing → What we read
   "B may read: systems, players"            "A at https://a.example, token awtp_…"
          │                                          │
          │   GET /peer-api/v1/feed?kind=players     │  every PEER_PULL_MINUTES
          │ ◄──────────── Bearer awtp_… ─────────────┤
          │ ─────────────── JSON page ─────────────► │
          ▼                                          ▼
   reads A's own tables                     stores in peer_intel (kept apart)
   (what A's members saw)                   members browse it in "Shared Intel"
```

* **Links go one way.** A sharing with B gives A nothing in return. If B wants to share
  back, B's admin creates a link for A on B's hub. The two sides can share different things.
* **Pull, not push.** The partner reads your feed with a token you issued. You never
  connect to them to share. Revoking or pausing the link stops access at once.
* **Nothing is passed on.** Received intel goes into its own table (`peer_intel`), and
  the outgoing feed reads only the tables your own members fill. If A shares with B and B
  shares with C, nothing of A's reaches C. `src/utils/peer-feed.test.js` pins this.
* **It never touches the game.** The feed serves what is already in the database. The
  puller only talks to the partner addresses an admin entered, and refuses any address on
  the game's own host.

## Setting up a share (the side that gives)

1. Admin → Peer Sharing → **What we share** → New partner.
2. Name the partner and tick what they may read:

   | Kind | What it contains |
   |---|---|
   | Systems & planets | System name and position; each planet's owner, population, starbase, siege and fleet flags |
   | Player profiles & intel | Level, points, rank, race, sciences, planets, CV, home system |
   | Alliances | Tag, name, member count, rank, points |
   | Fleet sightings | Owner, location, destination, ships, CV, arrival time |
   | Fleet locations | Each player's ranked strongest fleets: rank, ships, CV, the planet the ranking names |
   | Incomings on our planets | Attacker, target planet, ships, CV, arrival. Not who covers it, the defence plan or the Discord alert |
   | Battle reports | Both sides, CV, losses, ships, winner, location |

   The exact fields are listed in `src/utils/peer-kinds.js`. A field not listed there is
   never sent. Logins, activity times, country, who in your alliance entered a piece of
   intel, who covers an incoming, defence choices, and every account, plan, route, trade,
   note and Discord table are never shared in any kind.
3. **Hide our alliance and allies** is on by default. With it on, the partner gets no
   player profiles, fleets, fleet locations or battle reports for your own alliance (found from the Alliance
   Stats roster and from the alliances your hub's own accounts play in) or for any tag in
   Alliance Relations → Allied. Planets those alliances own still show owner and population (the
   game's map shows that to anyone with vision), but not starbase, fleet or siege.
   Incomings are attacks on your own planets, so the target side is never filtered; the
   switch itself is the choice. The filter applies to the attacker's tag.
   **Also hide tags** hides more alliances for this partner only.
4. **Create link** shows the hub address and a token **once**. Send both to the partner's
   admin privately. Only a hash of the token is stored, so it cannot be shown again. If it
   is lost, revoke the link and create a new one.

You can change what a partner gets at any time. Pausing or revoking takes effect on their
next request. What they already received stays with them.

## Reading a partner (the side that receives)

1. Admin → Peer Sharing → **What we read** → enter the partner's name, their hub address
   (`https://…`) and the token they sent you.
2. **Add** saves it and pulls straight away. After that it pulls every
   `PEER_PULL_MINUTES` (default 5).
3. Members see the result under **Shared Intel** in the sidebar. Every row shows which
   partner it came from and when that partner's members observed it.

**Remove** deletes the partner and everything they ever sent. **Pause** stops pulling but
keeps what you have.

## What is deliberately not in this version

* **Shared intel is not merged into Players, Systems, Fleets or the map.** It has its own
  panel. Merging means deciding, field by field, whether our observation or the partner's
  is fresher, and showing members where each value came from. That deserves its own change.
* **No deletions are sent.** If a partner's fleet row disappears, your copy stays until
  it is 10 days old, the same age at which the hub drops its own fleet sightings.
* **Login and activity data is not shared** (no Sleep Map data). Adding it is a one-line
  change in `peer-kinds.js`, but it is the most personal data the hub holds about other
  players, so it should be a deliberate decision.

## Operations

* **Backups.** `awt.db` now holds the tokens of the hubs you read from (in
  `peer_sources.token`, in the clear, because they are sent on every pull). Treat backups
  as secret, as `docs/operations.md` already says. Tokens you issued are stored only as
  hashes.
* **Reverse proxy.** `/peer-api/*` must reach the app like everything else. There is no
  cookie and no session on that path.
* **Rate limit.** `PEER_FEED_MAX` (default 120 requests/minute per address). One full
  pull of a large galaxy is a few dozen requests.
* **Logs.** Creating or revoking a link and adding or removing a source are logged with
  the admin's name. A failed scheduled pull is logged with the reason, which is also shown
  on the admin page.

## Protocol (for anyone writing a compatible client)

* `GET /peer-api/v1/hello` with `Authorization: Bearer <token>` →
  `{ "v": 1, "kinds": ["systems", "players"] }`
* `GET /peer-api/v1/feed?kind=<kind>&after=<cursor>&limit=<≤500>` →
  `{ "kind", "items": [{ "key", "changedAt", "data" }], "next", "more" }`

`changedAt` is UTC `YYYY-MM-DD HH:MM:SS`. The cursor is `changedAt|id` of the last row
in the page window. Pass `next` back as `after` until `more` is false. A row that changes
again later shows up again after any older cursor. A missing, wrong or revoked token gets
the same `401`. A kind the token was not granted gets `403`.
