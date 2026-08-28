---
name: scaffold-system
description: Scaffold a new systems/<name> backend (and optionally frontend) following this monorepo's established layout - FastAPI app structure, its own Postgres schema, Dockerfile, and a docker-compose service gated behind a profile flag. Use when starting to build out a brand-new system per docs/architecture.md's phased roadmap.
---

# Scaffold a new system

Use this when the user is ready to start building a brand-new system (every system named in `docs/architecture.md`'s current roadmap already exists) - follow the same conventions as the existing systems rather than inventing new ones.

## Before starting

Read `systems/accounts/backend/` in full as the reference implementation - a clean, standalone single-schema backend (its `app/` layout, `Dockerfile`, `requirements.txt`, `pyproject.toml`, and `tests/`). `signal-engine/backend/` is a good second reference once the new system needs a Redis stream consumer or a background scheduler job (see its `app/consumers/`/`app/scheduler.py`) - it's the 2026-08-28 merger of the old signal-generation/signal-processing systems (see `docs/architecture.md`), so it's more involved than a from-scratch scaffold needs to start as. Read the target system's `README.md` if one already exists for what's already been decided about its planned layout and responsibilities. Read `docs/architecture.md` for the contracts this system will consume/produce.

## Steps

1. Mirror the backend structure: `app/main.py`, `app/config.py`, `app/api/routes/`, `app/domain/`, `app/adapters/db/`, plus whatever this system needs that `accounts` doesn't (e.g. a Redis stream consumer needs `app/consumers/`, matching `signal-engine/backend/app/consumers/signal_resolution_consumer.py`; a paper-trading system needs `app/brokers/` for broker adapters, per `systems/execution/README.md`).
2. Add `infra/postgres/init/0N-<system>.sql` creating that system's own schema and tables - never reuse another system's schema, follow the naming/style of `04-accounts.sql`.
3. Any Pydantic model crossing a contract boundary goes in `app/domain/models.py` (or a subpackage, if the system is split into multiple concerns the way `signal-engine` is - see its `app/domain/generation/`/`app/domain/processing/`) and must match the relevant `docs/contracts/*.schema.json` file exactly - e.g. `execution` consuming `resolved-order.schema.json` mirrors that schema rather than inventing a different shape.
4. Write `requirements.txt`, `pyproject.toml` (pytest config), and a `Dockerfile` matching `accounts`'s shape.
5. Add a `docker-compose.yml` service block gated behind `profiles: ["<system>"]`, matching the commented-out example at the bottom of that file. Wire `depends_on` for postgres/redis as needed.
6. If a frontend is also in scope, mirror an existing frontend (Vite + React + TS) - `systems/accounts` has none of its own (it's called directly from execution's/manual-trading's browsers), so use whichever existing frontend is closest in shape to what's being built, also gated behind the same profile.
7. Write at least a health-check test and one test for whatever core logic this system owns (e.g. a consumer or broker-adapter unit test), matching the style in `systems/accounts/backend/tests/`.
8. Update `docs/architecture.md`'s roadmap/status, the target system's `README.md`, and the root `README.md` status table to reflect that it's now built.
9. Before reporting done: run the new backend's test suite, and run `docker compose config --profile <system> --quiet` to confirm the compose file is still valid.
