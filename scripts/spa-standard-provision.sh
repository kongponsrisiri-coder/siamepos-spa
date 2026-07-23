#!/usr/bin/env bash
# SPA STANDARD PROVISIONER (SPA-ONBOARD-STD-001)
# ------------------------------------------------------------------------
# Stamps the "SiamEPOS Spa standard" env onto a spa tenant Railway service so
# no client is ever missing shared capabilities (email, wallet, SMS, AI).
#
# WHY: each spa client is an isolated Railway app with its OWN env. The shared
# platform creds (Brevo, Apple-Wallet certs, Twilio, Anthropic, TZ) are
# IDENTICAL for every tenant but must physically exist in each one. Run this
# once per new tenant instead of copying by hand.
#
# It does THREE things:
#   1. Copies the SHARED platform creds from the canonical source (spa-api).
#   2. Generates any missing PER-CLIENT secrets (JWT/BOOKING/UNSUB/SYNC/inbound).
#   3. Leaves SiamPay + per-client identity (SPA_NAME, ALLOWED_ORIGINS,
#      PUBLIC_API_URL, TWILIO_FROM) ALONE -- those are set at onboarding, and
#      SiamPay needs the tenant own Stripe Express account.
#
# Usage:
#   spa-standard-provision.sh <PROJECT_ID> <ENV_ID> <SERVICE_ID> [--apply]
#   (no --apply = dry run: prints what WOULD change, sets nothing)
#
# Requires RAILWAY_ACCOUNT_TOKEN in the local infra-keys file (never committed).
set -euo pipefail

KEYS_FILE="${SIAMPOS_KEYS_FILE:-$HOME/Library/Application Support/SiamEPOS Control Room/.infra-keys}"
GQL="https://backboard.railway.com/graphql/v2"

# Canonical source of the shared platform creds.
SRC_PROJECT="d32e28d2-8f0a-4c4f-bc1c-fd88cc555f7f"   # Siam-Spa
SRC_ENV="e6fcb99b-137f-4a80-addf-516b0d81f919"
SRC_SERVICE="b707d60d-5e16-4d2e-b495-c72d8e3eda6c"   # spa-api

[ $# -ge 3 ] || { echo "usage: $0 <PROJECT_ID> <ENV_ID> <SERVICE_ID> [--apply]"; exit 1; }
DST_PROJECT="$1"; DST_ENV="$2"; DST_SERVICE="$3"; APPLY="${4:-}"

RT="$(grep -m1 '^RAILWAY_ACCOUNT_TOKEN=' "$KEYS_FILE" | cut -d= -f2- | tr -d '[:space:]')"
[ -n "$RT" ] || { echo "RAILWAY_ACCOUNT_TOKEN not found in $KEYS_FILE"; exit 1; }

fetch_vars() { # project env service
  curl -s --max-time 25 "$GQL" -H "Authorization: Bearer $RT" -H "Content-Type: application/json" \
    --data "{\"query\":\"query(\$p:String!,\$e:String!,\$s:String!){variables(projectId:\$p,environmentId:\$e,serviceId:\$s)}\",\"variables\":{\"p\":\"$1\",\"e\":\"$2\",\"s\":\"$3\"}}"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fetch_vars "$SRC_PROJECT" "$SRC_ENV" "$SRC_SERVICE" > "$TMP/src.json"
fetch_vars "$DST_PROJECT" "$DST_ENV" "$DST_SERVICE" > "$TMP/dst.json"

# Compute the change set (emits changes.json + a human log on stderr).
SRC="$TMP/src.json" DST="$TMP/dst.json" OUT="$TMP/changes.json" python3 - <<'PY'
import os, json, secrets, sys
src = json.load(open(os.environ["SRC"]))["data"]["variables"]
dst = json.load(open(os.environ["DST"]))["data"]["variables"]
SHARED = ["BREVO_API_KEY","ANTHROPIC_API_KEY","TWILIO_ACCOUNT_SID","TWILIO_AUTH_TOKEN",
          "PASS_SIGNER_CERT_B64","PASS_SIGNER_KEY_B64","PASS_SIGNER_KEY_PASSPHRASE",
          "GOOGLE_WALLET_ISSUER_ID","GOOGLE_WALLET_SA_EMAIL","GOOGLE_WALLET_SA_KEY_B64","TZ"]
SECRETS = ["JWT_SECRET","BOOKING_SECRET","UNSUB_SECRET","SYNC_SECRET","INBOUND_EMAIL_SECRET","TWILIO_INBOUND_SECRET"]
out, log = {}, []
for k in SHARED:
    v = src.get(k)
    if not v or dst.get(k) == v:      # source lacks it, or already identical
        continue
    out[k] = v; log.append("  copy  " + k)
for k in SECRETS:
    if not dst.get(k):
        out[k] = secrets.token_hex(32); log.append("  gen   " + k)
json.dump(out, open(os.environ["OUT"], "w"))
sys.stderr.write(("\n".join(log) if log else "  (nothing to change -- already at standard)") + "\n")
PY

echo "Target service: $DST_SERVICE"
CHANGES="$(cat "$TMP/changes.json")"
if [ "$CHANGES" = "{}" ]; then echo "  nothing to do."; exit 0; fi

if [ "$APPLY" != "--apply" ]; then
  echo "  DRY RUN -- re-run with --apply to set the above. (SiamPay + per-client identity left untouched.)"
  exit 0
fi

DST_PROJECT="$DST_PROJECT" DST_ENV="$DST_ENV" DST_SERVICE="$DST_SERVICE" CH="$TMP/changes.json" python3 - <<'PY' > "$TMP/body.json"
import os, json
inp = {"projectId": os.environ["DST_PROJECT"], "environmentId": os.environ["DST_ENV"],
       "serviceId": os.environ["DST_SERVICE"], "variables": json.load(open(os.environ["CH"]))}
print(json.dumps({"query":"mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}","variables":{"input":inp}}))
PY

curl -s --max-time 25 "$GQL" -H "Authorization: Bearer $RT" -H "Content-Type: application/json" \
  --data @"$TMP/body.json" > "$TMP/resp.json"
python3 - "$TMP/resp.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
ok = bool(d.get("data") and "variableCollectionUpsert" in d["data"])
print("  APPLIED (redeploy the service for it to take effect)" if ok else "  ERROR: " + json.dumps(d))
PY
