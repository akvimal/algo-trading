#!/usr/bin/env bash
set -euo pipefail

# Live-broker-adapter status-check helper (see docs/architecture.md) -
# calls execution's GET /live-trading/status and pretty-prints "is X
# actually live right now, and if not, why not" for every account and
# execution.strategy_accounts row - the platform kill switch, per-account
# live_trading_enabled/caps, and per-strategy live_trading_enabled/
# live_trading_user_id/caps. A pure DB read on the backend side - safe to
# run any time, never places an order or touches Dhan.
#
# Usage: check-live-trading-status.sh [admin_token]
# The route is admin-gated (it spans every user's own accounts, same
# reasoning GET /accounts/platform is admin-only) - pass a bearer token
# for an is_admin=true user as the one argument, or set EXECUTION_ADMIN_TOKEN.

cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; source .env; set +a; }

TOKEN="${1:-${EXECUTION_ADMIN_TOKEN:-}}"
BACKEND_PORT="${EXECUTION_BACKEND_PORT:-8002}"

if [[ -z "$TOKEN" ]]; then
  echo "Usage: $0 <admin_bearer_token>   (or set EXECUTION_ADMIN_TOKEN)" >&2
  echo "Log in as an is_admin=true user against accounts-backend to get one:" >&2
  echo "  curl -X POST http://localhost:\${ACCOUNTS_BACKEND_PORT}/auth/login -d '{\"email\":...,\"password\":...}'" >&2
  exit 1
fi

curl -sS "http://localhost:${BACKEND_PORT}/live-trading/status" \
  -H "Authorization: Bearer ${TOKEN}" \
  | python3 -m json.tool
