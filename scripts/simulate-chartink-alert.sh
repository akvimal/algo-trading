#!/usr/bin/env bash
set -euo pipefail

# Simulates a Chartink webhook call against the local n8n instance, using
# Chartink's real payload shape (comma-separated stocks/trigger_prices).
# Useful for testing the intake pipeline before you have a live Chartink
# scan wired up.
#
# Usage: simulate-chartink-alert.sh [buy|sell] [strategy_id]
# If strategy_id is omitted, a throwaway "smoke-test" strategy is created
# (and activated) via signal-generation so this still works as a
# zero-argument smoke test (`make test-signal`).
#
# Requires: the matching workflow (chartink-buy-intake.json or
# chartink-sell-intake.json) already imported AND activated in n8n.

cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; source .env; set +a; }

DIRECTION="${1:-buy}"      # buy | sell
STRATEGY_ID="${2:-}"
N8N_PORT="${N8N_PORT:-5678}"
BACKEND_PORT="${SIGNAL_PROCESSING_BACKEND_PORT:-8000}"
GENERATION_PORT="${SIGNAL_GENERATION_BACKEND_PORT:-8003}"

if [[ "$DIRECTION" != "buy" && "$DIRECTION" != "sell" ]]; then
  echo "Usage: $0 [buy|sell] [strategy_id]" >&2
  exit 1
fi

if [[ -z "$STRATEGY_ID" ]]; then
  echo "No strategy_id given - creating a throwaway 'smoke-test' strategy..." >&2
  STRATEGY_ID=$(curl -sS -X POST "http://localhost:${GENERATION_PORT}/strategies" \
    -H "Content-Type: application/json" \
    -d '{"name":"smoke-test","source_type":"chartink","horizon":"intraday","instrument_type":"spot","quantity":1}' \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  curl -sS -X PATCH "http://localhost:${GENERATION_PORT}/strategies/${STRATEGY_ID}" \
    -H "Content-Type: application/json" -d '{"status":"live"}' > /dev/null
  echo "Created + activated strategy ${STRATEGY_ID}" >&2
fi

curl -sS -X POST "http://localhost:${N8N_PORT}/webhook/chartink-${DIRECTION}?strategy_id=${STRATEGY_ID}" \
  -H "Content-Type: application/json" \
  -d '{
        "stocks": "RELIANCE,TCS",
        "trigger_prices": "2500.00,3400.50",
        "triggered_at": "2:30 pm",
        "scan_name": "Bullish Breakout",
        "scan_url": "bullish-breakout",
        "alert_name": "Alert for Bullish Breakout"
      }'

echo ""
echo "Check results: curl http://localhost:${BACKEND_PORT}/signals?strategy_id=${STRATEGY_ID}"
