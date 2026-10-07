#!/usr/bin/env bash
set -euo pipefail

# The PLATFORM Dhan token (what market-data's background jobs, shared price feed and option-chain reads use).
#
# It has ONE source: the Dhan token the operator saved on the web app's Settings page (the first admin's, or PLATFORM_DHAN_OWNER_EMAIL's).
# The server adopts a fresher saved token within a few minutes by itself, renews it before it expires, and saves the renewed token back to
# Settings, so there is nothing to copy between the two. This script is for checking it, and for nudging it when you cannot wait.
#
# Usage:   scripts/dhan-token.sh [status|refresh|renew|set]        (default: status)
#   status   when the token expires, and whether a live quote works. Changes nothing.
#   refresh  use the token saved on the Settings page right now instead of waiting a few minutes (only if it outlives the one in use).
#   renew    adopt a fresher saved token if there is one, then renew with Dhan for a fresh 24 hours (only works while the token is still
#            valid), and save the renewed token back to Settings.
#   set      asks for an access token (typing is hidden) and sets it as the platform token AND the saved Settings token. Use it only when
#            you cannot use the Settings page. Needs the token to still be valid to renew afterwards.
#
# The calls run inside the market-data container with its internal secret; a token is read with a hidden prompt, handed to the container by NAME
# (never in a command line), and never printed. Run it on the machine that runs the stack (the VPS, or your PC).

cd "$(dirname "$0")/.."
ACTION="${1:-status}"
case "$ACTION" in from-settings) ACTION=refresh ;; esac   # the old name
case "$ACTION" in status | refresh | renew | set) ;; *) echo "Usage: $0 [status|refresh|renew|set]" >&2; exit 1 ;; esac

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

# POST/PUT to an operator route as the container's own internal secret, printing everything except any token field.
call() {  # call METHOD PATH [-e T]   (the token for set comes from the env var T)
  local method="$1" path="$2"; shift 2
  export METHOD="$method" URLPATH="$path"
  run_py -e METHOD -e URLPATH "$@" <<'PY'
import os

import requests

from app.config import settings

method, path = os.environ["METHOD"], os.environ["URLPATH"]
kwargs = {}
if "T" in os.environ:
    token = os.environ["T"].strip()
    if token.count(".") != 2:
        print("  that does not look like a Dhan access token (it should have three parts separated by dots). Nothing was changed.")
        raise SystemExit(3)
    kwargs["json"] = {"client_id": settings.dhan_client_id, "access_token": token}
r = requests.request(method, f"http://localhost:8000{path}", headers={"X-Internal-Secret": settings.internal_service_secret}, timeout=60, **kwargs)
body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
if r.ok:
    keep = ("has_access_token", "saved_back_to_settings", "saved_to_settings", "adopted_saved_token", "token_expires_at")
    print(f"  {method} {path}: {r.status_code}", {k: v for k, v in body.items() if "token" not in k.lower() or k in keep})
else:
    print(f"  {method} {path}: {r.status_code}", body.get("detail", r.text[:200]))
raise SystemExit(0 if r.ok else 2)
PY
}

echo "Dhan platform token: $ACTION"

rc=0
case "$ACTION" in
  status)
    show_status
    exit 0
    ;;
  refresh)
    set +e; call POST /dhan/refresh; rc=$?; set -e
    ;;
  renew)
    set +e; call POST /dhan/renew-token; rc=$?; set -e
    ;;
  set)
    read -r -s -p "Paste the Dhan access token (typing is hidden), then press Enter: " T
    echo
    if [ -z "$T" ]; then echo "Nothing entered, so nothing was changed." >&2; exit 1; fi
    export T
    set +e; call PUT /dhan/credentials -e T; rc=$?; set -e
    unset T
    if [ "$rc" -eq 0 ]; then set +e; call POST /dhan/renew-token; rc=$?; set -e; fi
    ;;
esac

echo "Now:"
show_status
if [ "$rc" -ne 0 ]; then
  echo >&2
  echo "That did not go through (exit $rc). If the token has already expired, generate a new one on Dhan, save it on the Settings page, then run:  scripts/dhan-token.sh refresh" >&2
  exit "$rc"
fi
