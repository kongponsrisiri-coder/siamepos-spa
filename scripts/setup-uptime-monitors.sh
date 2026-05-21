#!/usr/bin/env bash
# INFRA-001 (spa slice) — set up UptimeRobot monitors for SiamSpa.
#
# UptimeRobot's free plan covers 50 monitors with 5-min checks + email
# alerts. We add up to 6 monitors covering the spa API, the embeddable
# widget asset, the two public widget endpoints, the spa admin frontend,
# and the Baan Siam demo site.
#
# Idempotent: re-running skips monitors that already exist (matched by
# `friendly_name`) and only attempts those whose URLs are currently
# reachable. So you can run it now to set up the spa-api monitors and
# re-run later once spa.siamepos.co.uk + www.siamepos.com go live.
#
# Usage:
#   UPTIMEROBOT_API_KEY=ur123-xxxx ./scripts/setup-uptime-monitors.sh
#
# Optional env:
#   UPTIMEROBOT_ALERT_CONTACT_IDS  comma-separated alert-contact IDs.
#                                  If unset, the script lists your contacts
#                                  and asks you to re-run with the chosen
#                                  IDs (so an accidental run doesn't
#                                  attach the wrong one).
#
# Find your API key:  Uptime Robot dashboard → My Settings → API Settings
# Find contact IDs:    `getAlertContacts` (this script prints them for you).

set -euo pipefail

API="https://api.uptimerobot.com/v2"
KEY="${UPTIMEROBOT_API_KEY:-}"
CONTACTS="${UPTIMEROBOT_ALERT_CONTACT_IDS:-}"

if [[ -z "$KEY" ]]; then
  echo "✗ UPTIMEROBOT_API_KEY env var is required"
  echo "  Get yours from: Uptime Robot dashboard → My Settings → API Settings → Main API Key"
  exit 1
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[90m·\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# ─── List alert contacts ──────────────────────────────────────────────
bold "1. Alert contacts on your account"
CONTACTS_JSON=$(curl -fsS -X POST "$API/getAlertContacts" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Cache-Control: no-cache' \
  --data-urlencode "api_key=$KEY" \
  --data-urlencode "format=json")

echo "$CONTACTS_JSON" | node -e '
let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
  const r = JSON.parse(s);
  if (r.stat !== "ok") { console.log("  ⚠ UptimeRobot API said:", r.error?.message || JSON.stringify(r)); process.exit(2); }
  if (!r.alert_contacts?.length) {
    console.log("  ⚠ No alert contacts found. Add one in the UptimeRobot dashboard first.");
    process.exit(2);
  }
  r.alert_contacts.forEach(c => {
    console.log("  id=" + c.id + "  type=" + c.type + "  " + (c.friendly_name || "") + "  → " + c.value);
  });
})'

if [[ -z "$CONTACTS" ]]; then
  echo
  warn "UPTIMEROBOT_ALERT_CONTACT_IDS not set. Re-run with the contact IDs you want notified,"
  warn "e.g.  UPTIMEROBOT_ALERT_CONTACT_IDS=12345678  $0"
  warn "(Comma-separate to attach multiple, e.g. email + SMS.)"
  exit 0
fi

# UptimeRobot's alert_contacts param format is "id_thresh_recurrence"
# (thresh = minutes before alerting; 0 = immediate; recurrence = minutes
#  between re-alerts; 0 = once). We send a 0_0 suffix for each contact.
ALERT_PARAM=""
IFS=',' read -ra CID_ARR <<< "$CONTACTS"
for cid in "${CID_ARR[@]}"; do
  cid_clean=$(echo "$cid" | tr -d ' ')
  [[ -z "$cid_clean" ]] && continue
  if [[ -n "$ALERT_PARAM" ]]; then ALERT_PARAM="${ALERT_PARAM}-${cid_clean}_0_0"; else ALERT_PARAM="${cid_clean}_0_0"; fi
done

# ─── Existing monitor names (for idempotency) ─────────────────────────
echo
bold "2. Existing monitors"
EXISTING_NAMES=$(curl -fsS -X POST "$API/getMonitors" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "api_key=$KEY" \
  --data-urlencode "format=json" \
  | node -e '
let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
  const r=JSON.parse(s);
  if (r.stat !== "ok") process.exit(0);
  (r.monitors || []).forEach(m => console.log(m.friendly_name));
})')
echo "$EXISTING_NAMES" | sed 's/^/  · /' || true

# ─── Monitors we want ─────────────────────────────────────────────────
echo
bold "3. Creating monitors (skipping unreachable URLs + existing names)"

# Each row: friendly_name|url|type|keyword
#   type 1 = HTTP, type 2 = HTTP+keyword
#   keyword (only for type 2): substring that MUST be present in the body
MONITORS=(
  "SiamSpa API health|https://spa-api.siamepos.co.uk/api/health|2|\"ok\":true"
  "SiamSpa booking widget asset|https://spa-api.siamepos.co.uk/booking-widget.js|1|"
  "SiamSpa public treatments endpoint|https://spa-api.siamepos.co.uk/api/widget/treatments|2|treatments"
  "SiamSpa public therapists endpoint|https://spa-api.siamepos.co.uk/api/widget/therapists|2|therapists"
  "SiamSpa admin frontend|https://spa.siamepos.co.uk/|1|"
  "Baan Siam Spa demo site|https://www.siamepos.com/|1|"
)

for row in "${MONITORS[@]}"; do
  IFS='|' read -r name url type keyword <<< "$row"

  # Skip if already exists
  if echo "$EXISTING_NAMES" | grep -Fxq "$name"; then
    skip "$name (already exists)"
    continue
  fi

  # Skip if currently unreachable — no point creating a monitor that
  # flags down from minute zero. Re-run the script after fixing.
  if ! curl -fsS -o /dev/null --connect-timeout 5 --max-time 10 "$url" 2>/dev/null; then
    warn "$name → $url currently unreachable, skipping (re-run when live)"
    continue
  fi

  # Build the POST body for newMonitor
  args=(
    --data-urlencode "api_key=$KEY"
    --data-urlencode "friendly_name=$name"
    --data-urlencode "url=$url"
    --data-urlencode "type=$type"
    --data-urlencode "interval=300"
    --data-urlencode "alert_contacts=$ALERT_PARAM"
    --data-urlencode "format=json"
  )
  if [[ "$type" == "2" && -n "$keyword" ]]; then
    args+=( --data-urlencode "keyword_type=1" --data-urlencode "keyword_value=$keyword" )
  fi

  resp=$(curl -fsS -X POST "$API/newMonitor" -H 'Content-Type: application/x-www-form-urlencoded' "${args[@]}")
  status=$(echo "$resp" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const r=JSON.parse(s);console.log(r.stat==="ok"?"OK":r.error?.message||JSON.stringify(r))})')
  if [[ "$status" == "OK" ]]; then
    ok "$name"
  else
    fail "$name → $status"
  fi
done

echo
bold "Done."
echo "  · UptimeRobot dashboard: https://uptimerobot.com/dashboard"
echo "  · Free plan covers 50 monitors × 5-min checks with email alerts."
echo "  · SMS / Twilio alerts cost extra — configure in the dashboard if needed."
