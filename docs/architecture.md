# Architecture

Four loosely-coupled systems (`signal-generation`, `signal-processing`, `execution`, `market-data`). Every arrow crossing a system boundary is either an HTTP call against a versioned JSON contract (`docs/contracts/`) or a Redis stream message — never a shared database table or shared code import. Each system that holds business-critical state owns its own Postgres schema; `market-data` holds none (see below).

```
Chartink scan --webhook?strategy_id=X--> signal-processing backend
                                                     |         \
                                         Postgres    |          HTTP: GET /strategies/{id}
                                         (signal_    |                |
                                         processing) |          signal-generation backend
                                                     |          (owns Strategy config)
                                           Redis stream: orders.resolved
                                                     |
                                               execution backend
                                                /            \
                                   Postgres (execution)   HTTP: GET /quotes/ltp
                                                                 |
                                                           market-data backend
                                                            (in-memory cache, no DB)
                                                                 |
                                                            Dhan API (NSE)

signal-generation frontend --reads directly (CORS)--> signal-processing backend
signal-generation's in-house engine --HTTP: POST /signals--> signal-processing backend (same contract webhook providers use)
```

## Strategy: the unit of configuration for a signal source

A **Strategy** (`signal-generation`, `signal_generation.strategies` table) is what a signal actually belongs to — either an external webhook provider (Chartink, TradingView) or, eventually, an in-house indicator/price-action engine run. Creating one gets you an `id` and, for webhook sources, ready-to-use webhook URLs; it starts as `draft` and does nothing until you set it to `live`. Its `horizon`/`instrument_type` are what `signal-processing` resolves a signal to — **not a guess**, an explicit choice made when the strategy was configured. It also carries an optional `interval` (1min/5min/15min/30min/60min/daily): for a webhook provider this is purely descriptive today (we don't control when Chartink actually fires, it's a record of the expected cadence, ready for a future staleness check); for an in-house strategy it will drive the engine's own check interval and backtest granularity once Phase 3 exists.

