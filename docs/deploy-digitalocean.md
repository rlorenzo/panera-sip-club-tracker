# Deploying to a DigitalOcean droplet

Target: Ubuntu 24.04 LTS. The scripted path is `deploy/install.sh`; the rest of
this page is what it does, what it deliberately does not do, and how to check it
actually worked.

## Droplet sizing

The **$6/mo basic droplet (1 GB / 1 vCPU / 25 GB)** is enough, and is what this
is written for.

Memory used to be the trap here: `better-sqlite3` normally compiles from source,
and `node-gyp` reliably OOMs on a 512 MB droplet. It does not apply anymore —
v13 ships prebuilt binaries for `linux-x64` and `linux-arm64`, so `npm ci`
downloads a `.node` file and never invokes a compiler. No `build-essential`, no
swap file, no memory tuning.

If you are on the 512 MB droplet it will still work, but the margin is thin
once Caddy is resident too.

## Before you run anything

1. **Point DNS at the droplet.** An `A` record for `sip.<your-domain>` →
   droplet IPv4. Caddy requests a certificate on first start; if DNS is not
   resolving yet the request fails and you get no TLS. Verify with
   `dig +short sip.<your-domain>`.
2. **Have a Gmail app password.** Google Account → Security → 2-Step
   Verification → App passwords. This is not your login password and not OAuth.
   Sixteen characters, no spaces.
3. **Know your anchor date.** The subscription start date, `2026-07-12` here.
   Rolling 30-day periods are counted from it. Getting this wrong silently
   shifts every period boundary.

## Install

```sh
ssh root@<droplet-ip>
git clone https://github.com/rlorenzo/panera-sip-club-tracker.git
cd panera-sip-club-tracker
$EDITOR deploy/deploy.conf     # SIP_DOMAIN at minimum
sudo ./deploy/install.sh
```

All site-specific values live in `deploy/deploy.conf`: domain, loopback port,
Node major version, the pinned NodeSource signing-key fingerprint, install
paths, and the service user. Each is written `${VAR:-default}`, so an
environment variable overrides it for a single run without editing the file.

**Verify `NODESOURCE_FPR` yourself** against
[nodesource/distributions](https://github.com/nodesource/distributions) before
the first install. A pinned fingerprint nobody checked is trust-on-first-use
with extra steps — though a wrong value fails closed rather than open.

The script is idempotent — re-run it after a `git pull` to redeploy. It will not
overwrite `/etc/sip-ledger/env` once it exists, so your credentials survive.

It installs Node 24 from NodeSource if the box has something older, creates the
`sip` system user, syncs the app to `/opt/sip-ledger`, runs `npm ci --omit=dev`,
generates a 32-byte API token, installs the two units and the timer, installs
Caddy, writes the vhost, opens 80/443 in `ufw`, and starts everything.

It prints the generated token at the end. That token goes in the Scriptable
widget and in `~/.config/sip-ledger/env` on your Mac.

## Then finish the credentials

Nothing polls until you do this:

```sh
sudo nano /etc/sip-ledger/env        # IMAP_USER, IMAP_PASSWORD, NTFY_TOPIC
sudo systemctl restart sip-poller.service
journalctl -u sip-poller -n 20
```

**Run the Phase 0 gate against the real mailbox before trusting the count.**
Everything verified so far was verified against message bodies read through a
different transport; this is the first time the parser meets a real IMAP fetch:

```sh
cd /opt/sip-ledger
sudo -u sip bash -c 'set -a; . /etc/sip-ledger/env; set +a; npm run probe -- --expect 6'
```

If that exits non-zero, stop and fix the parser. A count that is silently wrong
is worse than no count.

## Verify

```sh
systemctl status sip-api sip-poller.timer
systemctl list-timers sip-poller.timer          # next run should be <10 min out
curl -s localhost:8412/health                    # {"ok":true}
curl -s -H "Authorization: Bearer $TOKEN" https://sip.<domain>/api/sip | jq .
```

A good response has a `used` that matches the app, `staleMinutes` in single
digits, and `lastPollAt` within the last ten minutes.

## What the units do

Both services run as `sip`, `ProtectSystem=strict`, with `/var/lib/sip-ledger`
as the only writable path (via `StateDirectory=`, which also creates it with the
right ownership).

`RestrictAddressFamilies` includes **`AF_UNIX`** alongside the INET families.
This is not decorative: name resolution goes through systemd-resolved over a
unix socket, so a unit restricted to `AF_INET AF_INET6` cannot resolve
`imap.gmail.com` and the poller fails with an opaque DNS error.

The API binds to `127.0.0.1:8412` and `ufw` never opens that port. Caddy is the
only thing that reaches it, and Caddy only routes `/api/sip`, `/api/sip/*` and
`/health` — everything else 404s before it touches Node.

The poller is a `oneshot` on a timer rather than a daemon: nothing to leak, and
`Persistent=true` makes it catch up after the droplet was down instead of
skipping the window. Ingestion is idempotent by `order_id`, so catching up
cannot double-count.

## Backups

The whole state is one SQLite file. It is small and it is the only thing here
that cannot be rebuilt from the repo — though most of it *can* be rebuilt by
re-polling the mailbox, since ingestion is idempotent. Manual entries cannot.

```sh
sudo sqlite3 /var/lib/sip-ledger/sip.db ".backup '/root/sip-$(date +%F).db'"
```

Worth a weekly cron if you use manual entry much. DigitalOcean's droplet
backups (+20%) also cover it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Poller: `getaddrinfo EAI_AGAIN` | `AF_UNIX` missing from `RestrictAddressFamilies`, or resolved is down |
| Poller: `Invalid credentials` | Using the account password, not an app password; or 2FA is off so app passwords do not exist |
| `used` stuck at 0 while logs show messages | Order-number regex no longer matches. Run `npm run probe` — this is the exact failure the spec's original pattern would have caused |
| Caddy has no certificate | DNS not pointing at the droplet when Caddy first started. Fix DNS, then `systemctl restart caddy` |
| API 502 through Caddy, fine on loopback | `sip-api` restarted and Caddy cached a dead upstream; `systemctl reload caddy` |
| Tests pass alone, fail as a suite | Node <24 with better-sqlite3 <13 — native destructor crash at teardown |
| Widget shows a stale marker | Poller is failing. `journalctl -u sip-poller -n 50`. The marker is working as intended |

## Logs

```sh
journalctl -u sip-poller -f              # structured JSON, one line per run
journalctl -u sip-api -f
journalctl -u sip-poller | grep review_needed   # savings with nothing comped
sqlite3 /var/lib/sip-ledger/sip.db \
  'SELECT order_id, occurred_at FROM redemptions WHERE needs_review = 1'
```

`review_needed` lines are the ones to actually read: they mark orders where a
Sip Club discount applied but nothing was fully comped, which is the shape a
food-only discount would take. They are counted, not dropped — check them
against the app's order history.
