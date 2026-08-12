---
name: scaffold-system
description: Scaffold a new systems/<name> backend (and optionally frontend) following this monorepo's established layout - FastAPI app structure, its own Postgres schema, Dockerfile, and a docker-compose service gated behind a profile flag. Use when starting to build out `execution` or `signal-generation/api` per docs/architecture.md's phased roadmap, or any future system.
---

# Scaffold a new system

Use this when the user is ready to start building `execution` or `signal-generation/api` (or any future system) - follow the same conventions as the existing `signal-processing` system rather than inventing new ones.

## Before starting

Read `systems/signal-processing/backend/` in full as the reference implementation - its `app/` layout, `Dockerfile`, `requirements.txt`, `pyproject.toml`, and `tests/`. Read the target system's `README.md` (`systems/execution/README.md` or `systems/signal-generation/README.md`) for what's already been decided about its planned layout and responsibilities. Read `docs/architecture.md` for the contracts this system will consume/produce.

## Steps

1. Mirror the backend structure: `app/main.py`, `app/config.py`, `app/api/routes/`, `app/domain/`, `app/adapters/db/`, plus whatever this system needs that signal-processing doesn't (e.g. `execution` needs `app/consumers/` for the Redis stream consumer and `app/brokers/` for broker adapters - both already named in `systems/execution/README.md`).
2. Add `infra/postgres/init/0N-<system>.sql` creating that system's own schema and tables - never reuse another system's schema, follow the naming/style of `01-signal-processing.sql`.
3. Any Pydantic model crossing a contract boundary goes in `app/domain/models.py` and must match the relevant `docs/contracts/*.schema.json` file exactly - e.g. `execution` consuming `resolved-order.schema.json` mirrors that schema rather than inventing a different shape.
4. Write `requirements.txt`, `pyproject.toml` (pytest config), and a `Dockerfile` matching signal-processing's shape.
5. Add a `docker-compose.yml` service block gated behind `profiles: ["<system>"]`, matching the commented-out example at the bottom of that file. Wire `depends_on` for postgres/redis as needed.
6. If a frontend is also in scope, mirror `systems/signal-processing/frontend/` (Vite + React + TS, nginx proxying `/api` to the backend service), also gated behind the same profile.
7. Write at least a health-check test and one test for whatever core logic this system owns (e.g. a consumer or broker-adapter unit test), matching the style in `systems/signal-processing/backend/tests/`.
8. Update `docs/architecture.md`'s roadmap/status, the target system's `README.md`, and the root `README.md` status table to reflect that it's now built.
9. Before reporting done: run the new backend's test suite, and run `docker compose config --profile <system> --quiet` to confirm the compose file is still valid.
