# market-data

Owns provider credentials, instrument-master sync, and live quote lookups - a single place for "which vendor serves which segment," so `execution` (and later `signal-generation`) call one HTTP API instead of each embedding their own broker SDK and credentials. Has its own frontend (`systems/market-data/frontend`) - a small status dashboard polling `GET /health`, `GET /instruments/sync-status`, and `GET /dhan/feed-status` (below) every 5s.

## Scope right now

- **NSE (cash equity, indices, index futures) and MCX (commodity futures), via Dhan.** `GET /quotes/ltp?exchange=NSE&symbol=RELIANCE` looks up the security ID from Dhan's instrument master (synced daily at 08:00 IST, plus once on startup) and returns the last traded price from Dhan's `/v2/marketfeed/ltp`. `POST /quotes/ltp/batch` fetches many symbols - even across different Dhan segments (e.g. an equity and an index future in one call) - in one throttled Dhan call; prefer it over repeated `GET /quotes/ltp` for more than a couple of symbols. One `DhanProvider` instance per exchange (`NSE`, `MCX`), each covering every Dhan segment that exchange needs (`app/providers/dhan.py`'s `SegmentConfig`) - see `docs/architecture.md` Phase 3.
- **Historical candles**: `GET /candles/previous` returns only the single most recently *completed* candle for a symbol/interval - built for signal-generation's per-strategy stop-loss method. `GET /candles/history?from=&to=` returns every completed candle in a caller-supplied date range - built for signal-generation's indicator engine (warming up RSI/SMA state) and backtesting. Both use Dhan's `/v2/charts/intraday` (not `/charts/historical`, which is daily-bar-only - the wrong granularity here).
- **Underlying resolution**: `GET /instruments/resolve?segment=&underlying=` - given a logical underlying (`GOLDM`, `NIFTY`, ...), resolves what to chart indicators on and what to actually trade. Equal for commodities (no continuous spot - chart and trade the same active-month future); different for indices (chart the continuous index spot, trade the active-month index future). `GET /instruments/lot-size?exchange=&symbol=` - lot size for an already-resolved trading symbol (1 for cash equity/index spot, a real multiplier for futures), used by `execution` to size futures positions in whole lots.
- **Option chain (Phase 4a of the options trading module - see `docs/architecture.md`)**: `GET /options/expiries?exchange=&symbol=` and `GET /options/chain?exchange=&symbol=&expiry=` - OI, IV, top bid/ask, and Greeks (delta/theta/gamma/vega) per strike, plus an ITM/ATM/OTM `moneyness` label computed from the chain itself (Dhan doesn't send one). Live/current data only.
- **Option leg history (Phase 4c)**: `GET /options/leg-history?exchange=&symbol=&option_type=&strike=&expiry_flag=&expiry_code=&interval=&from=&to=` - historical premium for one leg, tracked *relative to spot* (`strike` e.g. `"ATM"`/`"ATM+2"`, Dhan resolves the real strike server-side per bar) via Dhan's `POST /charts/rollingoption` - signal-generation's option-strategy backtesting data source. NSE/BSE only (assumed - no MCX derivatives segment is documented for this Dhan endpoint, unlike the option chain above).
- Crypto (Delta Exchange) remains a documented extension point in `app/providers/router.py`, not implemented.

## Credentials

Needs `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN` (from your Dhan account -> API access). Dhan access tokens are login-generated and expire (observed: ~24h from issuance) - `market-data` renews the token automatically before that happens (`app/providers/dhan.py`'s `renew_access_token`, on a schedule via `app/scheduler.py`, default every `DHAN_TOKEN_RENEW_INTERVAL_HOURS=20`h), so this is normally hands-off. In-memory only, though - a container restart still reverts to whatever's in `.env`. If `GET /quotes/ltp` starts returning `502` with "access token" in the message (or `GET /dhan/token-status` shows a stale `last_renewed_at`), the token has likely gone fully invalid (e.g. regenerated from Dhan Web elsewhere, which invalidates the old one) - regenerate it in Dhan and update `.env`, then `docker compose up -d market-data-backend` to pick it up. **Dev and test must each use their own separate Dhan token** - see `docs/architecture.md`'s market-data section for why sharing one across two auto-renewing stacks breaks both.

## Rate limiting

Dhan's LTP endpoint is rate-limited to 1 request/second, and it's stricter in practice than a bare 1.0s gap - `DhanProvider` self-throttles to a 2s minimum gap between LTP calls (`MIN_LTP_CALL_INTERVAL_SECONDS`) and fetches all requested symbols in **one** call via `get_ltp_batch` (Dhan supports up to 1000 instruments per LTP request) rather than looping per symbol - a per-symbol loop here was tried first and caused real rate-limit pileups under execution's polling, see `docs/architecture.md`. A short (3s) in-memory quote cache further absorbs repeated lookups within a few seconds.

`charts/intraday` (candles) has its own independent throttle (`MIN_CANDLE_CALL_INTERVAL_SECONDS`, own lock/timestamp, not shared with LTP - no documented Dhan rate limit for this endpoint, so this is a conservative default) and its own cache keyed by `(symbol, interval)` with a TTL equal to the interval's own length, since a completed candle doesn't change until the next one closes. Unlike LTP, there's no true multi-symbol batching for candles - Dhan's endpoint is per-security-id.

`optionchain`/`optionchain/expirylist` (option chain) have their own throttle too (`MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS = 3.0`) - this one Dhan *does* document explicitly: 1 unique request per 3 seconds. Cached per `(symbol, expiry)` for a few seconds (`OPTION_CHAIN_CACHE_TTL_SECONDS`), same reasoning as the LTP cache.

## Live market feed

`market-data` also maintains a real, continuous Dhan **live market feed** WebSocket connection (`app/providers/dhan_feed.py`, `wss://api-feed.dhan.co` - see https://docs.dhanhq.co/api/v2/guides/live-market-feed) - not REST polling. Started automatically on startup, runs in a background thread for the life of the process, and reconnects on its own after any disconnect. Subscribes Ticker mode only (LTP + last-trade-time - the cheapest of Dhan's three feed modes, enough to prove the connection is genuinely live) for a small default watchlist (`NIFTY`) plus whatever's added via `POST /dhan/feed/subscribe`. In-memory only, same as everything else here - a restart clears subscriptions back to the default watchlist.

## Endpoints

- `GET /health`
- `GET /quotes/ltp?exchange=NSE&symbol=RELIANCE`
- `POST /quotes/ltp/batch` - `{exchange, symbols: [...]}` -> `{prices: {symbol: ltp}}`, one Dhan call for many symbols
- `GET /candles/previous?exchange=NSE&symbol=RELIANCE&interval=5min` - most recently completed candle only
- `GET /candles/history?exchange=&symbol=&interval=&from=&to=` - every completed candle in range
- `GET /instruments/resolve?segment=MCX&underlying=GOLDM` - chart/trade symbol resolution for an underlying
- `GET /instruments/lot-size?exchange=MCX&symbol=GOLDM-04Sep2026-FUT` - `{lot_size}` for a resolved symbol
- `POST /instruments/sync` - manual resync (also runs daily + once on startup)
- `GET /instruments/sync-status` - per-provider symbol count + last sync time
- `POST /dhan/renew-token` / `GET /dhan/token-status` - manual trigger + current state for the automatic access-token renewal above
- `GET /dhan/feed-status` - live feed connection health + last ticks
- `POST /dhan/feed/subscribe` - `{exchange, symbol}`, adds one more symbol to the live feed
- `GET /options/expiries?exchange=NSE&symbol=NIFTY` - `{expiries: [...]}`, active option expiry dates for an underlying
- `GET /options/chain?exchange=NSE&symbol=NIFTY&expiry=2026-08-14` - full option chain (OI/IV/Greeks/moneyness per strike)
- `GET /options/leg-history?exchange=NSE&symbol=NIFTY&option_type=CE&strike=ATM&expiry_flag=WEEK&expiry_code=0&interval=5&from=2026-07-01&to=2026-08-01` - historical premium for one leg, tracked relative to spot

No database - this system holds no business-critical state, just a cached provider lookup and in-memory feed/token state, both cheap to rebuild on restart.
