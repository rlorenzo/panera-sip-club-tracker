#!/usr/bin/env bash
# Sip Ledger — SwiftBar plugin (macOS)
#
# Install:
#   cp sip.5m.sh ~/Library/Application\ Support/SwiftBar/
#   chmod +x ~/Library/Application\ Support/SwiftBar/sip.5m.sh
#   Put SIP_URL and SIP_TOKEN in ~/.config/sip-ledger/env
#
# <bitbar.title>Sip Ledger</bitbar.title>
# <bitbar.desc>Panera Sip Club redemptions left this period</bitbar.desc>
# <bitbar.dependencies>curl,jq</bitbar.dependencies>

set -uo pipefail

CONFIG="${HOME}/.config/sip-ledger/env"
# shellcheck disable=SC1090
[ -f "$CONFIG" ] && . "$CONFIG"

SIP_URL="${SIP_URL:-https://sip.example.com/api/sip}"
SIP_TOKEN="${SIP_TOKEN:-}"
CACHE="${TMPDIR:-/tmp}/sip-ledger.json"

# SwiftBar runs plugins with a bare PATH; Homebrew's jq is not on it.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

if [ "${1:-}" = "log" ]; then
  curl -fsS -X POST "${SIP_URL}/manual" \
    -H "Authorization: Bearer ${SIP_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >/dev/null
  exit 0
fi

RESPONSE="$(curl -fsS --max-time 10 -H "Authorization: Bearer ${SIP_TOKEN}" "$SIP_URL" 2>/dev/null)"

if [ -n "$RESPONSE" ]; then
  printf '%s' "$RESPONSE" >"$CACHE"
  OFFLINE=0
elif [ -f "$CACHE" ]; then
  RESPONSE="$(cat "$CACHE")"
  OFFLINE=1
else
  echo "sip ?"
  echo "---"
  echo "API unreachable | color=red"
  exit 0
fi

read -r USED CAP REMAINING DAY DAYS_LEFT PACE LEVEL COOLING READY_AT STALE <<EOF
$(printf '%s' "$RESPONSE" | jq -r '[.used,.cap,.remaining,.day,.daysLeft,.pace,.level,.cooling,(.readyAt//"-"),(.staleMinutes//-1)] | @tsv')
EOF

case "$LEVEL" in
  hit) COLOR="red" ;;
  warn) COLOR="red" ;;
  pace) COLOR="orange" ;;
  *) COLOR="" ;;
esac

LABEL="${USED}/${CAP}"
[ "$OFFLINE" = "1" ] && LABEL="${LABEL} ⚠"

if [ -n "$COLOR" ]; then
  echo "${LABEL} | color=${COLOR}"
else
  echo "${LABEL}"
fi

echo "---"

if [ "$COOLING" = "true" ] && [ "$READY_AT" != "-" ]; then
  # BSD date on macOS; -j -f parses without setting the clock.
  READY_EPOCH="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$READY_AT" '+%s' 2>/dev/null || echo 0)"
  NOW_EPOCH="$(date -u '+%s')"
  MINS=$(((READY_EPOCH - NOW_EPOCH + 59) / 60))
  if [ "$MINS" -gt 0 ]; then
    printf 'Next drink in %d:%02d | color=orange\n' $((MINS / 60)) $((MINS % 60))
  else
    echo "Ready now | color=green"
  fi
else
  echo "Ready now | color=green"
fi

echo "${REMAINING} left · day ${DAY} of 30"
echo "${DAYS_LEFT} days left in period"
echo "On pace for ${PACE}"

# A silently stale widget is worse than no widget, so surface it in the menu.
if [ "$OFFLINE" = "1" ]; then
  echo "Showing cached data — API unreachable | color=red"
elif [ "$STALE" != "-1" ] && [ "$STALE" -gt 30 ]; then
  echo "Poller last ran ${STALE}m ago | color=red"
fi

echo "---"
echo "Log a drink | bash='$0' param1=log terminal=false refresh=true"
echo "Refresh | refresh=true"
