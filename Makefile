.PHONY: bootstrap up down logs ps build backend-shell frontend-shell psql test-signal live-status \
        test-up test-down test-build test-logs test-ps test-psql

bootstrap:
	bash scripts/bootstrap.sh

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

build:
	docker compose build

backend-shell:
	docker compose exec signal-engine-backend sh

frontend-shell:
	docker compose exec signal-engine-frontend sh

psql:
	docker compose exec postgres psql -U $${POSTGRES_USER:-algotrading} -d $${POSTGRES_DB:-algotrading}

test-signal:
	bash scripts/simulate-chartink-alert.sh

live-status:
	bash scripts/check-live-trading-status.sh $(TOKEN)

# --- Isolated local test stack: same compose file, own project name +
# .env.test (shifted ports) - runs alongside `up` above without conflict.
# See docs on dev/test container groups (CLAUDE.md).
test-up:
	docker compose -p algo-trading-test --env-file .env.test up -d --build

test-down:
	docker compose -p algo-trading-test --env-file .env.test down

test-build:
	docker compose -p algo-trading-test --env-file .env.test build

test-logs:
	docker compose -p algo-trading-test --env-file .env.test logs -f

test-ps:
	docker compose -p algo-trading-test --env-file .env.test ps

test-psql:
	docker compose -p algo-trading-test --env-file .env.test exec postgres psql -U $${POSTGRES_USER:-algotrading} -d $${POSTGRES_DB:-algotrading}
