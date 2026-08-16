#!/usr/bin/env bash
# Provision Sip Ledger on a fresh Ubuntu DigitalOcean droplet.
#
# Idempotent: safe to re-run after a git pull to redeploy. Existing secrets in
# /etc/sip-ledger/env are never overwritten.
#
#   sudo SIP_DOMAIN=sip.example.com ./deploy/install.sh
#
# Run it from a checkout, as root. Point the droplet's DNS A record at the box
# before running, or Caddy's certificate request will fail.

set -euo pipefail

SIP_DOMAIN="${SIP_DOMAIN:-sip.example.com}"
APP_DIR=/opt/sip-ledger
ETC_DIR=/etc/sip-ledger
STATE_DIR=/var/lib/sip-ledger
NODE_MAJOR=24
# Pinned from https://github.com/nodesource/distributions. Verify independently
# before trusting it; a wrong value here fails closed, which is the point.
NODESOURCE_FPR="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo $0)"; exit 1; }

say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# sqlite3 is here for the documented backup procedure, not for the app —
# better-sqlite3 is self-contained.
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring \
  apt-transport-https rsync jq sqlite3 openssl >/dev/null

say "Ensuring Node ${NODE_MAJOR}"
current_major=0
if command -v node >/dev/null 2>&1; then
  current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi
if [ "$current_major" -lt "$NODE_MAJOR" ]; then
  # better-sqlite3 v13 ships prebuilt binaries for linux-x64 and linux-arm64,
  # so no compiler toolchain is needed here — which also means a 1 GB droplet
  # will not run out of memory during install.
  # Configure the signed APT repository directly rather than piping a remote
  # script into a root shell: setup_NN.x runs whatever the endpoint returns,
  # with no signature check, as root.
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  chmod 0644 /usr/share/keyrings/nodesource.gpg

  fingerprint="$(gpg --show-keys --with-colons /usr/share/keyrings/nodesource.gpg \
    | awk -F: '/^fpr:/ {print $10; exit}')"
  echo "    NodeSource signing key ${fingerprint}"
  if [ "$fingerprint" != "$NODESOURCE_FPR" ]; then
    echo "NodeSource signing key fingerprint does not match the pinned value."
    echo "  expected ${NODESOURCE_FPR}"
    echo "  got      ${fingerprint}"
    echo "Refusing to install. Verify against https://github.com/nodesource/distributions"
    exit 1
  fi

  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  hash -r  # forget the cached path to the old node
fi
NODE_BIN="$(command -v node)"
echo "    node $(node -v) at ${NODE_BIN}"
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  cat <<EOF
Node ${NODE_MAJOR}+ is required, but ${NODE_BIN} is $(node -v).
NodeSource installs to /usr/bin/node; if you manage node with nvm or asdf, that
version is shadowing it on PATH. Either remove it for root or point ExecStart in
the unit files at a Node ${NODE_MAJOR} binary.
EOF
  exit 1
fi

say "Creating the sip service user"
if ! id -u sip >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin sip
fi

say "Syncing the application to ${APP_DIR}"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude data \
  --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' \
  "$SRC_DIR"/ "$APP_DIR"/

say "Installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
# Fail loudly here rather than at 03:00 in a timer log.
node -e "require('better-sqlite3');console.log('    better-sqlite3 loads')"
chown -R root:root "$APP_DIR"

say "Preparing ${ETC_DIR}/env"
mkdir -p "$ETC_DIR"
if [ ! -f "$ETC_DIR/env" ]; then
  install -m 0640 -o root -g sip "$SRC_DIR/deploy/env.example" "$ETC_DIR/env"
  token="$(openssl rand -hex 32)"
  sed -i "s|^SIP_TOKEN=.*|SIP_TOKEN=${token}|" "$ETC_DIR/env"
  sed -i "s|^SIP_DB_PATH=.*|SIP_DB_PATH=${STATE_DIR}/sip.db|" "$ETC_DIR/env"
  NEW_ENV=1
else
  NEW_ENV=0
  echo "    keeping the existing env file"
fi
chown root:sip "$ETC_DIR/env"
chmod 0640 "$ETC_DIR/env"

say "Installing systemd units"
for unit in sip-api.service sip-poller.service sip-poller.timer; do
  install -m 0644 "$SRC_DIR/deploy/$unit" "/etc/systemd/system/$unit"
done
# NodeSource puts node at /usr/bin/node, but a droplet that already had node
# from another source may not.
if [ "$NODE_BIN" != "/usr/bin/node" ]; then
  sed -i "s|^ExecStart=/usr/bin/node|ExecStart=${NODE_BIN}|" \
    /etc/systemd/system/sip-api.service /etc/systemd/system/sip-poller.service
fi
systemctl daemon-reload

say "Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

say "Configuring the ${SIP_DOMAIN} vhost"
mkdir -p /etc/caddy/conf.d
sed "s|sip\.rexlorenzo\.com|${SIP_DOMAIN}|" \
  "$SRC_DIR/deploy/Caddyfile.snippet" > /etc/caddy/conf.d/sip.caddyfile
# The stock Caddyfile has no import line; add one rather than appending the
# site block, so re-running this script cannot duplicate it.
if ! grep -q '^import /etc/caddy/conf.d/\*\.caddyfile' /etc/caddy/Caddyfile 2>/dev/null; then
  printf '\nimport /etc/caddy/conf.d/*.caddyfile\n' >> /etc/caddy/Caddyfile
fi
# Abort before touching a running Caddy. A restart with an invalid config stops
# the working instance and then fails to start it again, taking down TLS for
# anything else on the box.
if ! caddy validate --config /etc/caddy/Caddyfile; then
  echo
  echo "caddy validate failed. Not reloading — the current Caddy is left running."
  echo "Inspect /etc/caddy/conf.d/sip.caddyfile and /etc/caddy/Caddyfile, then re-run."
  exit 1
fi

say "Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  # 8412 is deliberately not opened: the API binds to loopback and is reached
  # only through Caddy.
  ufw status | head -1
fi

say "Starting services"
systemctl enable --now sip-api.service >/dev/null
systemctl restart sip-api.service
systemctl enable --now sip-poller.timer >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

sleep 2
if curl -fsS --max-time 5 http://127.0.0.1:8412/health >/dev/null; then
  echo "    API healthy on loopback"
else
  warn "API not answering — journalctl -u sip-api -n 50"
fi

say "Done"
if [ "$NEW_ENV" = "1" ]; then
  cat <<EOF

  Next, and nothing works until you do it:

  1. Put your Gmail app password in ${ETC_DIR}/env (IMAP_USER / IMAP_PASSWORD).
     Google Account -> Security -> App passwords. Not your login password.

  2. Verify the parser against your real mailbox before trusting any count:

       cd ${APP_DIR} && set -a && . ${ETC_DIR}/env && set +a \\
         && npm run probe -- --expect 6

  3. Restart so the poller picks up the credentials:

       systemctl restart sip-poller.service && journalctl -u sip-poller -n 20

  Your API token (put this in the widget and the SwiftBar env file):

     $(grep '^SIP_TOKEN=' "$ETC_DIR/env" | cut -d= -f2)

  Test from your laptop once DNS and TLS are up:

     curl -H "Authorization: Bearer <token>" https://${SIP_DOMAIN}/api/sip

EOF
else
  echo "    Redeployed. systemctl status sip-api sip-poller.timer"
fi
