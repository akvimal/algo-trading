#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example - edit passwords before going beyond local use."
fi

set -a
source .env
set +a

docker compose build
docker compose up -d

cat <<EOF

signal-engine API docs: http://localhost:${SIGNAL_ENGINE_BACKEND_PORT}/docs
signal-engine frontend: http://localhost:${SIGNAL_ENGINE_FRONTEND_PORT}

Chartink intake webhooks live directly on signal-engine now (no n8n):
  http://localhost:${SIGNAL_ENGINE_BACKEND_PORT}/webhook/chartink-buy?strategy_id=<id>
  http://localhost:${SIGNAL_ENGINE_BACKEND_PORT}/webhook/chartink-sell?strategy_id=<id>
Copy a strategy's actual URLs from the signal-engine frontend once you've created one.
Try it now:  make test-signal
EOF