Deliberately **no position-size/capital field on Strategy** — see § "Why position sizing lives in execution, not signal-generation" below. Stop-loss and target ARE here, though (`stop_loss_method`, `stop_loss_interval`, `stop_loss_percent`, `target_percent`, `trailing_stop_enabled`), which reads at first as a contradiction of "no risk fields" — it isn't, see the explanation in that section: the *method* varies by strategy, the sizing *arithmetic* still doesn't live here. `square_off_time` is here too, on the same reasoning — and it's **required for `horizon='intraday'`**, execution has no platform-wide default (this was tried first and dropped - see § "Why the square-off scheduler lives in execution, not a separate orchestrator"). It stays `null` for `swing`/`positional` strategies — square-off doesn't apply to a position that isn't closed same-day, so there's nothing to default or require; the frontend hides the input entirely for those horizons. Execution still owns the actual scheduling (a periodic job checking each position's own stored time, not signal-generation deciding when anything closes).

`segment` (`NSE`/`MCX`/`CRYPTO`, default `NSE`) is conceptually a separate axis from `exchange`, though the two always co-occur 1:1 in practice (NSE segment↔NSE exchange, MCX↔MCX, CRYPTO↔CRYPTO — one provider per segment, see `market-data`'s `router.py`), so `segment` just records which market the strategy is *meant* for, letting `square_off_time` be defaulted sensibly: `default_square_off_time(horizon, segment)` returns `15:00` for NSE, `22:00` for MCX, `17:25` for CRYPTO, but only when `horizon='intraday'` — any other horizon returns `None` and `square_off_time` simply stays unset, no error. This runs server-side (a `StrategyCreate` model-validator), so it applies the same way whether a strategy is created from the frontend or a raw API call; the frontend additionally pre-fills the square-off input with the same suggestion as a UX convenience, and only shows that input at all when Horizon is Intraday. `is_supported()` in execution still only accepts `intraday`+`spot`/`future` regardless of segment — CRYPTO's own market-data foundation (Phase 1 of the crypto module, below) makes a CRYPTO signal resolvable/chartable, not yet independently gated any differently from NSE/MCX at the execution layer.

A Strategy also carries an optional **active window** (`active_from_time`/`active_to_time`, e.g. `09:15`–`11:00`) — both-or-neither, `None`/`None` by default (no restriction, existing strategies unaffected), available to every `source_type`, not just `in_house`. It's enforced entirely in `signal-processing`'s `resolve()` (see below), not here — signal-generation just stores and validates the pair (`validate_active_window_fields`: both set or neither, `active_to_time` strictly after `active_from_time`, no overnight wraparound). `run_live_tick`'s per-tick strategy fetch additionally skips a `live`/`in_house` strategy currently outside its own window before spending any market-data calls on it — a pure efficiency optimization mirroring the authoritative check, not a second source of truth for it.

This is not the same thing as signal-processing's *option-strategy* selection (spread/straddle/naked leg, `app/domain/resolution/strategy.py`, still a placeholder) — that's a different, later-stage decision about how to construct an options trade once `instrument_type: option` is already known. The naming collision is unfortunate but unavoidable; contracts and code both carry disambiguating comments (`strategy_id` vs. the `strategy` object).

### Why signal-generation owns this (not signal-processing)

`signal-generation` is the system that's supposed to own "what produces a signal" — that's true whether the producer is a Chartink scan or an in-house engine. Putting Strategy there means the *same* entity and CRUD API cover both, and the in-house "In-house" tab's future backtest-then-promote-to-live flow is just this same table with `source_type: in_house` instead of a webhook.

### Webhook shape: query param, not one route per strategy

A strategy's webhook URLs reuse the same two static paths for every strategy — `/webhook/chartink-buy?strategy_id=<uuid>` and `/webhook/chartink-sell?strategy_id=<uuid>` on `signal-processing` itself — rather than a new route per strategy, which would sprawl badly. Adding a strategy is a database row, never new code. This used to be enforced by n8n's own limitations (path *parameters* behaved unreliably when workflows were imported via the CLI); now that the routes are plain FastAPI (`app/api/routes/webhooks.py`), the query-param shape is kept on its own merits — it's still the simplest way to let one route handle every strategy for a provider.

`app/api/routes/webhooks.py`'s `chartink_buy`/`chartink_sell` declare `strategy_id: str = Query(...)` — FastAPI 422s automatically (aborting, no signal created) if it's missing from the query string, same behavior the old n8n `Code` node's manual `throw` gave.

## Why Chartink intake lives directly in signal-processing (not a separate service)

Intake is: receive a provider webhook, archive the raw payload, normalize/fan-out into the canonical `signal-ingest` shape (including `strategy_id` from the query param), then run the exact same persist/resolve/publish logic `POST /signals` always has. None of that is business logic — what horizon/instrument a signal resolves to still lives in `systems/signal-processing/backend`'s resolution pipeline, unchanged — it's just plumbing, which is why it used to live in n8n (a separate always-up container, hand-imported workflows, untested JavaScript `Code` nodes) even though nothing about it required a separate service. It's now `app/domain/intake/chartink.py` (the parsing) + `app/api/routes/webhooks.py` (the route), calling the exact same `archive_raw_payload`/`create_signal_from_ingest` functions the generic `POST /ingest/raw`/`POST /signals` endpoints use — in-process, no self-HTTP hop — and, unlike the JS it replaced, has real `pytest` coverage (`tests/test_chartink_intake.py`).

## Provider adapters

Each signal source gets its own parse function + route(s) (buy/sell) rather than one route branching on payload shape:

| provider | webhook path | fixed action | exchange | strategy scoping |
|---|---|---|---|---|
| Chartink (buy scans) | `/webhook/chartink-buy?strategy_id=` | `BUY` | `NSE` | query param, same route for every strategy |
| Chartink (sell scans) | `/webhook/chartink-sell?strategy_id=` | `SELL` | `NSE` | query param, same route for every strategy |
| next provider | `/webhook/<provider>[-buy/-sell]?strategy_id=` | from payload or fixed by path | depends | same pattern |

Adding a new provider means adding one new `parse_<provider>_alert` + 1-2 routes in `signal-processing` (via the `add-signal-provider` skill), never touching the resolution pipeline or signal-generation.

## Why signal-processing calls signal-generation (not the other way around)

Provider intake stays thin — it passes `strategy_id` through unchanged, it does not look the strategy up. `signal-processing`'s resolution pipeline (`app/domain/resolution/pipeline.py`) calls `GET /strategies/{id}` on signal-generation at resolve time, the same cross-system-HTTP pattern `execution` uses for `market-data` quotes. If the strategy doesn't exist, signal-generation is unreachable, or the strategy isn't `live`, resolution raises `ResolutionError`: the signal is still persisted (for audit/visibility) but `resolved_orders.status = 'rejected'` with a reason, and **nothing is published to the Redis stream** — a signal that can't be resolved never reaches execution.

## Why position sizing lives in execution, not signal-generation

Strategy used to carry a fixed `quantity`. Moved out because sizing is a capital/risk decision, not a "what signal is this" decision — buying a flat 10 shares means wildly different exposure on a ₹50 stock versus a ₹5000 one, and the system that already owns capital exposure, position lifecycle, and P&L is `execution`, not `signal-generation`. `signal-generation`'s job stops at *what* and *when*.

`capital_per_trade` (default ₹50,000, editable via `PUT /accounts/{segment}`, per-*account* — one account per segment, still not per-strategy, see below) is the value cap every position respects regardless of sizing method. If a Strategy sets no stop-loss method, that's the *only* sizing input: `open_position()` computes `quantity = floor(effective_capital / signal_price)`, where `effective_capital = min(capital_per_trade, the account's current_balance)`. If that can't buy even one share at the signal's price, `compute_quantity` floors to **1 share** instead of `0` — a position always opens rather than being rejected for undersized capital (a first pass rejected here instead, `quantity` staying `NULL`; changed after the size-based rejection got confused for something else during testing - see the risk-based path below for the equivalent flooring on that side) — *unless the account itself can't afford even 1 share*, which is a distinct, newer rejection (see "Why paper-trading accounts are per-segment" below).

### Stop-loss/target: the method lives on Strategy, the arithmetic stays in execution

A later addition: Strategy can optionally set a stop-loss method (`previous_candle` — the low/high of the previous completed candle at a per-strategy interval, via `market-data`'s `GET /candles/previous` — or `percent`, a flat % from entry) and an independent `target_percent`, with optional `trailing_stop_enabled`. This looks like it contradicts "sizing is execution's job," but the split is deliberate: **what determines the stop distance** varies meaningfully by strategy/scan/timeframe (unlike a flat capital figure, which doesn't), so that one piece — the method and its parameters — lives with "what produces this signal." Everything downstream of that still lives in execution exactly as before:

- `signal-processing`'s resolution pipeline passes the method/params through unchanged in the resolved order it already publishes (`docs/contracts/resolved-order.schema.json`) — it doesn't interpret them. `execution` never calls `signal-generation` directly to get them.
- `execution.open_position()` resolves the actual `stop_loss_price`/`target_price` (a percent calculation, or a call to market-data for a candle) and computes `quantity`: `max(1, min(floor(risk_amount / stop_distance), floor(effective_capital / entry_price)))`, where `risk_amount = effective_capital * account.risk_per_trade_pct / 100` (per-account, same per-segment-not-per-strategy reasoning as `capital_per_trade`). The capital cap is a ceiling on top of risk-based sizing, never bypassed; if the risk/capital-capped result is still `0`, it floors to `1` share the same way the plain-capital path does, rather than rejecting.
- A new periodic job (`position_manager.check_exits`, `app/scheduler.py`, independent interval from the square-off job below) closes a position early if CMP crosses its `stop_loss_price` or `target_price` — the continuous monitoring that "execution only looks at price at entry and square-off" (see the old open question below) didn't previously have. Trailing (stop-loss only, never the target) re-anchors the stop to the current price (percent method) or the latest completed candle (previous_candle method) each run, only ratcheting in the favorable direction.
- Position rows carry a copy of the method/params they were opened with (`stop_loss_method`, `stop_loss_interval`, `stop_loss_percent`) so the exit-monitor job can recompute a trailing stop without re-fetching the Strategy.

### Lot-size-aware sizing: futures, since Phase 3

`is_supported()` accepted only `instrument_type='spot'` through Phase 2.x — Phase 3's in-house engine produces `future` orders (the interim tradeable instrument for both MCX commodities and NSE indices, see § "The in-house indicator engine"), so it now accepts `intraday` + `spot` **or** `future` (still nothing else — `option`/non-`intraday` stay rejected, that's real Phase 4 scope). Futures trade in **lots**, not arbitrary units, which `execution` never had to model before: `compute_quantity`/`compute_risk_based_quantity` gained a `lot_size` parameter (default `1`, so NSE-spot's existing behavior is byte-for-byte unchanged) and now floor to whole lots rather than whole units — `lots = max(1, capital // (price * lot_size)); quantity = lots * lot_size`. `quantity` still means "total underlying units" exactly as it always has for equities, so `compute_pnl` needed no change at all. `lot_size` itself comes from `market-data`'s `GET /instruments/lot-size` (see § "MCX/NSE-index market-data support") — `open_position()` only calls it for `instrument_type='future'` orders, so the spot path pays zero extra latency for a lookup it never needed.

## Why paper-trading accounts are per-segment, not per-strategy

`execution.settings.capital_per_trade`/`risk_per_trade_pct` used to be single global values. As MCX (Phase 3) and Crypto (Phase 4.5) come online alongside NSE, each trading against genuinely different capital/instruments, a single global sizing config stops making sense — but per-*strategy* accounts would be the wrong granularity too: multiple strategies in the same segment (e.g. several NSE Chartink scans) are conceptually trading the same book, so they should share one pool of capital and one P&L history, not each get their own. `execution.accounts` lands in between: one row per `segment` (`NSE`/`MCX`/`CRYPTO`, `segment` as the primary key so "one account per segment" is structural, not just convention), seeded for all three up front — MCX started as intent-only (segment picked an account without unlocking trading) but is now fully tradeable as of Phase 3, see above.

Each account tracks a **real running balance** (`starting_balance`/`current_balance`), not just a stateless sizing constant — `current_balance` is debited/credited by realized P&L on every close path (`square_off_all_open`, `square_off_position`, `square_off_due_positions`, `check_exits`), via a shared `_apply_realized_pnl` helper so every closing path updates it the same way. Deliberately **not** locked at open time: unrealized P&L stays exactly as before (computed, never persisted), and a position's cost doesn't reserve capital while it's open — only a *closed* trade moves the balance. This keeps paper performance compounding/depleting like a real account (a losing streak actually shrinks what's available to the next trade) without adding open-time bookkeeping complexity that a real broker's margin system would need but this paper platform doesn't.

Sizing now uses `effective_capital = min(account.capital_per_trade, account.current_balance)` instead of the raw `capital_per_trade` — so a depleted account sizes smaller as it goes, on top of the account's own configured cap. This introduces a new rejection distinct from the existing "floors to 1 share" behavior: if `effective_capital` can't cover even 1 share (the account is out of paper money, not just under-capitalized-per-trade), `open_position()` rejects with "insufficient account balance" rather than flooring to 1 — flooring-to-1 assumes there's *some* money and just rounds up; this is the account having none left.

`capital_per_trade`/`risk_per_trade_pct` moved off global `execution.settings` onto each account (`PUT /accounts/{segment}`) — same "not per-strategy" reasoning as before, just one level more granular (per-segment now, still shared across every strategy within it). `POST /accounts/{segment}/reset` resets `current_balance` back to `starting_balance` — a deliberately separate action from `DELETE /positions` so clearing test positions never silently resets balance history as a side effect.

## Why market-data is its own system

Both `execution` (CMP at square-off, live P&L, exit monitoring) and `signal-generation` (previous-candle stop-loss) need the same thing: provider credentials, an instrument-master sync, and quote/candle lookups. Rather than each embedding its own broker SDK, `market-data` owns that once and exposes it over HTTP. It holds no business-critical state — no Postgres, just an in-memory symbol→security-ID cache rebuilt from Dhan's instrument master (synced daily + once on startup) — so a restart just means one resync, not data loss.

This does mean `execution`'s square-off job (and now the exit-monitor job) take on a cross-service HTTP dependency at safety-critical moments. Mitigation: `market-data` runs infra-tier in `docker-compose.yml` (`restart: unless-stopped`, always up, not gated behind the `execution` profile), and a position whose quote fetch fails is left `OPEN` for retry rather than erroring the whole run — see `square_off_all_open`/`check_exits` in `systems/execution/backend/app/domain/position_manager.py`.

Dhan's LTP endpoint is rate-limited (1 req/sec, stricter in practice) — `DhanProvider` self-throttles to a 2s minimum gap between calls **and fetches all requested symbols in one call** (`get_ltp_batch`, up to 1000 instruments per Dhan request) rather than looping per symbol. A per-symbol loop was the original implementation and caused real rate-limit pileups once several distinct symbols were open at once (N symbols × 2s > most poll intervals) — batching is the actual fix, not just a longer timeout. A short (3s) in-memory quote cache further absorbs repeated lookups within a few seconds (e.g. a frontend polling every 5s).

Dhan access tokens are only valid 24h and used to require manually regenerating and pasting a fresh one into `.env`. `app/providers/dhan.py` now renews it automatically: a shared, in-memory `current_access_token()` (genuinely global, not per-`DhanProvider` instance — `router.py`'s `dhan-nse`/`dhan-mcx` instances share one Dhan account) falls through to `settings.dhan_access_token` until the first successful renewal, then reflects whatever `renew_access_token()` last got back from Dhan's `RenewToken` endpoint (https://docs.dhanhq.co/api/v2/authentication/renew-token — note its `dhanClientId` header, unlike the LTP/candle endpoints' `client-id`). `app/scheduler.py` calls this on an interval (`dhan_token_renew_interval_hours`, default 20 — comfortable margin inside the 24h window) plus once immediately on startup, alongside the existing instrument-sync job; `POST /dhan/renew-token`/`GET /dhan/token-status` expose a manual trigger and the current state. Deliberately **in-memory only, no new persistence** — a container restart/rebuild still reverts to whatever's in `.env`, same as before this existed; the renewal keeps a long-running container's token fresh without ever needing that manual step, but doesn't change the restart case (no DB, no new Docker volume, matching this section's own "holds no business-critical state" design above).

Several things confirmed only by testing against the live API, not the docs. The success response's new-token field is actually named `token` (with a `createTime` field), not `accessToken`/`dhanClientName`/etc as documented — `renew_access_token` checks `token` first, `accessToken` as a defensive fallback; it treats a response with no token field as a failure either way (some Dhan error cases return `200` with an `errorType`/`errorCode`/`errorMessage` body instead of a non-2xx status), rather than crashing on an unhandled `KeyError` — the pre-fix version did exactly that in production before this was caught. Renewal chains rather than repeats: calling `RenewToken` again on the SAME token instance a second time gets rejected (`DH-906 "Invalid Token"`, identical error to an actually-expired token), but calling it on the **newly-renewed** token succeeds and produces yet another new one — confirmed by chaining renewals live (A renews to B, B renews to C). This is exactly what makes indefinite automatic renewal work: each scheduled run renews whatever `current_access_token()` currently holds, never the stale original. Once superseded by a renewal, the old token stops working for *regular* LTP/candle calls too, not just for `RenewToken` — also confirmed live, and the reason for the next paragraph.

**Dev and test each need their own separate Dhan access token, not the shared one `.env`/`.env.test` used before this feature existed.** Dhan allows multiple concurrent active tokens per account (confirmed live — two independently-generated tokens both worked at the same time), but each token can only ever be renewed forward along its own chain; two processes independently auto-renewing the *same* token race and invalidate whichever one the other is currently holding (reproduced live: dev's in-memory token broke the moment test's on-boot job renewed what was, at that point, the identical value both `.env` files held). `dhan_token_renew_interval_hours` (`app/config.py`) set to `0` disables the scheduled+on-boot renewal job entirely (`app/scheduler.py`) — a deliberate escape hatch for a setup that still wants to share one token across stacks and only let one of them renew it automatically — but the actual fix adopted here is simpler: generate a second token from Dhan Web for `.env.test`, leave both at the default 20h interval, and they never collide.

`market-data` also maintains a real, continuous Dhan **live market feed** connection — a binary WebSocket, not REST polling (`app/providers/dhan_feed.py`, `wss://api-feed.dhan.co`, https://docs.dhanhq.co/api/v2/guides/live-market-feed). One connection for the whole process (not per-`DhanProvider`-instance, same "genuinely global" reasoning as `current_access_token()` above), started from `app/main.py`'s startup handler and run in a background thread via `websocket-client`'s `WebSocketApp.run_forever()` — this backend is otherwise fully synchronous (`requests`, `threading.Lock`, `BackgroundScheduler`, no `asyncio`), so a sync WebSocket client fit the existing style better than introducing one. Subscribes Ticker mode only (`RequestCode: 15` — LTP + last-trade-time, the cheapest of Dhan's three modes) for a small default sentinel watchlist (`NIFTY`) plus whatever's added via `POST /dhan/feed/subscribe`; Quote/OI/Full/Depth packets exist on the wire but aren't parsed — proving the feed is genuinely live doesn't need bid/ask depth or volume. Reconnects on every close/error after a fixed delay, never letting the thread die permanently, same philosophy as the scheduler's own jobs; rebuilds the connection URL fresh on each attempt so a token renewed mid-connection is picked up on the next reconnect rather than going stale. The exact wire protocol (request codes, binary struct formats, numeric exchange-segment codes in the response header vs. the string segment keys used to subscribe) isn't fully spelled out on Dhan's own docs page — confirmed instead against the official `dhan-oss/DhanHQ-py` client source. `GET /dhan/feed-status` exposes connection health + last ticks; `market-data`'s new frontend (`systems/market-data/frontend`) polls it every 5s alongside `GET /health` and `GET /instruments/sync-status`, the platform's first UI for this system.

**Option chain (Phase 4a)** — `DhanProvider.get_expiry_list`/`get_option_chain` (`app/providers/dhan.py`) wrap Dhan's `POST /optionchain/expirylist` and `POST /optionchain` (https://docs.dhanhq.co/api/v2/option-chain), exposed as `GET /options/expiries?exchange=&symbol=` and `GET /options/chain?exchange=&symbol=&expiry=`. Both resolve the underlying (e.g. `"NIFTY"`) via the same `resolve_feed_target` the live feed already uses — no separate resolution path. Self-throttled to Dhan's documented 1-request-per-3s limit (`MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS`, own lock, same shape as the LTP/candle throttles) and short-cached per `(symbol, expiry)` (`OPTION_CHAIN_CACHE_TTL_SECONDS`). Each returned strike's CE/PE leg carries OI, IV, top bid/ask, and Greeks (delta/theta/gamma/vega — Dhan doesn't expose rho) straight from Dhan, plus one thing Dhan *doesn't* send: an ITM/ATM/OTM `moneyness` label, computed by `app/domain/moneyness.py`'s `classify_moneyness` (ATM = within half an inferred strike-step of spot — `infer_strike_step` derives the step from the chain's own strikes rather than assuming a fixed value, since it varies by underlying). These two methods live on `DhanProvider` directly, not the `QuoteProvider` abstract base — same reasoning as `resolve_feed_target`: a future non-Dhan provider (Delta Exchange) may not have an equivalent, so `app/api/routes/options.py` duck-types via `getattr` and 404s cleanly rather than assuming every provider supports it. This is Phase 4a only — fetching and classifying chain data, not deciding anything with it; strike/strategy *selection* is Phase 4b, described next.

**Strike + strategy selection (Phase 4b)** — `signal-processing`'s `choose_strategy` (`app/domain/resolution/strategy.py`) is the first real implementation, called from `resolve()` for any signal whose Strategy has `instrument_type='option'`. Works for both **NSE and MCX** — `choose_strategy` never uses `signal.symbol` directly against the option-chain endpoints; it first calls `resolve_underlying(signal.exchange, signal.symbol)` (the adapter's mirror of `DhanProvider.resolve_underlying`, the same method the live feed/candle paths already lean on) and chains off the result's `chart_symbol`/`chart_exchange` instead. That distinction only matters because of how differently NSE and MCX name things: an NSE index option chains off the index spot, an NSE equity option off the equity itself (`chart_symbol == trade_symbol` there), and an MCX commodity option off its active-month futures contract (MCX has no separate spot, so `chart_symbol == trade_symbol` there too) — but MCX's `chart_symbol` is never the bare underlying name a signal carries (`"GOLDM"`), only the full dated contract (`"GOLDM-04Sep2026-FUT"`), which is exactly what `market-data`'s MCX instrument sync keys quotes by. `resolve_underlying` returning `None` (unresolvable underlying) raises `ResolutionError` the same as any other failed step below. The bias comes straight from `signal.action`: `BUY` → **bull call spread**, `SELL` → **bear put spread** (`app/domain/resolution/option_templates.py`) — the exact two templates already named when the fixed-set approach was decided, not a general rule engine. Expiry selection (`choose_expiry`) depends on horizon: `intraday` takes the nearest expiry regardless of how soon; `positional` takes the nearest one at least `MIN_POSITIONAL_DAYS_TO_EXPIRY` (7) days out, falling back to the furthest available rather than refusing to trade if none qualify. Strike selection: the long leg is always the ATM strike (Phase 4a's own `moneyness` label); the short leg is `SPREAD_WIDTH_STRIKES` (2) strikes further OTM from it — this is where OI comes in as the confirmed-scope "tie-breaker within the template," not a strategy chooser: if that ideal short-leg strike's OI is below `MIN_SHORT_LEG_OI` (1000), the search keeps stepping further OTM (never *toward* ATM, which would narrow the spread unexpectedly) until one clears the floor, falling back to the originally-ideal strike if the chain runs out first. `signal-processing` had never called `market-data` before this — a new adapter (`app/adapters/market_data/client.py`, mirroring `signal-generation`'s own client, now including its own `resolve_underlying`) and `MARKET_DATA_BASE_URL` setting were added; `choose_strategy` raises `ResolutionError` (not a silent `None`) if any step fails (unresolvable underlying, market-data unreachable, no ATM strike in the chain) — a signal that can't get real legs shouldn't resolve as `instrument_type='option'` with nothing to trade, same handling every other `ResolutionError` already gets. `resolved-order.schema.json`'s `strategy.legs` items were tightened from a fully-open object to the real per-leg shape (`action`/`option_type`/`strike`/`expiry`/`security_id`) as part of this phase.

**Naked call/put option style** — `Strategy.option_position_style` (signal-generation, `'spread'`
default or `'naked'`) picks which template FAMILY `choose_strategy` builds within Phase 4b's same
bias→direction logic: `'spread'` is unchanged (bull call spread / bear put spread); `'naked'` picks
`naked_call`/`naked_put` (`app/domain/resolution/option_templates.py`) — a single BUY leg (at
whatever strike `option_strike_moneyness` resolves to, see below), no short leg at all, no
`MIN_SHORT_LEG_OI` liquidity nudge (nothing to place OTM). Available for every segment
(NSE/MCX/CRYPTO), not crypto-specific, even though it landed alongside the crypto module's Phase 4 —
`choose_strategy` was already exchange-agnostic, so this is a pure template addition.
`resolved-order.schema.json` needed no change (`strategy.legs` already had no `minItems`;
`strategy.type` was already a free-text string) — only signal-generation's `Strategy` gained the new
field, threaded through opaquely via `fetch_strategy()`'s already-untyped dict. This platform has no
margin/undefined-risk handling anywhere, so "naked" here always means a single BUY leg (long
call/long put) — never a written/sold naked option. Full backtest parity is a known, explicit gap:
`option_backtest.py`'s `legs_for_direction` is still hardcoded to a long+short ATM pair, so
`POST /strategies/{id}/backtest` returns a `422` for either an `option_position_style='naked'`
strategy or an `option_strike_moneyness` other than `'ATM'`, rather than silently reporting
wrong-strike/wrong-leg-count numbers.

**Configurable primary-leg moneyness** — `Strategy.option_strike_moneyness` (signal-generation,
`'ATM'` default, or `'ITM2'`/`'ITM1'`/`'OTM1'`/`'OTM2'`) picks which strike the primary (long) leg
actually uses, within either `option_position_style`. `option_templates.py`'s
`_find_primary_leg_index` (replacing the old always-literally-ATM `_find_atm_index` call at every
template's call site) finds ATM first, then shifts by a signed strike-count offset
(`_MONEYNESS_OFFSETS`) in that leg's own OTM direction — `+1` for calls, `-1` for puts, the exact
same `direction` convention `_pick_short_leg_index` already used for the short leg, since
`classify_moneyness` (`market-data`) establishes a call is OTM *above* spot and a put OTM *below*
it. Out-of-range requests (e.g. `ITM2` on a chain with only one strike below ATM) clamp to whatever's
furthest available, same "ideal but not always achievable" philosophy `_pick_short_leg_index`
already has, rather than failing. For a spread, the short leg's own `SPREAD_WIDTH_STRIKES` offset is
computed relative to wherever the *shifted* primary leg landed, not relative to ATM itself — picking
`OTM1` doesn't just move the long leg, it moves the whole spread one strike further out. Scope
confirmed narrowly with the user before building: only the primary leg is configurable; the spread's
own `SPREAD_WIDTH_STRIKES` distance stays fixed, not separately configurable.

**Backtesting option strategies (Phase 4c)** — `signal-generation`'s spot/future backtest engine (`app/domain/backtest.py`'s `simulate_trades`/`replay`, wired into `POST /strategies/{id}/backtest`) used to ignore `instrument_type` entirely — an `instrument_type='option'` in-house strategy silently backtested as if it traded the underlying's own spot price, which is misleading (the real P&L driver is the option legs' premium). `app/api/routes/strategies.py`'s `_backtest_one_symbol` now branches to a new `_backtest_one_symbol_option` whenever `row.instrument_type == 'option'` — **crossover-rule strategies only** for now (matches `/backtest/grid`'s existing crossover-only scope; breakout replays via a wholly separate function with no `bias_fn` at all, and range-breakout would need a shared `bias_fn`-builder factored out first — both left for later). The new `app/domain/option_backtest.py` reuses `simulate_trades` **unchanged** (run with no SL/target configured, only square_off/opposite-signal/end-of-data closing) to find candidate entry windows on the underlying exactly like a spot backtest would, then re-simulates each window against a **synthetic combined-premium series** (`combined_series`: `close = long.close - short.close`, `high`/`low` built from the worst/best-case joint leg extremes) instead of the underlying's own price — `legs_for_direction` picks the same bull-call-spread/bear-put-spread legs Phase 4b's live path does (`SPREAD_WIDTH_STRIKES` duplicated as a constant, not imported — no cross-system imports — and without Phase 4b's live OI-liquidity nudge, a documented simplification). The key trick that keeps this small: a debit spread's combined premium behaves exactly like a single "bullish" instrument price regardless of which template was used (algebraically `combined_pnl(t) = combined_price(t) - combined_entry`, identical in shape to a single long position's P&L) — so `simulate_option_trades` reuses `backtest.py`'s own `_stop_loss_percent_price`/`_target_percent_price`/`_pnl` completely unchanged, always called with `direction="bullish"` against the synthetic series; the *reported* trade direction is still the original bullish/bearish signal. Historical option premium comes from Dhan's `POST /charts/rollingoption` (`DhanProvider.get_option_leg_history`, exposed as `GET /options/leg-history`) — strikes are requested *relative to spot* (`"ATM"`, `"ATM+2"`, ...) so, unlike Phase 4a/4b, no local chain/moneyness lookup is needed; Dhan resolves the real strike server-side per historical bar. Each of the (at most 4, typically 2) distinct `(option_type, strike)` leg series a backtest needs is fetched **once** for the whole `[from, to]` range and memoized (`leg_fetcher` in `_backtest_one_symbol_option`), then sliced per trade window — not re-fetched per trade. `expiry_flag` is `"WEEK"` for intraday/swing, `"MONTH"` for positional (an approximation of Phase 4b's `choose_expiry` intent — Dhan's rolling endpoint has no "at least N days out" concept). `MAX_OPTION_BACKTEST_DAYS` (180) caps a single request's total Dhan call volume (≈12 calls in the worst case, at the same conservative 3s-apart throttle Phase 4a's option-chain calls use). **Several documented assumptions, unverifiable until live Dhan access resumes** (see `docs/architecture.md`'s git history / the Phase 4c plan for the full research trail): rollingoption's `exchangeSegment`/`instrument` fields describe *where the option trades* (`NSE_FNO` + `OPTIDX`/`OPTSTK`), a different vocabulary from Phase 4a's `UnderlyingSeg`, which describes the *underlying's own* segment — confirmed from Dhan's docs/annexure and the `dhan-oss/DhanHQ-py` client source, but exact `expiryCode` semantics beyond "0-3, refer to instruments page" aren't spelled out anywhere; this endpoint is assumed **NSE/BSE-only** (no MCX derivatives segment is documented at all) — an MCX option strategy gets a clean `get_option_leg_history` → `None` rather than silently-wrong data, unlike live MCX option *trading* (Phase 4b), which does work; and the endpoint is assumed to be a genuinely continuous/rolling series across real contract rollovers (per its own naming and "5 years of history" claim), which is why there's no separate "expiry" exit reason. Trailing-stop and the regime filter aren't extended to the option variant in this pass either.

**Making an option order tradeable (Phase 4d)** — `execution.is_supported()` used to reject `instrument_type='option'` outright, and separately, `resolved-order.schema.json` itself documented each leg's `security_id` (Phase 4a's option-chain response ID for that specific contract) as "not yet resolvable to a trading symbol/lot size by execution." The key design decision: rather than building a new security-id-keyed quoting/lot-size path, `market-data` reuses its **entire existing symbol-keyed machinery** unchanged — 3 new `SegmentConfig`s (`app/providers/dhan.py`'s `NSE_OPTIDX`/`NSE_OPTSTK`/`MCX_OPTFUT`, exact copies of the `NSE_FUTIDX`/`MCX_FUTCOM` pattern, just filtering different `SEM_INSTRUMENT_NAME` values — none set `underlying_of`, since execution already has the *exact* `security_id` it wants and never needs "the active option contract for underlying X" the way futures rollover needs) feed `sync_instruments()`'s existing `_symbol_to_security_id`/`_symbol_to_lot_size` dicts, plus one new reverse lookup, `_security_id_to_symbol` (populated for every synced row, not just options — a free byproduct of the same sync loop), exposed as `GET /instruments/resolve-by-security-id?exchange=&security_id=`. Execution calls this **once per leg, at open time**, translating `security_id` → a real trading symbol (e.g. `"NIFTY-14Aug2026-24000-CE"`) it stores on that leg's own `positions.symbol` — every downstream operation (quoting for exit-monitor/square-off via `GET /quotes/ltp/batch`, lot size via `GET /instruments/lot-size`) then reuses the ordinary symbol-keyed endpoints completely unchanged, exactly like a future position already does. This also fixes lot-size correctness for free: an NSE stock option's own lot size (`SEM_LOT_UNITS` on its own `OPTSTK` row) is used directly, rather than incorrectly borrowing the underlying equity's `lot_size=1` (which a naive "reuse the underlying's resolved lot size" shortcut would have introduced — only safe for index/commodity underlyings, where the option and its active future/contract share a lot size, not for equities).

`execution` opens a 2-leg spread as one `execution.option_position_groups` row (owning the **combined** SL/target/status/P&L) plus 2 `execution.positions` rows (one per leg, linked via a new `option_group_id` column) — a dedicated new sibling module, `app/domain/option_position_manager.py`, not a modification of `position_manager.py` (`is_supported`/`open_position` stay completely untouched; `app/consumers/orders_consumer.py` branches to `open_option_group` for `instrument_type='option'` before either is even reached, zero regression risk to the existing spot/future path). Sizing and combined-threshold math reuse `position_manager.py`'s own `compute_quantity`/`compute_risk_based_quantity`/`compute_stop_loss_percent_price`/`compute_target_percent_price` unchanged, called against the **net debit** (long leg's live premium minus short leg's, fetched fresh at open time — the resolved order's leg carries no premium at all, only `security_id`/`strike`/`expiry`) with `action='BUY'` always: the same "a debit spread's combined premium behaves like a single long position regardless of which template was used" trick Phase 4c's `option_backtest.py` already established, reused a third time. `_resolve_signal_conflicts` (`position_manager.py`) is reused **unchanged** against `OptionPositionGroup` rows too — it's duck-typed on just `.action`. Combined SL/target monitoring (`_evaluate_option_group_exits`) and time-based square-off (`_evaluate_option_group_square_off_due`) run on the *same* scheduler poll intervals as the spot/future jobs (`app/scheduler.py`), no new settings needed. Scoped to `horizon='intraday'` only (matching `is_supported()`'s existing overall scope — swing/positional execution doesn't exist for *any* instrument type yet), no trailing-stop on the combined SL (matches Phase 4c's own cut), and `stop_loss_method='previous_candle'` isn't supported for a combined synthetic instrument (rejects cleanly at open, same as any other unresolvable-at-open case). Backend/API only this phase — legs still show up as ordinary rows in `GET /positions` (now carrying `option_group_id`), not yet visually grouped in the frontend; a new `GET /option-groups` (and its square-off/check-exits/manual-close siblings) exists for a future UI pass to consume.

Generalized to a **1- or 2-leg** group when the naked call/put option style landed: every group always
has exactly one BUY leg (`legs_by_group()`'s `'BUY'` key) and now an *optional* SELL leg (`'SELL'`,
present for `'spread'`, absent for `'naked'`). Six spots needed the same one-line change (the
`"BUY" in group_legs and "SELL" in group_legs` guard becomes just `"BUY" in group_legs`, `short_leg`
becomes `Optional`, contributing `0.0` to the combined price when absent) — `open_option_group`'s own
leg-count/pairing check, `_close_group_at_cmp`, `compute_group_unrealized_pnl`,
`_evaluate_option_group_square_off_due`, `_evaluate_option_group_exits`, and `open_option_group`'s
conflict-close branch. No DB migration needed — `option_position_groups`/`positions` never had a
leg-count constraint, a group's leg count is already a pure runtime property of however many
`positions` rows reference it.

**Individual vs. combined SL/target** — `Strategy.option_sl_scope` (signal-generation, `'combined'`
default or `'individual'`) picks whether a group is monitored against one threshold on the
**combined** (net debit) premium (the original design, unchanged) or against **each leg's own**
threshold computed from its own entry premium. Either scope still closes the **whole group
together** when tripped — this is a different trigger *condition*, never a way to leave one leg
open while the other closes (confirmed with the user before building; no new unhedged-risk state is
possible). `option_sl_scope` is a new **top-level field on `ResolvedOrderDraft`/`ResolvedOrder`**
(`docs/contracts/resolved-order.schema.json` genuinely gained a property this time — unlike
`option_position_style`/`option_strike_moneyness`, which only ever affected *which legs*
`choose_strategy` builds and never needed to reach execution, `option_sl_scope` changes how
execution *monitors* an already-resolved group, so it follows `stop_loss_method`/
`stop_loss_percent`'s existing passthrough shape instead). `option_position_groups` gained an
explicit `sl_scope` column (mirrors how `strategy_type` is stored explicitly rather than inferred);
no new columns were needed on `positions` — `stop_loss_price`/`initial_stop_loss_price`/
`target_price` already existed there (used by spot/future, always `NULL` for option legs until
now) and individual mode simply populates them for option leg rows too, for the first time.
Position sizing risk-anchors on the **primary leg's own** stop distance in individual mode
(mirrors what a naked position already does unconditionally, since `net_debit` equals the long
leg's own premium there). Mathematically identical to `'combined'` for a naked (1-leg) position —
no separate handling needed anywhere.

**A real pre-existing bug was found and fixed along the way**, unrelated to individual mode itself:
`_evaluate_option_group_exits` set each **leg's** own `exit_reason` to `'combined_stop_loss'`/
`'combined_target'` — but `positions.exit_reason`'s own `CHECK` constraint only ever allowed
`'square_off'/'stop_loss'/'target'/'manual'/'counter_signal'`, never a `'combined_'`-prefixed value
(that vocabulary only exists on `option_position_groups.exit_reason`, a separate column with its
own separate constraint). A live combined SL/target hit would have failed the DB constraint and
rolled back — never caught because this path was only ever unit-tested against plain fakes (no
constraint enforcement) and never actually live-triggered during this session's verification (which
only exercised open + manual square-off). Fixed by decoupling the two: the **group**'s own
`exit_reason` keeps its scope-prefixed value (`combined_stop_loss`/`individual_target`/etc.), while
each **leg**'s `exit_reason` now gets the plain `stop_loss`/`target` value every other position
already uses, regardless of which scope triggered the close.

**A second gap, found only by live-verifying `option_sl_scope` end to end** (not by code review):
`signal-processing`'s actual Redis publish payload (`app/domain/intake/core.py`'s
`create_signal_from_ingest`) builds the `orders.resolved` message as a **separately hand-written
dict**, field by field — not a serialization of `ResolvedOrderDraft` itself. Adding a field to the
Pydantic model/contract/tests is not the same as it actually reaching execution; `option_sl_scope`
was correctly threaded through `ResolvedOrderDraft` and covered by passing unit tests, but the
publish dict simply never got the new key added, so every group opened as `sl_scope='combined'`
regardless of what the strategy actually requested — caught only when a live `'individual'` group's
`GET /option-groups` response showed `combined` instead. This is the same class of "a new field
needs threading through more places than the obvious ones" surprise this session has hit
repeatedly (DB `CHECK` constraints for the crypto module, provider methods for CRYPTO options) —
here the extra place was a hand-maintained publish-payload dict, not a schema.

**Contract day filter: restricting signals to a contract's start/expiry day** —
`Strategy.contract_day_filter` (signal-generation, `'any'` default, or `'start'`/`'expiry'`)
restricts a strategy's signals to a specific day in the underlying future/option contract's
lifecycle, for strategies where the user only wants to open a position right as a contract begins
trading or right as it's about to expire — `instrument_type in ('future', 'option')` only,
harmlessly ignored for `'spot'` (no expiry concept at all there). Enforcement lives in **two
different systems**, because futures and options get their contract resolved at two different
points in the pipeline: a future is already fully resolved (symbol + expiry known) **inside
signal-generation's own `engine.py`**, before a signal is ever posted — no external webhook
provider produces futures signals (Chartink is NSE-cash-equity-only), so `_run_one`/
`_run_one_breakout`/`_run_one_range_breakout` each call the new pure helper
`_matches_contract_day_filter(instrument_type, segment, contract_day_filter, resolved.expiry,
today)` immediately after `resolve_underlying(...)` and simply skip posting the signal that tick if
it doesn't match (same "return False, no signal" shape every other ineligible-tick case in that
file already uses) — `resolved.expiry` was a genuine pre-existing gap closed for this: market-data's
`GET /instruments/resolve` already returned `expiry`, but signal-generation's own
`app/adapters/market_data/client.py` silently dropped it since nothing had needed it before.
Options, by contrast, only get their expiry chosen later, inside **signal-processing's
`choose_strategy`** (`app/domain/resolution/strategy.py`) — the check runs there instead, right
after `choose_expiry` resolves and before the (now conditionally skipped) `get_option_chain` call,
raising `ResolutionError` on a mismatch (persisted as `rejected`, same handling every other
resolution failure in that function already gets) rather than a silent skip, since by that point a
real signal already exists and needs a recorded outcome. Execution never needs to know about this
field at all — it's a pure pre-publish eligibility gate, resolved entirely before an order is ever
built, so `resolved-order.schema.json` is untouched.

`'expiry'` means the same thing for both instrument types (today is the contract's own expiry day)
and is exact, cheap data for either — signal-generation already has `resolved.expiry` from
`resolve_underlying`, and signal-processing already has the chosen `expiry` from `choose_expiry`.
`'start'` is a harder case: it means "today is the day after the *previous* contract's expiry" —
computable for options from `get_expiry_list`'s live, sorted expiry list (`sorted_expiries[idx - 1]`
relative to the chosen expiry's own index, when that index isn't already `0`), but **not reliably
computable for futures at all**, and dropped there entirely (`validate_contract_day_filter_fields`
rejects `contract_day_filter='start'` outright for `instrument_type='future'`, an explicit
validation error rather than a silently-dead filter) — Dhan's synced instrument master only ever
lists the currently-active and upcoming contracts, never one that already expired, so there's no
stored "previous contract" for a future to compute day-after from without adding new persistent
contract-transition tracking, which was explicitly ruled out of scope. Not enforced at all for
`segment`/`exchange='CRYPTO'` (the user's own stated exception — daily option expiry there makes
the start/expiry distinction meaningless; configuring the field for a CRYPTO strategy is harmless,
just never checked).

Candle fetching (`get_previous_candle`, backing `GET /candles/previous`) is deliberately narrow: the single most recently *completed* candle for a symbol/interval, not a historical range — built for the stop-loss method above. It has its own independent throttle (separate lock/timestamp from LTP — different Dhan endpoint, no reason to serialize one behind the other) and its own cache keyed by `(symbol, interval)` with a TTL equal to the interval's own length, since a completed candle doesn't change until the next one closes. Unlike LTP there's no true multi-symbol batching here — Dhan's `charts/intraday` endpoint is per-security-id — so a caller needing several symbols (e.g. execution's exit-monitor job trailing several `previous_candle` positions) calls it once per distinct symbol, relying on the cache to bound repeat calls across polling ticks. `GET /candles/history` (§ below) reuses the same endpoint and cache-free path for a general multi-bar range instead of one cached value.

NSE (cash equity, indices, index futures) and MCX (commodity futures) are wired up via Dhan; CRYPTO via Delta Exchange India, see below.

Dhan's `charts/intraday` only natively serves a fixed set of granularities (`DHAN_CANDLE_INTERVAL_MINUTES` — 1/5/15/25/60min). Any other `"Nmin"` interval (3min, 2min, 10min, 20min, 30min, ...) is served by **local aggregation** instead: `DhanProvider` fetches native 1min bars for the requested range and buckets them into N-minute bars itself (`aggregate_candles`, extracted into the provider-agnostic `app/domain/candle_aggregation.py` once `DeltaProvider` needed the identical algorithm against its own, different native set — `app/providers/dhan.py`'s `_aggregate_candles`/`_interval_minutes` are now thin delegating wrappers, kept for call-site/test-import stability), aligned to clock-time multiples of N since midnight — the same alignment Dhan's own native bars are observed to use (e.g. real 5min bars land on `:00/:05/:10`, never `:02/:07`). A bucket is only emitted once it holds a full complement of N one-minute bars — a short bucket (session open not aligned to N, or the trailing bucket still forming) is dropped, extending the same "completed bars only" rule the 1-minute fetch already applies. This is transparent to callers: `get_previous_candle`/`get_candle_history` accept any `"Nmin"` interval string, native or aggregated, and `Strategy.interval` (signal-generation) is no longer limited to Dhan's native set — this incidentally fixed a latent gap where `"30min"` was already an accepted `Strategy.interval` value with no actual working path before local aggregation existed.

## CRYPTO segment via Delta Exchange India (Phases 1-4 of the crypto module)

The crypto module is planned as a phased roadmap, same reasoning as the options module (§ above) —
this is Phase 1 only: `market-data`'s foundation (instrument sync, historical candles, quotes,
live feed) plus the minimum contract widening needed for a CRYPTO signal to flow through the
existing pipeline unchanged otherwise. Option chain, option-strategy resolution, and option
execution for CRYPTO are separate, later phases, not built yet.

