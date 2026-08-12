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

n8n:                        http://localhost:${N8N_PORT}
signal-processing API docs: http://localhost:${SIGNAL_PROCESSING_BACKEND_PORT}/docs
signal-processing frontend: http://localhost:${SIGNAL_PROCESSING_FRONTEND_PORT}

Next: open n8n, import infra/n8n/workflows/chartink-{buy,sell}-intake.json,
and activate both workflows. Then try:  make test-signal
EOF
