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
  # Bounded like the GET below, and the exit status is surfaced: an
  # unconditional `exit 0` would tell the user the drink was logged when the
  # request had actually failed.
  if curl -fsS --max-time 10 -X POST "${SIP_URL}/manual" \
    -H "Authorization: Bearer ${SIP_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >/dev/null; then
    exit 0
  fi
  osascript -e 'display notification "Could not log the drink" with title "Sip Ledger"' 2>/dev/null || true
  exit 1
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

# Split on ASCII unit separator, not tab. Runs of IFS *whitespace* collapse
# into a single delimiter, so `IFS=$'\t'` would still swallow an empty field
# and shift every later value one position left; a non-whitespace delimiter
# yields one field per separator. US also cannot occur in the JSON values.
US=$(printf '\037')
IFS="$US" read -r USED CAP REMAINING DAY DAYS_LEFT PACE LEVEL COOLING READY_AT STALE <<EOF
$(printf '%s' "$RESPONSE" | jq -r '[.used,.cap,.remaining,.day,.daysLeft,.pace,.level,.cooling,(.readyAt//"-"),(.staleMinutes//-1)] | map(tostring) | join("\u001f")')
EOF

# jq missing, or a truncated cache file, leaves every variable empty; set -u
# does not catch that. Without this the label renders as "/" and the staleness
# test below dies with "integer expression expected".
case "$USED$CAP" in
  '' | *[!0-9]*)
    echo "sip ?"
    echo "---"
    echo "Malformed API response | color=red"
    echo "Check that jq is installed and \$SIP_URL is correct | color=red"
    exit 0
    ;;
esac

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

echo "${REMAINING} left · day ${DAY} of $((DAY + DAYS_LEFT))"
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