**A genuinely simpler integration than Dhan's, on two axes.** First, every endpoint `DeltaProvider`
(`app/providers/delta.py`) calls — `GET /v2/products`, `GET /v2/history/candles`, `GET /v2/tickers`
— is **public**; Delta's HMAC-signed auth scheme only gates order placement/wallet/positions,
none of which this paper-trading-only platform ever calls, so there's no credential, no token
renewal, nothing in `.env` at all for this module (contrast Dhan's `DHAN_CLIENT_ID`/
`DHAN_ACCESS_TOKEN`/renewal scheduler). Second, a crypto perpetual future has **no expiry or
rollover at all** — unlike an NSE index (spot vs. active-month future) or an MCX commodity
(monthly rollover), `resolve_underlying`'s `chart_symbol`/`trade_symbol` are just the perpetual's
own symbol (e.g. `"BTCUSD"`), permanently, so `DeltaProvider` needs none of `DhanProvider`'s
active-contract-resolution machinery (`resolve_active_contract`, `_underlying_to_contracts`, ...).
`get_lot_size` always returns `1` for the same reason spot equity does — Delta perpetuals size in
whole contracts directly, no separate lot-multiplier concept.

Base URL/response shapes were confirmed directly against the live API (`https://api.india.delta.exchange`)
rather than `docs.delta.exchange` alone (a JS-rendered SPA that a plain fetch summarizes poorly) —
worth re-checking if Delta's API ever changes shape, same spirit as this doc's other
empirically-confirmed-not-just-documented Dhan notes. Two behaviors worth flagging since they're
easy to get wrong from the docs alone: `GET /v2/history/candles` returns results **newest-first**
(the opposite of this codebase's oldest-first `Candle` convention — `DeltaProvider` reverses
before returning) and `GET /v2/tickers?symbols=A,B` **silently ignores the `symbols` filter**
(confirmed live — it returns every product regardless) — `get_ltp_batch` instead fetches
`?contract_types=perpetual_futures` once (~220 rows) and filters to the requested symbols in
memory, keeping the same "one provider call regardless of N symbols" property `DhanProvider.get_ltp_batch`
has, just via a different mechanism. `sync_instruments()` follows Delta's cursor-based
`meta.after` pagination (not page numbers) until a page comes back empty.

