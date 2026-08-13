# execution

Consumes the `orders.resolved` Redis stream published by `signal-processing` (see `docs/contracts/resolved-order.schema.json`) and manages paper positions. Scope right now: **intraday** only — spot, future, and (Phase 4d of the options trading module, see `docs/architecture.md`) 2-leg option spreads (`bull_call_spread`/`bear_put_spread`, combined SL/target). Swing/positional is recorded as `REJECTED` with a reason for every instrument type, ready to support once that logic exists here.

## How it works

1. A Redis consumer group (`app/consumers/orders_consumer.py`) reads `orders.resolved`, at-least-once, idempotent on `signal_id`.
2. `app/domain/position_manager.open_position()` sizes the position as `floor(capital_per_trade / signal_price)` whole shares and opens it at the signal's own price (no quote lookup needed to enter) — unless it's outside the configured intraday window, the horizon/instrument isn't supported yet, the symbol already has an open position and the signal's Strategy has `duplicate_signal_policy=skip` (same direction) or the incoming signal is opposite-direction with `counter_signal_policy=close_and_flip` (closes the existing position(s) first, `exit_reason=counter_signal`) — both per-strategy, passed through on the resolved order, see `app/domain/position_manager._resolve_signal_conflicts` — or `capital_per_trade` can't buy even 1 share at this price.
3. An APScheduler job (`app/scheduler.py`), self-contained in this service, polls every `square_off_poll_seconds` and closes any `OPEN` position once local time passes **its own segment's** configured `square_off_time` (`execution.accounts.square_off_time` — one per segment, `NULL` means that segment never force-closes, e.g. CRYPTO's default): fetches CMP per open symbol from `market-data`, closes each position with signed P&L. `POST /positions/square-off` runs the same logic manually, unconditionally (ignores each position's own time).
4. `square_off_time`/`capital_per_trade`/`risk_per_trade_pct`/`leverage` are DB-backed **per segment** (`execution.accounts`), editable via `GET`/`PUT /accounts/{segment}` from the frontend — no reschedule step needed, the job just polls and reads current data fresh. `square_off_time` used to be a required per-Strategy field (signal-generation) — moved here since it's a market-hours concept, not a per-strategy one, see `docs/architecture.md`. `duplicate_signal_policy`/`counter_signal_policy` used to live in a global `execution.settings` row as a direction-blind setting; they're per-strategy now (signal-generation), not configured in this service.

An `instrument_type='option'` order (2 legs, `strategy.legs` from signal-processing's Phase 4b templates) is dispatched to `app/domain/option_position_manager.open_option_group()` instead — resolves each leg's `security_id` to a trading symbol via `market-data`'s `GET /instruments/resolve-by-security-id` (Phase 4d), fetches both legs' live premium, and opens one `execution.option_position_groups` row (combined SL/target/status/P&L) plus 2 `execution.positions` rows (one per leg, linked via `option_group_id`). See `docs/architecture.md` § "Making an option order tradeable (Phase 4d)" for the full design.

See `docs/architecture.md` for the full data-flow diagram and the reasoning behind these decisions.

## Endpoints

- `GET /health`
- `GET /positions?status=OPEN|CLOSED|REJECTED&limit=100` — includes `option_group_id` for option legs
- `POST /positions/square-off` — manual square-off
- `GET /option-groups?status=OPEN|CLOSED|REJECTED&limit=100` — one row per 2-leg option spread, with nested `legs`
- `POST /option-groups/square-off` — manual square-off for every open option group
- `GET` / `PUT /settings`

## Running it

Behind the `execution` compose profile (not started by default):
```
docker compose --profile execution up -d --build
```
Needs `market-data-backend` reachable (always up, no profile) and Dhan credentials configured there for real CMP at square-off — see `systems/market-data/README.md`.

## Not yet built

- Swing/positional handling for any instrument type.
- A live broker adapter for real order placement — this is paper trading only.
- A frontend view grouping an option spread's 2 legs together — they currently show up as ordinary rows in the Positions grid, distinguishable by `option_group_id`.
- More than 2 legs / other option templates (straddle, naked leg, ...) — `open_option_group` rejects anything besides exactly one BUY + one SELL leg.
- Per-strategy `capital_per_trade` — it's one setting per account (segment) today, not configurable per strategy.
