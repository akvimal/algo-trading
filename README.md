# algo-trading

A multi-system algo-trading platform: **signal-generation** (owns the Strategy concept — external providers like Chartink/TradingView, and eventually in-house rules — that produce BUY/SELL ideas), **signal-processing** (resolve a raw signal into an intraday/positional trade on spot/futures/options, using its Strategy's configuration), **execution** (paper or live broker trading), and **market-data** (provider credentials + quote lookups, shared by the others). The systems are loosely coupled — HTTP calls against versioned JSON contracts, and a Redis stream between signal-processing and execution — never a shared database or shared code import.

Full architecture writeup: [`docs/architecture.md`](docs/architecture.md).

## Status

| system | status |
|---|---|
| `signal-generation` | owns the **Strategy** entity (name, source, horizon/instrument/interval, webhook URLs, draft/live/paused) - create one, get webhook URLs, activate it. Chartink wired up; TradingView and in-house engine integration not yet done, see [`systems/signal-generation/README.md`](systems/signal-generation/README.md) |
| `signal-processing` | Chartink webhook intake (`?strategy_id=`, `app/api/routes/webhooks.py`), resolves each signal by looking up its Strategy (no more guessing), Postgres persistence, Redis publish |
| `execution` | paper trading, intraday spot only — Redis consumer, capital-based position sizing, configurable square-off scheduler, CMP via market-data |
| `market-data` | Dhan/NSE quote lookups + instrument-master sync; MCX and crypto routed but not implemented |
| `accounts` | Turning Manual Trading + Options OI into a multi-tenant SaaS: signup/login (JWT) + encrypted BYO Dhan/Delta credential storage. Phases 1-3 shipped — `execution` is fully multi-tenant (every route requires a token) and `market-data` uses a caller's own Dhan credentials/rate budget when a verified token is present, else the platform default. Frontend auth (Phase 4) not yet done, see [`docs/architecture.md`](docs/architecture.md) § "Manual Trading SaaS" |

## Quick start

```bash
cp .env.example .env        # then edit passwords/ports, and DHAN_CLIENT_ID/DHAN_ACCESS_TOKEN if using execution
make bootstrap                # builds images and starts signal-generation + signal-processing + market-data
docker compose --profile execution up -d --build   # also bring up execution (paper trading)
```

Once running:

- **shell** (tab nav across all frontends): http://localhost:8090
- **signal-generation**: http://localhost:8082 (frontend), http://localhost:8003/docs (API) — create a Strategy here first to get webhook URLs (point your real Chartink scans at them directly, no separate workflow tool to configure)
- **signal-processing**: http://localhost:8080 (frontend), http://localhost:8000/docs (API)
- **execution**: http://localhost:8081 (frontend), http://localhost:8002/docs (API) — needs the `execution` profile
- **market-data**: http://localhost:8001/docs (API) — needs `DHAN_CLIENT_ID`/`DHAN_ACCESS_TOKEN` in `.env` for real quotes

Simulate a Chartink alert end-to-end without a real Chartink account (auto-creates a throwaway strategy if you don't pass one):

```bash
make test-signal
```

## Dev vs. test: two isolated local stacks

`make up`/`down`/etc. above run the **dev** stack (project `algo-trading`, ports from `.env`). A second, fully isolated **test** stack can run alongside it on the same machine — its own containers, Postgres/Redis volumes, and network, all ports shifted by `+1000` (`.env.test`):

```bash
make test-up      # builds + starts the test stack (project algo-trading-test)
make test-ps       # make test-down / test-logs / test-build / test-psql also available
```

Test stack URLs mirror the dev ones 1000 higher (shell 9090, signal-generation frontend 9082, etc). `.env.test` is gitignored like `.env` — copy/adjust it the same way if you need different credentials per stack. Known gap: cross-system deep links in each frontend still point at dev's ports (see `CLAUDE.md`).

## Repo layout

```
docs/            architecture notes + versioned JSON contracts between systems
infra/           postgres init SQL, redis config
systems/         one folder per system: signal-generation, signal-processing, execution, market-data
shell/           static tab bar + iframes onto each frontend, not a system of its own
shared/          cross-system libs (python + ts), used sparingly and explicitly
scripts/         dev convenience scripts
```

See [`docs/architecture.md`](docs/architecture.md) for the full folder tree, service map, and roadmap.