**Live feed** (`app/providers/delta_feed.py`, `wss://socket.india.delta.exchange`) is plain JSON
text frames — confirmed live: `{"type":"subscribe","payload":{"channels":[{"name":"v2/ticker","symbols":[...]}]}}`
subscribes directly by symbol, no security-id resolution step the way Dhan's binary protocol
needs (`resolve_feed_target`). Meaningfully simpler to maintain as a result — no `struct.unpack`,
no numeric-segment-code table. Same reconnect/exponential-backoff shape as `dhan_feed.py`
(`_backoff_delay`, doubling per consecutive failure up to `RECONNECT_DELAY_MAX_SECONDS`), same
`GET /delta/feed-status`/`POST /delta/feed/subscribe` route shape as Dhan's — kept on its own
`/delta/...` path rather than generalizing both providers onto one shared route now, avoiding any
change to Dhan's already-working routes for a speculative abstraction.

**Contract widening**: `SignalIngest.exchange`/`ResolvedOrder.exchange` (both systems' Pydantic
mirrors, both `docs/contracts/*.schema.json`) widened from `["NSE","MCX"]` to include `"CRYPTO"` —
without this a resolved CRYPTO signal couldn't flow through the pipeline at all, even though
`segment` already accepted `"CRYPTO"` everywhere (accounts, square-off defaults) well ahead of
there being a real provider behind it. `exchange="CRYPTO"` (not a Delta-specific code) is used
directly, since segment and exchange already always co-occur 1:1 for every existing segment too.

