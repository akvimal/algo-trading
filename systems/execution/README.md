# execution

Consumes the `orders.resolved` Redis stream published by `signal-processing` (see `docs/contracts/resolved-order.schema.json`) and manages paper positions. Scope right now: **intraday, spot only** — anything else (swing/positional, futures/options) is recorded as `REJECTED` with a reason, ready to support once that resolution logic exists upstream.

## How it works

1. A Redis consumer group (`app/consumers/orders_consumer.py`) reads `orders.resolved`, at-least-once, idempotent on `signal_id`.
2. `app/domain/position_manager.open_position()` sizes the position as `floor(capital_per_trade / signal_price)` whole shares and opens it at the signal's own price (no quote lookup needed to enter) — unless it's outside the configured intraday window, the horizon/instrument isn't supported yet, the symbol already has an open position and the signal's Strategy has `duplicate_signal_policy=skip` (same direction) or the incoming signal is opposite-direction with `counter_signal_policy=close_and_flip` (closes the existing position(s) first, `exit_reason=counter_signal`) — both per-strategy, passed through on the resolved order, see `app/domain/position_manager._resolve_signal_conflicts` — or `capital_per_trade` can't buy even 1 share at this price.
3. An APScheduler job (`app/scheduler.py`), self-contained in this service rather than n8n, fires at `square_off_time` daily: fetches CMP per open symbol from `market-data`, closes each position with signed P&L. `POST /positions/square-off` runs the same logic manually.
4. Settings (`square_off_time`, `capital_per_trade`) are DB-backed, editable via `GET`/`PUT /settings` from the frontend — a time change reschedules the job immediately. `duplicate_signal_policy`/`counter_signal_policy` used to live here as a global, direction-blind setting; they're per-strategy now (signal-generation), not configured in this service.

See `docs/architecture.md` for the full data-flow diagram and the reasoning behind these decisions.

## Endpoints

- `GET /health`
- `GET /positions?status=OPEN|CLOSED|REJECTED&limit=100`
- `POST /positions/square-off` — manual square-off
- `GET` / `PUT /settings`

## Running it

Behind the `execution` compose profile (not started by default):
```
docker compose --profile execution up -d --build
```
Needs `market-data-backend` reachable (always up, no profile) and Dhan credentials configured there for real CMP at square-off — see `systems/market-data/README.md`.

## Not yet built

- Swing/positional and futures/options handling (depends on real resolution logic in `signal-processing`).
- A live broker adapter for real order placement — this is paper trading only.
- Stop-loss/target/exit rules — price is only checked once at entry and once at square-off, there's no continuous monitoring loop.
- Per-strategy `capital_per_trade` — it's one global setting for every strategy today, not configurable per strategy.
