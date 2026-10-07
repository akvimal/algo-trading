#!/usr/bin/env bash
set -euo pipefail

# Sets, renews or checks the PLATFORM Dhan access token that market-data uses for its background jobs
# (the end-of-day OI and screener scans), the shared price feed and the option-chain reads. This is NOT
# the per-person key on the Settings page: that one only serves that person's own requests.
#
# Usage:   scripts/dhan-token.sh [set|renew|status]        (default: set)
#   set     asks for the access token (typing is hidden), saves it to the server's persistent volume, then renews it
#           straight away so it gets a fresh 24 hours. Needs the token to still be valid when you run it.
#   renew   extends the token the server already holds (only works while that token is still valid)
#   status  shows when the token expires and whether a live quote works. Changes nothing.
#
# The token is read with a hidden prompt, handed to the container by NAME (never in a command line), and never
# printed. Run it from anywhere inside the repo, on the machine that runs the stack (the VPS, or your PC).

cd "$(dirname "$0")/.."
ACTION="${1:-set}"
case "$ACTION" in set | renew | status) ;; *) echo "Usage: $0 [set|renew|status]" >&2; exit 1 ;; esac

# On the VPS (VPS_DOMAIN is set in .env) use the production overlay and the execution profile; elsewhere the plain file.
if [ -f .env ] && grep -qE '^VPS_DOMAIN=.+' .env && [ -f docker-compose.prod.yml ]; then
  DC=(docker compose --profile execution -f docker-compose.yml -f docker-compose.prod.yml)
else
  DC=(docker compose)
fi
SVC=market-data-backend

run_py() { "${DC[@]}" exec -T "$@" "$SVC" python -; }

show_status() {
  run_py <<'PY'
import requests

s = requests.get("http://localhost:8000/dhan/token-status", timeout=15).json()
print("  token expires at (UTC):", s.get("token_expires_at"), "| client id:", s.get("dhan_client_id"), "| has token:", s.get("has_access_token"))
try:
    r = requests.get("http://localhost:8000/quotes/ltp", params={"exchange": "NSE", "symbol": "NIFTY"}, timeout=40)
    print("  live NIFTY quote:", r.status_code, r.text[:90])
except Exception as e:
    print("  live quote could not be fetched:", type(e).__name__)
PY
}

do_renew() {
  run_py <<'PY'
import requests

r = requests.post("http://localhost:8000/dhan/renew-token", timeout=40)
body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
safe = {k: v for k, v in body.items() if "token" not in k.lower()} if r.ok else body.get("detail", r.text[:200])
print("  renew:", r.status_code, safe)
raise SystemExit(0 if r.ok else 2)
PY
}

echo "Dhan platform token: $ACTION"

if [ "$ACTION" = "status" ]; then
  show_status
  exit 0
fi

if [ "$ACTION" = "set" ]; then
  read -r -s -p "Paste the Dhan access token (typing is hidden), then press Enter: " T
  echo
  if [ -z "$T" ]; then echo "Nothing entered, so nothing was changed." >&2; exit 1; fi
  export T
  set +e
  run_py -e T <<'PY'
import os

import requests

from app.config import settings

token = os.environ["T"].strip()
if token.count(".") != 2:
    print("  that does not look like a Dhan access token (it should have three parts separated by dots). Nothing was changed.")
    raise SystemExit(3)
r = requests.put("http://localhost:8000/dhan/credentials", json={"client_id": settings.dhan_client_id, "access_token": token}, timeout=40)
body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
print("  set:", r.status_code, {k: v for k, v in body.items() if "token" not in k.lower()} if r.ok else body.get("detail", r.text[:200]))
raise SystemExit(0 if r.ok else 2)
PY
  rc=$?
  set -e
  unset T
  if [ "$rc" -ne 0 ]; then echo "Not saved (exit $rc). See the line above." >&2; exit "$rc"; fi
fi

# set and renew both finish by renewing, so the token gets a fresh 24 hours while it is still valid
set +e
do_renew
rc=$?
set -e
echo "Now:"
show_status
if [ "$rc" -ne 0 ]; then
  echo
  echo "The renewal did not go through. If the token you pasted had already expired, generate a new one on Dhan and run:  scripts/dhan-token.sh set" >&2
  exit "$rc"
fi
echo
echo "Done. Tip: set DHAN_TOKEN_RENEW_INTERVAL_HOURS=12 in .env (then 'up -d market-data-backend') so a missed renewal cannot strand the token."