**Sizing/currency simplification, worth stating explicitly**: Delta quotes in USD; every other
segment's `capital_per_trade`/`current_balance` is implicitly INR. There's no FX conversion
anywhere in this integration — since this is paper trading only (no real capital ever at risk,
platform-wide), the `CRYPTO` account row's `capital_per_trade` is just treated as a raw number of
USD-equivalent units for sizing purposes, the same way every other segment's number is implicitly
INR. Not a bug to fix later, a deliberate simplification given nothing here is real money.

**Option chain (Phase 2)** — `DeltaProvider.get_expiry_list`/`get_option_chain` mirror Dhan's own
Phase 4a exactly in shape (same `OptionChain`/`OptionChainStrike`/`OptionLegQuote` models, same
`GET /options/expiries`/`GET /options/chain` routes — genuinely zero route changes, since
`app/api/routes/options.py` already duck-types `getattr(provider, "get_expiry_list"/
"get_option_chain", None)` for exactly this reason). Two things make Delta's version simpler than
Dhan's, though. First, options are keyed by **underlying asset symbol** (`"BTC"`), not the
tradeable perpetual's own symbol (`"BTCUSD"`) — confirmed `GET /v2/products/BTCUSD` →
`underlying_asset.symbol = "BTC"` — so `sync_instruments()` captures this mapping
(`_symbol_to_underlying_asset`) for free off data already being fetched, no extra call. Second,
**one bulk call covers every live expiry at once**: `GET /v2/tickers?contract_types=call_options,
put_options&underlying_asset_symbols=BTC` returned 395 live BTC contracts across all 7 live
expiries in a single response (confirmed live), with full Greeks/OI/IV/bid-ask already included —
unlike Dhan, which needs a separate throttled call per expiry. `get_expiry_list` and
`get_option_chain` share one cached fetch (`_fetch_option_rows`, keyed by underlying asset, not
`(symbol, expiry)` the way Dhan's per-expiry cache is) — `get_expiry_list` extracts the distinct
expiries from it, `get_option_chain` filters to one.

Confirmed live: **the ticker response has no expiry/settlement-time field at all** (unlike
`/v2/products`, which does) — expiry instead comes from the option's own symbol string, format
`C-BTC-{strike}-{DDMMYY}` / `P-BTC-{strike}-{DDMMYY}` (e.g. `C-BTC-61600-150826` → `2026-08-15`,
confirmed to exactly match the real settlement date), parsed by `_parse_option_symbol`.
`get_option_chain` returns `None` only when the underlying itself is unresolvable or has no live
options at all; if it resolves but nothing matches the *requested* expiry specifically, it returns
a chain with `strikes=[]` rather than `None` — still a real, resolvable market, just empty at that
date — with `underlying_last_price` taken from any other available row's `spot_price` (a shared
reference regardless of which expiry it came from).

Two small, backward-compatible widenings to the **shared** option-chain models
(`app/domain/models.py`, used by Dhan's existing code too — re-verified `test_dhan_option_chain.py`
passes byte-for-byte unchanged after both): `OptionGreeks` gained an optional `rho` (Dhan doesn't
send it; Delta does), and `OptionLegQuote.previous_oi` became optional / `.volume` became `float`
(Delta's ticker response has no previous-OI figure at all — only a dollar-denominated 6h change,
not a contract-count delta — and its volume is asset-denominated, e.g. `0.04` BTC, not a whole
contract count the way Dhan's is).

**Strike/strategy selection (Phase 3)** — `choose_strategy`/`option_templates.py`
(`signal-processing`) turned out to already be fully exchange-agnostic: neither module has a
single NSE/MCX-specific branch anywhere, since both operate only on `signal.exchange`/
`signal.symbol` (plain strings) and on the chain's already-normalized dict shape, identical for
Dhan and Delta. The one real gap found while verifying this: `infra/postgres/init/
01-signal-processing.sql`'s `signals.exchange`/`resolved_orders.exchange` `CHECK` constraints
still only allowed `('NSE','MCX')` — Phase 1's contract widening covered the Pydantic mirrors and
JSON schemas but missed these two DB constraints, so no CRYPTO signal could actually be persisted
until fixed (both here and applied live to the running dev volume, same manual-`ALTER TABLE`
procedure this doc's DB-schema section already documents for exactly this kind of gap).
Live-verified end to end against the real Delta option chain (dev stack, no mocks): a throwaway
`segment='CRYPTO', instrument_type='option'` strategy, a `BUY` signal resolved a real
`bull_call_spread` (real strikes/expiry/`product_id`s off the live BTCUSD chain), a `SELL` signal
resolved a real `bear_put_spread`, both published correctly onto `orders.resolved`.

**Execution (Phase 4)** — `option_position_manager.py` (Phase 4d) turned out to already be fully
exchange-agnostic too (confirmed by generalizing it for the naked call/put option style, landed in
the same session — see § above — before this phase's own work; the leg-count generalization needed
zero further changes for CRYPTO). Three real gaps were found and fixed, all in `market-data`, all
the same shape as the DB-constraint gap above — an interface CRYPTO was assumed to already satisfy,
but one provider-specific code path never got extended:
1. `GET /instruments/resolve-by-security-id` called `provider.resolve_symbol_by_security_id(...)`
   directly, no `getattr` guard the way `options.py`'s routes already have — `DeltaProvider` had no
   such method at all (an unhandled 500, not a clean 404). Fixed both the missing method
   (`DeltaProvider.resolve_symbol_by_security_id` — a single `GET /v2/products/{id}` call,
   confirmed live it resolves **both** perpetuals and options by numeric `product_id`, so no local
   reverse-lookup map needs building) and the route's duck-typing.
2. `DeltaProvider.get_ltp_batch` hardcoded `contract_types=perpetual_futures` — an option's own
   symbol never appeared in the result. Fixed by partitioning a batch's symbols into option-shaped
   (via the existing `_OPTION_SYMBOL_RE`) vs perpetual-shaped; option symbols are grouped by their
   own encoded underlying asset and served via the already-cached `_fetch_option_rows` (Phase 2) —
   no new Delta endpoint needed, same "one bulk call" pattern this file already uses twice.
3. `DeltaProvider.get_lot_size` checked only `_symbol_to_product_id` (perpetuals-only, populated by
   `sync_instruments()`) — an option's own symbol was never in it, so lot size always came back
   `None` for any option leg (only found live, after fixing 1-2, when a real position-open still
   failed at the lot-size step). Fixed the same way as `get_ltp_batch`: shape-detect via
   `_OPTION_SYMBOL_RE` first, return `1` directly (Delta options, like perpetuals, have no separate
   lot-multiplier concept) — no `sync_instruments()` call needed for an option symbol at all.

Live-verified the full lifecycle end to end on the dev stack, both templates: a `bull_call_spread`
and a `naked_call`, each opened as a real `OPEN` position (`GET /option-groups?with_live_pnl=true`
showing correct `net_debit`/`quantity`/live mark-to-market), then closed via
`POST /option-groups/{id}/square-off` at a fresh live quote — confirming `resolve_symbol_by_security_id`
and the option-aware `get_ltp_batch`/`get_lot_size` all work for CRYPTO at every lifecycle stage, not
just at open time.

## MCX/NSE-index market-data support

Phase 3 needed `market-data` to go from "one NSE cash-equity `DhanProvider`" to "several Dhan segments across two exchanges" — GOLDM/CRUDEOILM (MCX commodity futures), NIFTY/BANKNIFTY (NSE index spot *and* index futures). `DhanProvider` now takes a list of `SegmentConfig`s (`app/providers/dhan.py`) — one per Dhan segment (`ltp_segment_key`/`candle_exchange_segment` like `"NSE_EQ"`/`"MCX_COMM"`/`"NSE_FNO"`/`"IDX_I"`, a CSV `row_matches` filter, and — for futures configs only — an `underlying_of` extractor for active-month grouping). Still **one provider instance per exchange**, not per segment, so `router.py`'s existing exchange-keyed `_PROVIDERS` dict needed no shape change — the NSE instance just holds three configs (equity, index spot, index futures) instead of one, MCX holds one (commodity futures). A single instrument-master CSV download is filtered by every config in one pass; every Dhan field value the configs rely on (`SEM_EXM_EXCH_ID`, `SEM_SEGMENT`, `SEM_INSTRUMENT_NAME`, `SM_SYMBOL_NAME`, `SEM_LOT_UNITS`) was checked against a live download before being hardcoded, not assumed from documentation alone — same empirical-discovery practice this file's rate-limit constants already followed. One concrete surprise from that check: `SEM_LOT_UNITS` is `1` for MCX commodity futures (their quoted price already represents a full lot) but a real multiplier for NSE index futures (NIFTY=65, BANKNIFTY=30, matching known F&O lot sizes) — the lot-size-aware sizing below (execution) handles both without special-casing, it just reads whatever this field says.

Two new capabilities fall out of this:

- **`GET /instruments/resolve?segment=&underlying=`** — given a logical underlying name, returns what to *chart* indicators on vs. what to actually *trade*. Equal for commodities (GOLDM has no continuous spot — chart and trade the same active-month `FUTCOM` contract). Different for indices (NIFTY/BANKNIFTY have a continuous spot value, which is what's actually charted for RSI — no rollover noise — but the *tradeable* instrument, per the in-house engine's "future signals now, options later" design below, is the active-month index future). `DhanProvider.resolve_active_contract()` picks the nearest not-yet-expired contract from whatever the most recent sync produced — no separate rollover-detection job, it's just re-derived fresh each call.
- **`GET /instruments/lot-size?exchange=&symbol=`** and **`GET /candles/history?exchange=&symbol=&interval=&from=&to=`** — the former for execution's lot-size-aware sizing (below), the latter a general multi-bar range (still via Dhan's `/charts/intraday`, **not** `/charts/historical` — that endpoint is daily-bar-only, the wrong granularity for intraday RSI) used to warm up the in-house engine's indicator state and for backtesting. `GET /candles/previous` (the narrow single-value endpoint execution's stop-loss method depends on) is unchanged, not replaced.

## The in-house indicator engine

