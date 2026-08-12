# market-data

Owns provider credentials, instrument-master sync, and live quote lookups - a single place for "which vendor serves which segment," so `execution` (and later `signal-generation`) call one HTTP API instead of each embedding their own broker SDK and credentials.

## Scope right now

- **NSE (cash equity, indices, index futures) and MCX (commodity futures), via Dhan.** `GET /quotes/ltp?exchange=NSE&symbol=RELIANCE` looks up the security ID from Dhan's instrument master (synced daily at 08:00 IST, plus once on startup) and returns the last traded price from Dhan's `/v2/marketfeed/ltp`. `POST /quotes/ltp/batch` fetches many symbols - even across different Dhan segments (e.g. an equity and an index future in one call) - in one throttled Dhan call; prefer it over repeated `GET /quotes/ltp` for more than a couple of symbols. One `DhanProvider` instance per exchange (`NSE`, `MCX`), each covering every Dhan segment that exchange needs (`app/providers/dhan.py`'s `SegmentConfig`) - see `docs/architecture.md` Phase 3.
- **Historical candles**: `GET /candles/previous` returns only the single most recently *completed* candle for a symbol/interval - built for signal-generation's per-strategy stop-loss method. `GET /candles/history?from=&to=` returns every completed candle in a caller-supplied date range - built for signal-generation's indicator engine (warming up RSI/SMA state) and backtesting. Both use Dhan's `/v2/charts/intraday` (not `/charts/historical`, which is daily-bar-only - the wrong granularity here).
- **Underlying resolution**: `GET /instruments/resolve?segment=&underlying=` - given a logical underlying (`GOLDM`, `NIFTY`, ...), resolves what to chart indicators on and what to actually trade. Equal for commodities (no continuous spot - chart and trade the same active-month future); different for indices (chart the continuous index spot, trade the active-month index future). `GET /instruments/lot-size?exchange=&symbol=` - lot size for an already-resolved trading symbol (1 for cash equity/index spot, a real multiplier for futures), used by `execution` to size futures positions in whole lots.
- Crypto (Delta Exchange) remains a documented extension point in `app/providers/router.py`, not implemented.

## Credentials

Needs `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN` (from your Dhan account -> API access). Dhan access tokens are login-generated and expire (observed: ~24h from issuance); if `GET /quotes/ltp` starts returning `502` with "access token" in the message, regenerate the token in Dhan and update `.env`, then `docker compose up -d market-data-backend` to pick it up.

## Rate limiting

Dhan's LTP endpoint is rate-limited to 1 request/second, and it's stricter in practice than a bare 1.0s gap - `DhanProvider` self-throttles to a 2s minimum gap between LTP calls (`MIN_LTP_CALL_INTERVAL_SECONDS`) and fetches all requested symbols in **one** call via `get_ltp_batch` (Dhan supports up to 1000 instruments per LTP request) rather than looping per symbol - a per-symbol loop here was tried first and caused real rate-limit pileups under execution's polling, see `docs/architecture.md`. A short (3s) in-memory quote cache further absorbs repeated lookups within a few seconds.

`charts/intraday` (candles) has its own independent throttle (`MIN_CANDLE_CALL_INTERVAL_SECONDS`, own lock/timestamp, not shared with LTP - no documented Dhan rate limit for this endpoint, so this is a conservative default) and its own cache keyed by `(symbol, interval)` with a TTL equal to the interval's own length, since a completed candle doesn't change until the next one closes. Unlike LTP, there's no true multi-symbol batching for candles - Dhan's endpoint is per-security-id.

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

No database - this system holds no business-critical state, just a cached provider lookup that's cheap to rebuild on restart.
