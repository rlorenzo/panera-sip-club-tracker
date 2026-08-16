# Sip Ledger

Personal Panera Sip Club redemption tracker. A server-side Gmail poller feeds a
JSON endpoint, consumed by an iPhone widget, a Mac menu bar item, and push
alerts.

Single user. Not distributed. Not on any app store.

Two numbers matter and neither is visible anywhere else: **how many redemptions
are left in the current rolling period**, and **when the 2-hour cooldown
expires**.

```
Gmail (IMAP, app password)
   │  poll every 10 min
   ▼
poller.js ──► SQLite (redemptions, meta)
                 │
                 ▼
            Fastify /api/sip  ──► Caddy (sip.rexlorenzo.com)
                 │                    │
                 │                    ├──► Scriptable widget (iPhone)
                 │                    └──► SwiftBar plugin (macOS)
                 ▼
            ntfy push (thresholds, cooldown expiry)
```

## Status

| Phase | | Notes |
|---|---|---|
| 0 — verify the source | done | Gate passed against live mail; count = 6. Two parser bugs found and fixed. See [docs/phase0-verification.md](docs/phase0-verification.md) |
| 1 — poller and store | done | Idempotent by `order_id`; systemd timer at 10 min |
| 2 — API | done | Bearer auth, rate limited, `cycleFor` covered incl. boundaries |
| 3 — iPhone widget | done | Small + medium, cached fallback rendered dimmed |
| 4 — Mac menu bar | done | SwiftBar, 5 min, log-a-drink from the dropdown |
| 5 — alerts | done | ntfy, transition-only |

Everything is verified by `npm test` except the two things that need real
credentials and real devices: an end-to-end IMAP fetch (`npm run probe`) and the
widget rendering on a phone.

## Requirements

Node **24** (`engines` enforces it). `better-sqlite3` below v13 does not support
Node 24's ABI — it compiles but crashes in native destructors during process
teardown, which shows up as tests that pass individually and fail as a suite.

## Setup

```sh
npm install
cp deploy/env.example /etc/sip-ledger/env   # then fill it in, chmod 0600
```

You need a Gmail **app password**, not the account password and not OAuth
(Google Account → Security → App passwords). Generate the API token with
`openssl rand -hex 32`.

### Verify before trusting anything (Phase 0 gate)

```sh
npm run probe -- --since 2026-08-11 --expect 6
```

Prints every message the parser sees and why it did or didn't count, then exits
non-zero if order numbers fail to parse, collide, or the total misses
`--expect`. **Re-run this whenever Panera changes their email template.**

### Deploy

```sh
sudo install -d -o sip -g sip -m 0750 /var/lib/sip-ledger
sudo cp deploy/sip-*.service deploy/sip-poller.timer /etc/systemd/system/
sudo systemctl enable --now sip-api.service sip-poller.timer
# append deploy/Caddyfile.snippet to the Caddyfile, then:
sudo systemctl reload caddy
```

## API

`GET /api/sip`, bearer token in `Authorization`.

```json
{
  "used": 6, "cap": 30, "remaining": 24,
  "cycleStart": "2026-08-11", "cycleEnd": "2026-09-09",
  "day": 5, "daysLeft": 25, "pace": 36,
  "lastAt": "2026-08-15T16:01:55Z", "readyAt": "2026-08-15T18:01:55Z",
  "cooling": false, "level": "pace",
  "lastPollAt": "2026-08-15T17:40:00Z", "staleMinutes": 12
}
```

`level` ∈ `ok | pace | warn | hit` — `hit` at `used >= 30`, `warn` at
`used >= 27`, `pace` when the projection exceeds 31, `ok` otherwise.

- `POST /api/sip/manual` `{"occurredAt": "<ISO>"}` — inserts with a synthetic
  `manual-<epoch-ms>` id. Idempotent for a given instant.
- `DELETE /api/sip/manual/:id` — manual rows only. Deleting an email-sourced row
  would be undone by the next poll, so it is refused rather than reported as a
  success that does not stick.
- `GET /health` — unauthenticated liveness, no data.

**Clients must surface `staleMinutes` above 30.** Both shipped clients do; a
silently stale widget is worse than no widget.

## Clients

- **iPhone** — `clients/scriptable/sip-widget.js`. Paste into Scriptable, set
  `API_URL` and `TOKEN`. Caches the last good response and renders it dimmed with
  an age marker when the network is gone. Sets `refreshAfterDate` to `readyAt`
  while cooling.
- **macOS** — `clients/swiftbar/sip.5m.sh`. Reads `SIP_URL`/`SIP_TOKEN` from
  `~/.config/sip-ledger/env`. "Log a drink" POSTs a manual redemption.

## Design notes

**Rolling periods, not calendar months.** Annual subscribers get 30 per rolling
30-day period anchored to the subscription start date (`SIP_ANCHOR_DATE`,
2026-07-12 here). Unused redemptions do not carry over.

**`daysLeft` is `30 - day`.** The spec gave both a formula
(`ceil((start + 30d - now) / DAY)`) and an expected value (25 for the documented
fixture); they disagree by one for any `now` past midnight — the formula yields
26. `30 - day` matches the stated expectation and the sample API response, and
keeps `day + daysLeft === 30` as an invariant the widget copy relies on.

**Ingestion is idempotent by `order_id`.** Re-polling an overlapping window is a
no-op, so the timer can catch up after downtime without double-counting, and a
poll killed mid-run leaves the same row count as a clean one. Both are tested.

**Alerts publish only on transitions.** `last_alert_level` and
`last_cooldown_alert` live in `meta`; a new period re-arms them. A push every ten
minutes repeating the same number gets muted within a day, and a muted channel
is a dead channel.

**No message bodies are ever persisted.** Parse, extract three fields, discard.

## Security

App password and bearer token live in the systemd `EnvironmentFile` (mode
`0600`), never in the repo — `.gitignore` covers `env` and `*.db` from the first
commit. The SQLite file is chmod `0600` on open. The API binds to loopback and is
reached only through Caddy, TLS only, rate limited at 120 req/min. Token
comparison is constant-time.

## Kill criteria

Still live, and worth re-reading before spending another evening on this:

1. Phase 0 count wrong and unfixable in an hour → **cleared**, the gate passed.
2. **Kiosk redemptions invisible to email** → *unresolved.* Every order in the
   verified window was placed through the app. If in-cafe scans are silent and
   get used regularly, the count runs low and manual entry is load-bearing
   rather than a convenience. Reconcile a full week against the app's history.
3. **Panera ships a remaining-count display of their own** → check on
   2026-08-19. If the number lands in their app, only the cooldown timer
   justifies this, and that is a 20-line Scriptable script with no server.
4. **Google removes app passwords** → fall back to a Gmail forwarding rule into
   an inbound-parse endpoint, not OAuth.
5. **Effort exceeds two evenings before Phase 3** → the manual tracker already
   covers the need. This is a convenience.

## Tests

```sh
npm test
```

45 tests: cycle boundaries (exact anchor, last millisecond, first millisecond of
the next period, contiguity), parsing against fixtures derived from all six
verified emails in both body shapes, store idempotency and interrupted-run
equivalence, the full API surface, and alert transition behaviour.