`signal-generation` now has a real engine, built fresh in Python inside its existing `backend/` service (no new microservice, no submodule — an earlier sketch of this phase assumed wiring in a pre-existing engine/backtesting repo; there wasn't one, so this was built from scratch instead). `Strategy` gains two fields for `source_type='in_house'`: `underlying` (e.g. `"GOLDM"`) and `rule_config`, a **typed JSON blob** rather than dedicated columns (`{"type": "crossover", "indicator_id": "<uuid>"}` today — no parameters of its own, see below) — deliberately, so a second rule (or a multi-indicator combination) later is new code in `app/domain/rules.py`, not a schema migration. `interval`, purely descriptive for webhook strategies since Chartink's firing cadence isn't something this platform controls, becomes load-bearing here — it's the engine's own check/candle cadence.

### Indicators are decoupled from Strategy

RSI's own parameters used to live directly inside `Strategy.indicator_config` (`{"type": "rsi_sma_crossover", "rsi_period": 14, "sma_period": 9}`) — one indicator, baked into one strategy, with no way to reuse "RSI 14" across multiple strategies without re-entering its params each time. Split into two entities instead: **`Indicator`** (`signal_generation.indicators` — `name`, `type`, `params`) is a reusable definition managed independently via `POST/GET/PATCH/DELETE /indicators`; a **`Strategy`**'s `rule_config` only names *which* indicator it uses (`indicator_id`). Any number of strategies can reference the same `Indicator` row. No DB-level FK from `rule_config`'s `indicator_id` to `indicators.id` (it's nested inside JSONB, not a plain column) — existence is checked at the API layer instead (`create_strategy`/`update_strategy` 422 if the id doesn't resolve), matching this repo's established "no cross-entity FK enforcement, defensive runtime checks instead" pattern.

The RSI indicator's own signal line (the SMA-of-RSI, what the crossover rule actually compares RSI against) is a **second decision, bundled into the indicator, not the rule**: `RsiParams` is `{period, sma_period}` — both settings live together on the `Indicator`, matching how TradingView's own RSI script bundles "RSI Length" and "MA Length" into one indicator's settings dialog rather than splitting them across two objects. This means `CrossoverRuleConfig` carries no parameters of its own at all beyond `indicator_id` — "value crosses its own signal line" is entirely generic, and *what* the signal line even is stays entirely up to the indicator. Editing an indicator's `sma_period` (`PATCH /indicators/{id}`) changes it for every strategy referencing that indicator at once, by design — the same value, defined once.

This reshapes the pure-function split too: `app/domain/indicators.py` owns everything that varies **per indicator type**, including both series - `compute_indicator(indicator_type, params, closes)` (the primary value, e.g. RSI itself) and `compute_indicator_signal(indicator_type, params, closes)` (the indicator's own signal line, e.g. SMA-of-RSI using its own `sma_period`), plus `indicator_warmup(indicator_type, params)` (now `period + sma_period` for RSI, since both series need to be warmed up before a crossover can be evaluated). `app/domain/rules.py` owns everything that varies **per rule type** and is deliberately indicator-agnostic — `evaluate_crossover(value_series, signal_series)` just compares two already-computed series against each other, with no idea what indicator produced them or how the signal series was derived (nothing about "value crosses signal" is RSI-specific; it'll work unchanged for any future indicator that exposes its own signal line, e.g. MACD's own signal line), plus the top-level `evaluate(rule, indicator_type, indicator_params, candles)`/`bars_needed(...)` dispatchers everything else calls. Single indicator per strategy for now — combining multiple different indicators (RSI AND MACD, etc.) into one rule stays a later step, not built yet.

`app/domain/engine.py`'s live tick and `app/domain/backtest.py`'s replay both call the **exact same** `rules.evaluate()`/`bars_needed()`, so live behavior and a backtest report can never silently disagree about what counts as a signal. A new `signal_generation.engine_runs` table (one row per strategy, `last_signal_candle_ts`) is deliberately separate from the `strategies` config table — it's mutable runtime bookkeeping (which completed bar a strategy last acted on, so the poll loop — which runs far more often than any one strategy's own `interval` — doesn't re-signal on the same bar every tick), not user configuration. If an `Indicator` is deleted while a `Strategy` still references it, the engine logs and skips that strategy on its next tick rather than crashing — the API-layer existence check above is the primary guard, this is the defensive second line for a reference that goes stale later.

### Market regime filter: a gate on the crossover signal, not a new Indicator/Rule type

A shared trading-analysis document recommended classifying market regime (`UPTREND`/`DOWNTREND`/`RANGE`/`TRANSITION`) from confirmed swing structure (HH/HL vs LH/LL), Efficiency Ratio, ADX/DMI, and ATR-normalized EMA slope — combined by AND-conditions, not voted equally — and using it as supporting evidence alongside a primary trading signal. `app/domain/regime.py` implements exactly this, but deliberately **not** as a new `Indicator`/`RuleConfig` — the existing `Indicator`/`rules.py` machinery is built entirely around a scalar series (RSI + its own SMA signal line) consumed by one rule ("value crosses signal"); a regime classifier is a categorical, multi-input composite that doesn't fit that contract, and forcing it in would buy no reuse. Instead it's a self-contained pure-function module that both `engine.py` and `backtest.py` call **after** `rules.evaluate()` finds a crossover signal, to decide whether to act on it — regime stays supporting evidence, the crossover stays the actual trigger, matching the source document's own framing.

`Strategy.regime_filter_enabled` (default `false`, in_house only, harmlessly ignored for webhook strategies) is the master toggle — no per-strategy threshold tuning yet, but which of the 5 sub-conditions actually gate a signal **is** selectable (see below). `regime.classify_regime()` combines swing pivots (`find_pivots`/`classify_structure`, confirmed pivots only — lagged by `swing_lookback` bars so classification never repaints), Efficiency Ratio, Wilder-smoothed ADX/DMI (sharing the same Wilder-smoothed ATR series both DMI and the EMA-slope normalizer need, computed once), and ATR-normalized EMA slope, all against `DEFAULT_REGIME_PARAMS` — the source document's own suggested starting thresholds (`er_trend_threshold=0.35`, `adx_trend_threshold=20`, etc.), explicitly not yet backtested/tuned for this platform's actual instruments, same caveat the document itself makes. `classify_regime`'s own "regime" label is fixed and always requires **all 5** sub-conditions to agree (not a majority vote) — it's a general-purpose classification, used for display; anything that's neither a clean trend nor a clean range is `TRANSITION` — the document's explicit fourth state ("don't force every candle into trend or range").

**Selectable sub-conditions.** The actual gate a Strategy applies is `regime.direction_confirmed(bias, result, enabled_checks)`, which does NOT trust `classify_regime`'s label — it recomputes only the sub-conditions named in `Strategy.regime_filter_checks` (a JSONB list, one or more of `regime.REGIME_CHECK_NAMES` = `structure`/`efficiency_ratio`/`adx`/`dmi_direction`/`ema_slope`, defaulting to all 5) from the same raw values (`RegimeResult.structure`/`efficiency_ratio`/`adx`/`plus_di`/`minus_di`/`ema_slope`) `classify_regime` already computed. `classify_regime` and `direction_confirmed` share one private helper (`_direction_checks`) for what each of the 5 checks actually means, so there's exactly one definition of "does structure/ER/ADX/DMI/slope agree with this direction," not two that could drift. `regime_filter_checks=[]` is a real, if degenerate, configuration — the filter is "on" but requires nothing, so it confirms trivially (not specially guarded against). Never confirms while the underlying data is still insufficient, regardless of which checks are enabled. Both `engine.py` and `backtest.py` call the same `classify_regime`/`direction_confirmed` with the strategy's own `regime_filter_checks`, so live behavior and a backtest can never disagree about what the filter allows — the same principle `rules.evaluate` already established for the crossover rule itself.

**Single-timeframe by deliberate choice**: `classify_regime` always runs on the same candle series/interval the caller already has (`Strategy.interval`) — no higher-timeframe fetch. The source document's own multi-timeframe design (e.g. 15m regime / execution-timeframe trigger) is a documented future option, not built here; this was an explicit simplicity trade-off, not an oversight.

### Backtest simulates stop-loss/target/square-off, not just raw signal timing

The backtest used to report bare signal timestamps with a naive P&L (enter at one signal's price, exit at the next opposite signal's price) — it ignored `Strategy`'s own `stop_loss_method`/`stop_loss_percent`/`target_percent`/`square_off_time` entirely, even though those fields already exist and are what execution would actually use if the strategy went live. `app/domain/backtest.py`'s `simulate_trades` replaced that: it opens a simulated trade on each fresh signal and closes it the same way execution's real `position_manager` would close a real one — a stop-loss/target hit (checked against each subsequent bar's `high`/`low`, the closest a candle-only backtest can get to execution's continuous CMP monitoring — `rules.CandleClose` gained `high`/`low` fields for exactly this, previously it only carried `close`), `square_off_time`, or, with nothing more specific configured or none of it triggered yet, the next opposite-direction signal (the old behavior, now the fallback rather than the only mode). Only one simulated trade is open at a time — a fresh signal while one is already open is ignored, mirroring `duplicate_signal_policy='skip_if_open'`, execution's own default — and a signal whose own bar is already at or past `square_off_time` never opens at all, mirroring `is_within_intraday_window`'s real rejection.

Both of execution's stop-loss methods are simulated: `percent` needs nothing extra (pure math off the entry price); `previous_candle` needs a second candle series at the strategy's own `stop_loss_interval` (which can differ from its main `interval`) — the route layer (`app/api/routes/strategies.py`) fetches that separately, reusing the already-fetched main series outright when the two intervals happen to match so the common case costs no extra market-data call. `trailing_stop_enabled` is simulated too, ratcheting the stop toward the current price bar-by-bar and never loosening it, same rule execution's `_evaluate_exits` uses. `ExitConfig` (the plain dataclass simulate_trades takes) can't import execution's own pure stop-loss/target formulas directly — no cross-`systems/*` imports — so `_stop_loss_percent_price`/`_target_percent_price` are tiny duplicated formulas, owned independently by each system, same reasoning as everywhere else this platform avoids sharing code across the systems boundary.

The route-facing report (`replay()`) changed shape to match: `{"trade_count", "hypothetical_pnl", "trades": [{entry_time, direction, entry_price, exit_time, exit_price, exit_reason, pnl}, ...]}`, replacing the old `{"signal_count", "signals"}` shape — `exit_reason` is one of `stop_loss`/`target`/`square_off`/`opposite_signal`/`end_of_data` (a trade still open at the end of the requested range, marked to the last available close rather than silently contributing nothing, unlike the old algorithm's unpaired-signal handling). Grid search (`grid_search`) applies the exact same `ExitConfig`/`sl_candles` to every param combination it tries, since SL/target/square-off don't depend on which indicator params are being swept.

### Grid search over indicator params

`POST /strategies/{id}/backtest/grid` sweeps a strategy's referenced indicator across a cartesian product of candidate param values (e.g. `{"period": [7, 14, 21], "sma_period": [5, 9, 14]}`) and reports `replay()`'s naive hypothetical P&L per combination, sorted best-first — the same replay `/backtest` runs for a single param set, just run once per combination in `app/domain/backtest.py`'s `expand_grid`/`grid_search`. A param not named in the request stays fixed at the Indicator's own current value (`expand_grid` merges each combination onto the indicator's real stored params, so the grid only needs to name what it's actually varying). Candle history is fetched **once**, wide enough for the largest `bars_needed` across every combination in the grid — candidate params aren't known until the grid is expanded, so the route computes `max(bars_needed(...) for params in combos)` before making the single `GET /candles/history` call, rather than fetching per-combination and hitting Dhan's rate limit. A combination whose params fail their own validation (e.g. `period=1`, below `RsiParams`'s `gt=1` floor) is reported as an `error` row rather than silently dropped or crashing the whole request. Total combinations are capped (`MAX_GRID_COMBINATIONS = 100` in `backtest.py`) — a 422 asks the caller to narrow the grid rather than letting one request run unboundedly long. This is deliberately read-only: it never mutates the `Indicator` row itself, `PATCH /indicators/{id}` is a separate, explicit step once a winning combination is picked from the report.

The live tick (`app/scheduler.py`, its own `IntervalTrigger`, independent of execution's/market-data's schedulers) resolves each `live`/`in_house` Strategy's underlying via market-data, fetches enough history, evaluates the rule, and — on a fresh crossover — `POST`s to signal-processing's `/signals` with the *trade* symbol/exchange from the resolution above, `source="in_house"`. This is the same `/signals` contract Chartink's webhook route uses; nothing downstream (resolution, Redis publish, execution) needed to change to accept it, only `docs/contracts/signal-ingest.schema.json`'s `exchange` enum needed widening to include `"MCX"` (`resolved-order.schema.json`'s already had `MCX` via `segment`, added for the accounts feature).

Backtesting (`POST /strategies/{id}/backtest?from=&to=`) is a **lightweight signal replay**, chosen deliberately over a full stop-loss/sizing simulation: it fetches history for the range and replays `rules.evaluate()` in a sliding window, reporting where signals would have fired and a naive hypothetical P&L (enter at one signal's price, exit at the next opposite signal's price) — not execution's real position logic. This resolves the long-open "what does backtesting mean operationally" question in a way that's cheap to build and impossible to have drift from live behavior, at the cost of not being a realistic P&L estimate; a full simulation remains a possible later upgrade if the lightweight version proves insufficient. It never auto-promotes `Strategy.status` — that's still a manual `PATCH` after reviewing the report.

### Multi-timeframe Donchian breakout: a second, structurally separate rule type

A price-action strategy needing two independent timeframes doesn't fit the crossover machinery at all: there's no `Indicator` involved, it needs **two** candle series (a higher timeframe for setup, a lower timeframe for the actual trigger) instead of one, and its exits (a static initial stop plus a reversal condition) are intrinsic to the rule rather than expressible via `backtest.py`'s generic `ExitConfig`. So `BreakoutRuleConfig` (`app/domain/models.py`) is a second `RuleConfig` variant alongside `CrossoverRuleConfig`, and `app/domain/breakout.py` is a self-contained module parallel to how `regime.py` stayed separate from `indicators.py`/`rules.py` for the same reason. `engine.py` and `app/api/routes/strategies.py` branch early on `isinstance(rule, BreakoutRuleConfig)` — `rules.evaluate`/`bars_needed` and `ExitConfig` stay exactly what `CrossoverRuleConfig` uses, untouched.

The rule itself: a completed HTF candle closing above the highest high (or below the lowest low) of the previous `htf_breakout_period` HTF candles — a Donchian breakout, optionally also requiring the close be above/below `EMA(ema_period)` — arms an entry window valid only until the *next* HTF candle closes. Within that window, the first LTF candle to close beyond its own `ltf_breakout_period`-bar Donchian channel triggers entry; initial stop is the confirming HTF candle's low/high, set once. A newer HTF candle confirming again before the pending arm triggers simply replaces it (falls out of the walk-forward loop dropping an unconsumed arm at the end of its own bar and only setting a new one when the next bar's condition holds — no special-case "reset" needed). A separate reversal-exit watches every subsequent HTF candle for a single-bar close-vs-previous-close flip (not an N-bar breakout — deliberately asymmetric with entry) and closes (never flips into a new position) on the first LTF candle to break that HTF candle's low/high. Both HTF/LTF intervals and both breakout periods are independently configurable per strategy.

**Live enforcement gap, deliberate**: execution's real position-closing only supports `stop_loss_method` = `previous_candle`/`percent`, a flat `target_percent`, and `square_off_time` — nothing that could express the reversal exit. Rather than extend execution, this stays backtest-first: `app/domain/breakout.py`'s `simulate_breakout_trades`/`replay_breakout` fully simulate entry + initial SL + reversal exit for evaluation, but `evaluate_breakout_live` (the live engine's path) only ever posts entries — the reversal exit is never enforced on a real position. The initial stop **is** enforced live, by reusing execution's existing `previous_candle` mechanism: `app/api/routes/strategies.py` auto-sets `Strategy.stop_loss_method='previous_candle'` and `stop_loss_interval=htf_interval` at create/update time (overriding whatever was passed — this rule type owns its own SL scheme), which works because `stop_loss_method`/`stop_loss_interval`/etc. on a resolved order are pulled from the *resolved Strategy record itself* by signal-processing (`docs/contracts/resolved-order.schema.json`), not from the posted `/signals` payload — so no contract change was needed anywhere. This does mean `htf_interval` must be one of execution's supported stop-loss intervals (`StopLossInterval`: 1/5/15/25/60min) for a strategy meant to go live, even though the general `Interval` type used for HTF/LTF is wider (validated as a 422 at create/update time). `Strategy.interval` (the existing column) is required to equal the rule's own `ltf_interval`, so it stays a meaningful "this strategy's cadence" value rather than being repurposed. Grid search is crossover-only for now — `/backtest/grid` 422s for a breakout-rule strategy.

## Data flow

1. You create a Strategy in `signal-generation` (`POST /strategies`), get back webhook URLs, wire them into a Chartink scan, then `PATCH` the strategy to `status: live` once you've verified it.
2. Chartink fires a scan alert → `POST /webhook/chartink-{buy,sell}?strategy_id=<id>` on `signal-processing` itself (`app/api/routes/webhooks.py`).
3. That route archives the raw payload (`archive_raw_payload` — provider, raw JSON) before anything else, so format drift is debuggable later.
4. It splits `stocks`/`trigger_prices` into one canonical signal per symbol (`app/domain/intake/chartink.py`'s `parse_chartink_alert`, producing `docs/contracts/signal-ingest.schema.json`'s shape: `strategy_id`, `price`, `exchange`, action fixed by the webhook path).
5. For each symbol, it calls `create_signal_from_ingest` in-process — the exact same function `POST /signals` itself calls, no self-HTTP round-trip.
6. signal-processing persists the raw signal, then resolves it by calling `GET /strategies/{strategy_id}` on signal-generation. Non-`live`/unknown/unreachable → persisted as `rejected` with a reason, nothing published. If the strategy has an active window (`active_from_time`/`active_to_time`), the signal's own `timestamp` (not wall-clock time at resolution) must fall inside it — `signal-processing/app/domain/resolution/pipeline.py`'s `is_within_active_window`, converted to `Asia/Kolkata`, same shape as execution's own `is_within_intraday_window` — otherwise `rejected` too, same as a non-live strategy. Otherwise → `horizon`/`instrument_type`/`segment`/stop-loss+target config/`square_off_time`/`duplicate_signal_policy`/`counter_signal_policy` come from the strategy, except `square_off_time` is the earlier of the strategy's own value and its `active_to_time` when both are set (`resolve()`'s only computed field — every other passthrough is unchanged) — this makes `active_to_time` a hard square-off for the position too, entirely via execution's *existing* `square_off_time` handling (late-entry rejection, the periodic square-off job), no execution-side code needed; persists the resolved order and `XADD`s it to the Redis stream `orders.resolved` (`docs/contracts/resolved-order.schema.json`: `strategy_id`, `price`, `exchange`, `segment`, `stop_loss_method`/`stop_loss_interval`/`stop_loss_percent`/`target_percent`/`trailing_stop_enabled`/`square_off_time`/`duplicate_signal_policy`/`counter_signal_policy` all carried through unchanged — still no quantity, see below; `active_from_time`/`active_to_time` themselves never cross this contract, only their effect on `square_off_time` does).
7. execution's Redis consumer group reads the stream and calls `open_position()`:
   - unsupported `horizon`/`instrument_type` (anything but `intraday`+`spot`/`future` for now) → `REJECTED` — this means `square_off_time` (null for non-intraday Strategies) is never actually read for anything that reaches the checks below
   - `square_off_time` missing on an otherwise-supported (`intraday`+`spot`) order → `REJECTED` ("contract violation") - defensive; shouldn't happen since signal-generation requires it there
   - received after the order's `square_off_time` → `REJECTED` ("outside intraday window")
   - signal-conflict resolution (`_resolve_signal_conflicts`, per-strategy, direction-aware): if the symbol already has an `OPEN` position in the **opposite** direction and `counter_signal_policy='close_and_flip'`, it's closed now (`exit_reason='counter_signal'`) — synchronously, ahead of that position's own SL/target/square-off, before the new one is considered; if the symbol has an `OPEN` position in the **same** direction and `duplicate_signal_policy='skip'`, this order is `REJECTED` instead of pyramiding a new one. (`duplicate_signal_policy`/`counter_signal_policy` used to be one global, direction-blind `execution.settings` field — moved onto Strategy so it's per-strategy and direction-aware.)
   - no `execution.accounts` row for the order's `segment` → `REJECTED` ("no account configured") - defensive; all three segments are seeded up front
   - the order's segment account can't afford even 1 share at the signal's price → `REJECTED` ("insufficient account balance") - see "Why paper-trading accounts are per-segment" above
   - a `stop_loss_method='previous_candle'` order whose candle isn't available yet (e.g. just after market open) → `REJECTED`
   - an `instrument_type='future'` order whose lot size can't be resolved via `market-data`'s `GET /instruments/lot-size` → `REJECTED` ("could not determine lot size") - `spot` orders skip this lookup entirely, no added latency there
   - otherwise → new `OPEN` position, entry price = the signal's `price`, `stop_loss_price`/`target_price` computed and stored if configured, and the effective square-off time stored on the row (no quote lookup needed to enter — only to exit/monitor). Quantity (risk-based if a stop-loss method is set, else `floor(effective_capital / signal_price)`, `effective_capital` capped by the segment account's `current_balance`, both in whole **lots** for a `future` order — see § "Lot-size-aware sizing") floors to a minimum of 1 share/lot if the raw calculation comes out to `0` — a position never gets rejected purely for undersized capital/risk (as opposed to an outright out-of-balance account, above).
8. Two independent periodic jobs inside execution (APScheduler — see below), both reading fresh settings/position data each run rather than being scheduled once at a fixed time: the square-off job polls every `square_off_poll_seconds` (default 30s) and closes any `OPEN` position once local time passes **its own stored** `square_off_time`, fetching CMP per distinct exchange from `market-data` and closing with signed P&L (`(exit-entry)*qty` for BUY, `(entry-exit)*qty` for SELL — intraday short-sell is normal for spot MIS), crediting/debiting that P&L to the position's segment account, `exit_reason='square_off'`. The exit-monitor job polls every `exit_monitor_poll_seconds` (default 30s) and closes any `OPEN` position whose CMP has hit its `stop_loss_price`/`target_price` early (`exit_reason='stop_loss'`/`'target'`), trailing the stop favorably in between if `trailing_stop_enabled`. `POST /positions/square-off` (unconditional - closes everything now, ignoring each position's own time), `POST /positions/square-off-due` (same logic the scheduled job runs), `POST /positions/check-exits`, and `POST /positions/{id}/square-off` (exactly one position, `exit_reason='manual'` - the Positions grid's per-row button) run the equivalent logic manually.
9. `signal-generation`, `signal-processing`, and `execution` frontends all poll for what landed; every row with a `signal_id` cross-links to the same signal's view in the other two.

execution's frontend splits `GET /positions` into two grids client-side rather than one combined table: **Positions** (`status='OPEN'` only — the live book, with a per-row `POST /positions/{id}/square-off` button, `exit_reason='manual'`, and each P&L figure showing a `%` return on cost basis (`pnl / (entry_price * quantity)`) next to the ₹ amount) and **Orders** (`CLOSED` + `REJECTED` together — everything no longer live, `CLOSED` showing realized P&L (with the same `%` alongside it), `REJECTED` showing the rejection reason in the same Status column instead). Both still come from the one `GET /positions` endpoint; there's no separate "orders" concept in the schema, just a status filter applied in the UI. Neither grid renders the outbound signal cross-link (see § "Cross-linking between frontends"). Both grids also apply a client-side date filter (`entry_time`'s local-calendar-day, defaulting to today) so rows only need to show a time, not a full date — skipped in `?signal_id=` deep-link mode, since that view is "show me this one row" regardless of when it happened.

### Why the square-off scheduler lives in execution, not a separate orchestrator

Square-off is scheduled via `APScheduler` inside `execution/backend` (`app/scheduler.py`) rather than a separate cron-style trigger, because a missed trigger is costly and the service that owns position state should own the timer too, without depending on a second service being up at exactly that moment.

This used to be a single daily `CronTrigger` fired at `execution.settings.square_off_time`. Once a Strategy could override `square_off_time` per-strategy, a single fire time could no longer cover every position, so the job became a periodic check instead: every `square_off_poll_seconds`, `square_off_due_positions` looks at each `OPEN` position's own stored `square_off_time` (copied from its Strategy at open time) and closes it once local time has passed. This has a nice side effect: settings/strategy changes no longer need an explicit "reschedule the job" step (the old `PUT /settings` handler used to call `reschedule()` to move the cron trigger immediately) - both periodic jobs just read current data fresh on their next run.

A first pass kept `execution.settings.square_off_time` around as a platform-wide fallback default for strategies that didn't set their own (`resolve_square_off_time`, since removed) - dropped almost immediately in favor of making the field required on Strategy instead. A silent fallback meant a strategy's actual square-off behavior wasn't fully visible on the strategy itself; requiring it forces that decision to be explicit at strategy-creation time, matching how `horizon`/`instrument_type` already work.

## Cross-linking between frontends

`signal_id` is the thread that ties a signal to its resolution to its position, and every frontend that has a table of signals/positions supports `?signal_id=<uuid>` as a URL param — on load, it filters to that one row (or shows "not found yet" rather than a blank page, since e.g. execution may not have processed it yet). That inbound side is universal. The outbound side (rendering a `→ System` link per row via a small `src/links.ts` with the other frontends' ports hardcoded) is no longer universal, though: `signal-generation` and `signal-processing` still do it, but `execution`'s two grids (Positions, Orders — see below) dropped their outbound link deliberately, and its `links.ts` was deleted as dead code once nothing referenced it. There's no shared `links.ts` package for the two that remain — two near-identical ~15-line files was judged simpler than a `shared/ts-libs` dependency for this little logic; revisit if it needs to come back to execution too and the duplication starts to hurt.

`signal-generation`'s frontend has its own backend now (strategy CRUD) but still reads signal-processing's `GET /signals?strategy_id=X` directly from the browser (CORS-enabled) for per-strategy signal activity, rather than owning a duplicate copy of that data — it's a view, not a second source of truth.

## Clearing data for a fresh test run

`DELETE /signals` (signal-processing) and `DELETE /positions` (execution) each wipe only their own schema — resolved orders, signals, and raw payloads for the former; positions for the latter — with a confirm-then-delete button in each frontend (destructive, no undo). Deliberately two separate calls rather than one orchestrated "clear everything": no system here ever calls another to mutate its data (see § "Why signal-processing calls signal-generation" above for the read-only exception), and strategies (signal-generation) aren't touched by either — they're config, not signal/trade history, so a fresh test run typically wants them to survive. The Redis stream itself isn't trimmed; already-ACKed entries never redeliver, so this doesn't matter in practice.

## Folder layout

```
algo-trading/
├── docker-compose.yml
├── shell/                        # static tab bar + iframes onto each frontend, not a system
├── docs/
│   ├── architecture.md
│   └── contracts/
│       ├── signal-ingest.schema.json
│       └── resolved-order.schema.json
├── infra/
│   ├── postgres/init/            # schema-per-system init SQL: 01-signal-processing.sql, 02-execution.sql, 03-signal-generation.sql
│   └── redis/redis.conf
├── systems/
│   ├── signal-generation/        # backend (strategy CRUD) + frontend; engine/backtesting/api integration not yet done
│   ├── signal-processing/        # backend (FastAPI) + frontend (React/Vite)
│   ├── execution/                # backend (FastAPI + Redis consumer + APScheduler) + frontend
│   └── market-data/              # backend (FastAPI - provider credentials, quote lookup, live feed) + frontend (status dashboard)
├── shared/
│   ├── python-libs/algotrading_common/
│   └── ts-libs/ui-kit/
└── scripts/
```

## Roadmap

1. ~~**Phase 0:** Chartink → signal-processing backend → Postgres + Redis, placeholder resolution, frontend shows what landed.~~ Done. (Intake ran through n8n at the time; replaced with a direct `signal-processing` webhook route later — see § "Why Chartink intake lives directly in signal-processing.")
2. ~~**Phase 1:** real horizon/instrument resolution — superseded by the Strategy concept: resolution now comes from an explicit, user-configured Strategy rather than rule-based guessing.~~ Done, in a different shape than originally planned.
3. ~~**Phase 2:** `execution` system — paper-trading, intraday spot only, CMP via `market-data`/Dhan, configurable square-off time and duplicate-signal policy, own Postgres schema, own frontend.~~ Done.
4. ~~**Phase 2.5:** Strategy entity in `signal-generation` (own backend/schema), webhook URLs scoped per-strategy via `?strategy_id=`, cross-linked frontends.~~ Done.
5. ~~**Phase 2.6:** capital-based position sizing (`execution.settings.capital_per_trade`), replacing fixed `quantity` on Strategy.~~ Done.
6. ~~**Phase 2.7:** per-strategy stop-loss (previous-candle or %, via a new narrowly-scoped `GET /candles/previous` on `market-data`) + independent %-based target, both optional trailing on the stop-loss; risk-based position sizing (`execution.settings.risk_per_trade_pct`) capped by `capital_per_trade`; a new exit-monitor job in `execution` closing positions early on stop-loss/target hit.~~ Done.
7. ~~**Phase 2.8:** `square_off_time` made a required per-strategy field (no `execution.settings` fallback - a first pass kept one, dropped in favor of forcing every strategy to decide explicitly) - required reworking the square-off scheduler from a single daily `CronTrigger` into a periodic job (`square_off_due_positions`) that checks each `OPEN` position's own stored square-off time instead.~~ Done.
8. ~~**Phase 2.9:** `segment` field on Strategy (NSE/MCX/CRYPTO, separate from the still-fixed `exchange`) purely to auto-default `square_off_time` for intraday strategies (15:00/22:00/17:25) - doesn't gate anything downstream yet, `is_supported()` still only accepts intraday+spot regardless of segment.~~ Done.
9. ~~**Phase 2.10:** paper-trading **accounts** in `execution`~~ Done. - one per `segment` (NSE/MCX/CRYPTO), multiple strategies in the same segment sharing it. Unlike `capital_per_trade` today (a stateless per-trade sizing constant), an account tracks a **real running balance** - `starting_balance`/`current_balance`, debited/credited by realized P&L on every close path (`square_off_all_open`, `square_off_due_positions`, `check_exits`, the per-position manual square-off), so paper P&L actually compounds/depletes like a real account instead of resetting every trade. Unrealized P&L stays computed-only, same as today - only a *closed* position touches the balance. A new failure mode falls out of this: an account whose `current_balance` can't cover even 1 share gets rejected, distinct from the recent "floors to 1 share" fix (that was about `capital_per_trade` being too small, this is the account being out of money). `resolved-order.schema.json` gains `segment` (passed through from Strategy, same pattern as `stop_loss_method`/`square_off_time`) so execution knows which account to charge. Execution's global Settings panel becomes account management (create/edit per segment); the existing single `execution.settings` row and today's positions migrate into a seeded "NSE" account. One account per segment for now (not multiple named accounts per segment) - simplest match for what's actually needed, and additive to extend later. See the open questions below for why this landed *before* Phase 3, not after.
10. ~~**Phase 3:** MCX + NSE-index market-data support, feeding a fresh-built in-house RSI + SMA(RSI) crossover engine.~~ Done - see § "MCX/NSE-index market-data support" and § "The in-house indicator engine" below for the full design. Also pulled forward one piece of what this doc originally scoped as Phase 4: `execution.is_supported()` now accepts `instrument_type='future'` (not just `spot`), since an engine that only ever produces permanently-`REJECTED` signals isn't a useful Phase 3 on its own - options-based execution (below) is still real Phase 4 scope.
11. ~~**Phase 4:** options trading~~ Done, broken into four sub-phases so it didn't land as one giant change:
    - ~~**Phase 4a:** option chain data foundation in `market-data`~~ Done — `DhanProvider.get_expiry_list`/`get_option_chain` (`app/providers/dhan.py`), `GET /options/expiries`/`GET /options/chain`. See § "Option chain (Phase 4a)" below.
    - ~~**Phase 4b:** strike + strategy selection~~ Done — `signal-processing`'s `choose_strategy` (`app/domain/resolution/strategy.py`) picks a **fixed set of bias→template multi-leg strategies** (bullish → bull call spread, bearish → bear put spread — exactly the two named when this was decided, see "Open questions" below), using Phase 4a's chain data to pick the actual strikes within each template's legs. Populates the `strategy: {type, legs: []}` field `resolved-order.schema.json` has reserved and left null all along — see § "Strike + strategy selection (Phase 4b)" below.
    - ~~**Phase 4c:** backtesting single/multi-leg option strategies, intraday and positional~~ Done — `signal-generation`'s `app/domain/option_backtest.py`, wired into the existing `POST /strategies/{id}/backtest` (crossover-rule strategies only so far). Dhan's `POST /charts/rollingoption` (minute-level historical option data, up to 5 years, keyed by strike *relative to spot* like `ATM`/`ATM+10`) is the data source, avoiding a synthetic Black-Scholes pricing model. See § "Backtesting option strategies (Phase 4c)" below.
    - ~~**Phase 4d:** `execution` multi-leg position support~~ Done — an `option_group_id` linking 2 `Position` rows (one per leg) to a new `execution.option_position_groups` row owning the combined P&L and combined stop-loss, since the base schema is one-symbol-per-row. Backend/API only, no grouped frontend view yet. See § "Making an option order tradeable (Phase 4d)" below.
12. ~~**Phase 4.5 → the crypto module:**~~ Done. Crypto via Delta Exchange India, split into its own phased roadmap once started, same reasoning as the options module:
    - ~~**Phase 1:** `market-data` foundation~~ Done — `DeltaProvider`/`delta_feed.py`, instrument sync/candles/quotes/live feed for perpetual futures, `exchange`/`segment="CRYPTO"` widened end to end. See § "CRYPTO segment via Delta Exchange India (Phases 1-4 of the crypto module)" above.
    - ~~**Phase 2:** option-chain data~~ Done — `DeltaProvider.get_expiry_list`/`get_option_chain`, reusing `GET /options/expiries`/`GET /options/chain` unchanged (already provider-agnostic). Delta's `GET /v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=` returns full Greeks/OI/IV per contract across every live expiry in one call, no separate throttled endpoint needed the way Dhan's option chain required. See § above.
    - ~~**Phase 3:** strike + strategy selection for CRYPTO~~ Done — `signal-processing`'s Phase 4b `choose_strategy`/`option_templates.py` needed zero exchange-specific changes, only a DB `CHECK` constraint fix (see § above) and test coverage. Live-verified against the real Delta option chain (both `bull_call_spread` and `bear_put_spread`).
    - ~~**Phase 4:** `execution` support for CRYPTO option spreads~~ Done — `option_position_manager.py` (Phase 4d) needed zero further changes; three gaps found and fixed in `market-data` instead (`resolve_symbol_by_security_id` missing on `DeltaProvider` plus a missing route duck-type guard, `get_ltp_batch` and `get_lot_size` both perpetual-only). Live-verified full open→mark-to-market→close lifecycle for both `bull_call_spread` and the naked call/put style (see § above and § "Naked call/put option style" above).
13. **Phase 5:** live broker adapter(s) for `execution` - real-money execution, a distinct concern from the paper-trading phases above.
14. **Phase 6 (optional):** move off "local only" — VPS/Traefik/TLS, secrets management, CI image builds.

## Open questions (not blocking current phase)

- ~~Options-strategy rule inputs~~ Decided: a **fixed set of bias→template rules** to start (bullish→bull call spread, bearish→bear put spread, etc.), not a general rule engine — see Phase 4b. Re-confirmed when Phase 4a shipped: a more dynamic OI/IV/Greeks-driven strategy *selector* (choosing between several candidate strategies, not just picking strikes within one fixed template) was explicitly considered and deferred — Phase 4a's chain data feeds strike selection within the fixed template first; revisit the dynamic selector only once that simpler version is proven in use.
- ~~MCX and crypto (Delta Exchange) quote providers~~ MCX done as of Phase 3 (instrument sync, active-month contract resolution, general historical candles — see § "MCX/NSE-index market-data support"). Crypto (Delta Exchange India) fully done, Phases 1-4 — see § "CRYPTO segment via Delta Exchange India (Phases 1-4 of the crypto module)".
- ~~What "backtesting" actually means operationally for an in-house Strategy~~ Resolved as of Phase 3: a **lightweight signal replay** (`POST /strategies/{id}/backtest`), not a full stop-loss/sizing simulation — reruns the exact same `rules.evaluate()` function the live engine calls over historical candles, reports where signals would have fired plus a naive hypothetical P&L. Never auto-promotes `backtesting` → `live`; that stays a manual `PATCH` after reviewing the report. See § "The in-house indicator engine".
- Webhook auth — add a shared-secret/HMAC check once anything here is internet-reachable; today `strategy_id` in a query param is not a secret, and the webhook routes have no auth of their own.
- TradingView provider — no route exists yet; adding one is the same pattern as Chartink (`add-signal-provider` skill).
- ~~Stop-loss/target/exit rules~~ Resolved differently than originally guessed here: the *method* (previous-candle or %, plus optional trailing) ended up per-strategy on Strategy, not global on `execution.settings` — stop distance varies enough by strategy/scan/timeframe that a global figure wouldn't have been useful, unlike `capital_per_trade`. The risk *budget* (`risk_per_trade_pct`) stayed global, same reasoning as `capital_per_trade`. See § "Why position sizing lives in execution, not signal-generation" → "Stop-loss/target: the method lives on Strategy, the arithmetic stays in execution".
- Per-strategy (vs. global) `capital_per_trade`/`risk_per_trade_pct` — deliberately still deferred; revisit if different strategies warrant different risk budgets, not just different stop distances. Note this is a different axis from Phase 2.10's per-*account* (per-segment) balance — accounts don't replace this, they add a segment-level bucket that sits above the still-global `capital_per_trade`/`risk_per_trade_pct`.
- Trailing target (not just trailing stop-loss) — considered and explicitly declined when stop-loss/target was built; target stays a fixed `%` from entry with no trailing variant.
- Automatic SL-triggered exit's execution price — `check_exits` closes at the CMP that triggered the check (no slippage modeled, consistent with the rest of this paper-trading system), not the exact stop/target price - worth reconsidering if backtesting accuracy against real broker fills ever matters.
- Multi-indicator combination rules (e.g. RSI AND MACD together) — deliberately deferred when indicators were decoupled from Strategy; `rule_config` names exactly one `indicator_id` today. Revisit once a second indicator type actually exists and a real combined-signal use case shows up, rather than building the composition layer speculatively.
