import logging
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import func

from app.adapters.db.models import EquityDailyBar, EquityScreenerSnapshot, OiEodSnapshot, SentimentHistory, ZoneScan
from app.adapters.db.session import SessionLocal
from app.config import settings
from app.domain import job_tracker
from app.domain.dhan_retry import dhan_retry_delay
from app.domain.job_tracker import tracked
from app.domain.equity_screener import compute_equity_screener_row
from app.domain.models import Candle
from app.domain.oi_buildup import PreviousSnapshot, compute_eod_buildup
from app.domain.sentiment import SENTIMENT_UNDERLYINGS, is_within_session
from app.domain.sentiment_fetch import fetch_underlying_sentiment
from app.domain.zone_scan import read_zones, tier_for
from app.providers import nse_indices
from app.providers.router import all_providers, get_provider

logger = logging.getLogger(__name__)
# Nothing in this service configures logging (uvicorn only sets up its own
# loggers), so a bare logger.info here never reaches `docker compose logs` -
# only WARNING+ does, via Python's last-resort handler. The EOD jobs' start /
# summary lines are what tell you a run happened at all, so give THIS logger
# its own handler rather than turning INFO on for the whole process (every
# Dhan httpx call would then log too).
if not logger.handlers and not logging.getLogger().handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
_scheduler = BackgroundScheduler(timezone=settings.timezone)


THROTTLE_RETRY_ATTEMPTS = 8
THROTTLE_RETRY_SLEEP_SECONDS = 5.0
# A real Dhan 429 needs longer than our own queue-full wait for its budget to refill.
DHAN_429_RETRY_SLEEP_SECONDS = 10.0


def _retry_when_throttled(fn, *args):
    """Calls fn(*args), waiting out a Dhan rate-limit rejection instead of
    failing the symbol outright. Two flavours, both retried:

    * DhanProvider._throttle's LOCAL "queue is backed up" RuntimeError - the
      EOD batch jobs share Dhan's per-endpoint throttle with everything else
      in this process (browser pollers, the 5-minute sentiment job that fires
      on the same :40 boundary as the OI job). A failed call reserves no slot
      and never sleeps, so without a retry a single brief collision made the
      loop rip through the ENTIRE ~210/~2000-symbol batch in about a second,
      every symbol failing - zero rows written for the day.
    * A real HTTP 429 from Dhan ("rate limit hit (429)"). The local throttle
      sits exactly on Dhan's documented 1-request-per-3s limit (and Dhan is
      known to 429 slightly outside its documented gap - see
      MIN_LTP_CALL_INTERVAL_SECONDS), so network jitter or another process on
      the same account (the manual retry script runs in its OWN process with
      its own clocks) can trip it mid-batch. That used to abandon the symbol
      on the first 429; now it backs off longer, since the budget needs time
      to refill, and only then gives up.

    Anything else (bad symbol, auth, HTTP error) propagates to the caller's
    own per-symbol handling unchanged. The message-sniffing itself
    (dhan_retry_delay) is shared with app/domain/dhan_retry.py's own
    interactive_retry - the interactive Dhan-backed routes' much shorter-
    budget version of this same retry, for the same two transient shapes."""
    for attempt in range(THROTTLE_RETRY_ATTEMPTS):
        try:
            return fn(*args)
        except RuntimeError as e:
            sleep_seconds = dhan_retry_delay(str(e), THROTTLE_RETRY_SLEEP_SECONDS, DHAN_429_RETRY_SLEEP_SECONDS)
            if sleep_seconds is None:
                raise
            if attempt == THROTTLE_RETRY_ATTEMPTS - 1:
                raise
            time.sleep(sleep_seconds)


def _log_eod_summary(job: str, total: int, tally: dict[str, int]) -> None:
    """One line per EOD batch run: how many symbols it tried and how each
    ended. A run that wrote nothing (or failed everything) is logged at
    WARNING so it stands out in `docker compose logs`."""
    detail = ", ".join(f"{k}={v}" for k, v in tally.items())
    message = f"scheduled {job}: finished, {tally['written']}/{total} written ({detail})"
    if tally["written"] == 0:
        logger.warning("%s - NOTHING WAS WRITTEN", message)
    else:
        logger.info(message)


@tracked("instrument-sync-daily", "Instrument master sync")
def _sync_all() -> None:
    run = job_tracker.current()
    providers = all_providers()
    tally = {"ok": 0, "failed": 0}
    run.set_total(len(providers) + 1)  # each provider, then the NSE index universes
    for i, provider in enumerate(providers, 1):
        try:
            provider.sync_instruments()
            tally["ok"] += 1
        except Exception:
            tally["failed"] += 1
            logger.exception("scheduled instrument sync failed for provider %s", provider.name)
        run.tick(i, tally)

    try:
        nse_indices.sync_universes()
        tally["ok"] += 1
    except Exception:
        tally["failed"] += 1
        logger.exception("scheduled NSE index universe sync failed")
    run.tick(len(providers) + 1, tally)


@tracked("dhan-token-renew", "Dhan token renewal", keep_skips=False)
def _renew_dhan_token() -> None:
    """Runs every few minutes (and at start-up) and renews only when the token is due: see platform_dhan.renewal_state. Most runs find nothing
    to do and leave no row in the job log."""
    from app.providers import platform_dhan

    run = job_tracker.current()
    try:
        out = platform_dhan.renew_if_due()
    except Exception as exc:
        logger.exception("scheduled Dhan token renewal failed")
        run.fail(f"{type(exc).__name__}: {exc}"[:300])
        return
    if not out.get("renewed"):
        if out.get("deferred"):
            logger.info("Dhan token renewal put off: %s", out["reason"])
        run.skip(out["reason"])
        return
    if settings.platform_dhan_from_accounts and not out["saved_back_to_settings"]:
        run.note("renewed, but the new token could not be saved to the account, so the Settings copy is stale")


def _sync_platform_dhan() -> None:
    """Use the Dhan token saved on the Settings page when it outlives the one in use (app/providers/platform_dhan.py). Quiet: it runs every few
    minutes, so it is not in the job log; an adoption is logged."""
    from app.providers import platform_dhan

    try:
        platform_dhan.refresh_from_accounts()
    except Exception:
        logger.exception("could not check the Dhan token saved in Settings")


# keep a day of the five-minute recorder's runs, and drop the ones it skips: it skips every night and weekend, which is noise
@tracked("sentiment-history-record", "Sentiment recorder", keep=288, keep_skips=False)
def _record_sentiment_history() -> None:
    """Writes one market_data.sentiment_history row per SENTIMENT_UNDERLYINGS
    symbol whose exchange is currently in session (is_within_session) -
    always the platform-default Dhan credential (credentials=None), since
    this is a background job with no caller to attribute a BYO credential
    to, unlike GET /options/sentiment itself. Same cadence as that route's
    own frontend pollers (5 minutes, see SentimentBadges.tsx/shell/
    index.html) - no value recording more often than the OI-change windows
    the score itself is computed over (5m/15m) actually shift.

    Skipping outside session hours (added so SentimentHistoryChart.tsx's
    day view isn't mostly off-hours error/stale-price noise - see
    docs/architecture.md's sentiment-history section) means a segment
    simply has no rows at all outside its own SEGMENT_SESSION_HOURS window,
    rather than rows with error='...' - the chart's x-axis is bounded to
    that same session window regardless, so this doesn't create a visible
    gap there, just avoids a wasted Dhan option-chain call and a noisy row
    for a market that isn't even open."""
    run = job_tracker.current()
    tally = {"ok": 0, "failed": 0}
    db = SessionLocal()
    try:
        now = datetime.now(ZoneInfo(settings.timezone))
        for exchange, symbols in SENTIMENT_UNDERLYINGS.items():
            if not is_within_session(exchange, now):
                continue
            for symbol in symbols:
                sentiment, spot_price = fetch_underlying_sentiment(exchange, symbol)
                tally["failed" if sentiment.error else "ok"] += 1
                db.add(
                    SentimentHistory(
                        exchange=exchange,
                        symbol=symbol,
                        direction=sentiment.direction,
                        strength=sentiment.strength,
                        score_5m=sentiment.score_5m,
                        score_15m=sentiment.score_15m,
                        spot_price=spot_price,
                        atm_call_buildup=sentiment.atm_call_buildup,
                        atm_put_buildup=sentiment.atm_put_buildup,
                        error=sentiment.error,
                    )
                )
        db.commit()
        if not tally["ok"] and not tally["failed"]:
            run.skip("no market in session")
        run.tick(tally["ok"] + tally["failed"], tally)
    except Exception as exc:
        logger.exception("scheduled sentiment history recording failed")
        db.rollback()
        run.fail(f"{type(exc).__name__}: {exc}"[:300])
    finally:
        db.close()


@tracked("oi-eod-snapshot-record", "OI buildup snapshot")
def _record_oi_eod_snapshot() -> None:
    """Writes one market_data.oi_eod_snapshot row per NSE F&O stock
    (DhanProvider.list_fno_stock_underlyings - ~150-200 symbols, NOT
    SENTIMENT_UNDERLYINGS' fixed 6) once per trading day, shortly after
    close - the EOD OI-buildup screener's whole reason for existing: Dhan's
    option-chain API has no historical-OI endpoint at all, so this table
    IS the history, one snapshot at a time going forward (see
    app/domain/oi_buildup.py's own module docstring).

    Skips weekends outright (no trading-calendar/holiday concept anywhere
    in this codebase, same gap SEGMENT_SESSION_HOURS's own docstring
    already notes - a real market holiday still runs and just produces
    whatever Dhan's chain endpoint happens to return for a closed market,
    same degrade-per-symbol handling as any other transient failure).

    One symbol's fetch failing (bad/missing expiry, a throttled-queue
    RuntimeError, ...) is skipped and rolled back individually - never
    fatal to the rest of this ~150-200-symbol batch, same "best effort per
    symbol" convention as signal-engine's weekly_advisor batch scan.
    Commits per-symbol (not once at the end, unlike
    _record_sentiment_history's own 6-symbol batch) since this job's own
    Dhan-throttle waits stretch it to several minutes - a long-lived
    transaction holding that many rows uncommitted the whole time has
    nothing to gain and a crash mid-run would otherwise lose every row.

    Deliberately NOT also run once immediately on boot (unlike
    _record_sentiment_history/_sync_all below) - a ~150-200-symbol Dhan
    scan on every backend restart during dev iteration would be wasteful;
    missing today's snapshot just means it fills in at tomorrow's own
    scheduled run instead."""
    run = job_tracker.current()
    now = datetime.now(ZoneInfo(settings.timezone))
    if now.weekday() >= 5:
        logger.info("scheduled OI EOD snapshot: skipped, weekend")
        run.skip("weekend")
        return

    try:
        provider = get_provider("NSE")
        symbols = provider.list_fno_stock_underlyings()
    except Exception as exc:
        logger.exception("scheduled OI EOD snapshot: could not list NSE F&O stocks")
        run.fail(f"could not list NSE F&O stocks: {type(exc).__name__}: {exc}"[:300])
        return

    # Every skip below used to be a bare `continue` with no log line, so a
    # run that wrote nothing left no trace at all. Tally each outcome and
    # log one summary at the end (see _log_eod_summary).
    if not symbols:
        logger.warning(
            "scheduled OI EOD snapshot: 0 NSE F&O stocks listed (instrument master not loaded?) - nothing to do"
        )
        run.fail("0 NSE F&O stocks listed (instrument master not loaded?)")
        return
    logger.info("scheduled OI EOD snapshot: starting, %d symbols", len(symbols))
    tally = {"written": 0, "unresolved": 0, "no_expiry": 0, "no_chain": 0, "failed": 0}
    run.set_total(len(symbols))

    today = now.date()
    db = SessionLocal()
    try:
        for i, symbol in enumerate(symbols):
            run.tick(i, tally)
            try:
                resolved = provider.resolve_underlying(symbol)
                if resolved is None:
                    tally["unresolved"] += 1
                    continue
                expiries = _retry_when_throttled(provider.get_expiry_list, resolved.chart_symbol)
                if not expiries:
                    tally["no_expiry"] += 1
                    continue
                expiry = sorted(expiries)[0]  # nearest - same convention as sentiment_fetch.py
                chain = _retry_when_throttled(provider.get_option_chain, resolved.chart_symbol, expiry)
                if chain is None:
                    tally["no_chain"] += 1
                    continue

                total_call_oi = sum(row.ce.oi for row in chain.strikes if row.ce is not None)
                total_put_oi = sum(row.pe.oi for row in chain.strikes if row.pe is not None)
                spot_price = chain.underlying_last_price
                pcr = (total_put_oi / total_call_oi) if total_call_oi > 0 else None

                prev_row = (
                    db.query(OiEodSnapshot)
                    .filter(OiEodSnapshot.symbol == symbol, OiEodSnapshot.snapshot_date < today)
                    .order_by(OiEodSnapshot.snapshot_date.desc())
                    .first()
                )
                previous = (
                    PreviousSnapshot(prev_row.total_call_oi, prev_row.total_put_oi, prev_row.spot_price)
                    if prev_row is not None
                    else None
                )
                result = compute_eod_buildup(total_call_oi, total_put_oi, spot_price, previous)

                # A re-run on the SAME day (e.g. a manual retrigger after an
                # earlier partial failure) updates today's own row in place
                # rather than violating the (symbol, snapshot_date) unique
                # constraint.
                row = (
                    db.query(OiEodSnapshot)
                    .filter(OiEodSnapshot.symbol == symbol, OiEodSnapshot.snapshot_date == today)
                    .first()
                )
                if row is None:
                    row = OiEodSnapshot(symbol=symbol, exchange="NSE", snapshot_date=today)
                    db.add(row)
                row.spot_price = spot_price
                row.total_call_oi = total_call_oi
                row.total_put_oi = total_put_oi
                row.pcr = pcr
                row.call_oi_change_pct = result.call_oi_change_pct
                row.put_oi_change_pct = result.put_oi_change_pct
                row.price_change_pct = result.price_change_pct
                row.call_buildup = result.call_buildup
                row.put_buildup = result.put_buildup
                db.commit()
                tally["written"] += 1
            except Exception:
                tally["failed"] += 1
                logger.exception("scheduled OI EOD snapshot failed for %s", symbol)
                db.rollback()
    finally:
        db.close()
    run.tick(len(symbols), tally)
    _log_eod_summary("OI EOD snapshot", len(symbols), tally)
    # The scan is complete, so the day's strong-buildup digest can go out. Only when most of the universe was read: after a
    # run that mostly failed (Dhan down) the list would be missing most stocks and misleading. Never fails the job.
    if tally["written"] >= max(1, len(symbols) // 2):
        try:
            from app.domain.notification_jobs import send_oi_digest

            sent = send_oi_digest()
            logger.info("scheduled OI EOD snapshot: digest sent=%d failed=%d already_sent=%d", sent.sent, sent.failed, sent.skipped)
        except Exception:
            logger.exception("scheduled OI EOD snapshot: the digest could not be sent")
    else:
        logger.warning("scheduled OI EOD snapshot: only %d of %d stocks written - the digest was not sent", tally["written"], len(symbols))


_INCREMENTAL_MIN_STORED_BARS = 200
_INCREMENTAL_MAX_GAP_DAYS = 10
_INCREMENTAL_OVERLAP_DAYS = 3
# How much daily history is kept per stock: about a year for every NSE equity (the screener's 52-week read needs 252 bars), about three years for the
# F&O stocks, so the zone scan's weekly structure has ~150 weekly bars to read instead of ~50 (app/domain/zone_scan.py). The longer window is only ~210
# stocks; keeping it for all ~2,700 would roughly triple the table for nothing.
_RETENTION_DAYS = 380
_RETENTION_DAYS_FNO = 1100
# An F&O stock whose stored bars do not reach back this close to its window start is fetched in full (a one-off backfill for the stocks that had only a
# year stored before the window grew; a stock listed less than three years ago is simply fetched in full each day, which is a handful of stocks).
_COVERS_WINDOW_SLACK_DAYS = 45


def _plan_daily_fetch(stored_dates: list[date], today: date, window_start: date, is_fno: bool, full_refresh: bool) -> tuple[bool, date]:
    """(incremental, fetch_from) for one stock in the screener job. Incremental - fetch only the days since the last stored bar, plus a few days'
    overlap - when the stored bars are enough (200+), recent (within 10 days) and, for an F&O stock, reach back to the start of its longer window.
    Anything else is a full fetch of the window: a new or thin symbol, a stale cache, an F&O stock still being backfilled to three years, and every
    stock on the Monday refresh (which also picks up split and bonus adjustments to old bars). `stored_dates` is oldest-first."""
    if (
        not full_refresh
        and len(stored_dates) >= _INCREMENTAL_MIN_STORED_BARS
        and (today - stored_dates[-1]).days <= _INCREMENTAL_MAX_GAP_DAYS
        and (not is_fno or stored_dates[0] <= window_start + timedelta(days=_COVERS_WINDOW_SLACK_DAYS))
    ):
        return True, stored_dates[-1] - timedelta(days=_INCREMENTAL_OVERLAP_DAYS)
    return False, window_start


@tracked("equity-screener-snapshot-record", "Equity screener snapshot")
def _record_equity_screener_snapshot() -> None:
    """Writes one market_data.equity_screener_snapshot row per NSE equity
    (DhanProvider.list_nse_equities - ALL ~2000 listed equities, wider
    than the OI job's ~210 F&O-only stocks) once per trading day. Unlike
    _record_oi_eod_snapshot, this fetches a full trailing window (~1
    calendar year) of REAL daily bars from Dhan's own charts/historical
    endpoint every time - see app/domain/equity_screener.py's own module
    docstring for why that endpoint itself is the history store here, so
    there's no day-over-day diffing against our own previous row the way
    the OI job needs.

    Same per-symbol best-effort resilience as _record_oi_eod_snapshot
    (one symbol's fetch failing never aborts the rest of the ~2000-symbol
    batch, commits per-symbol not once at the end) - see that function's
    own docstring for the full reasoning, which applies here unchanged.
    Also NOT run once immediately on boot, same reasoning.

    Also tags each row with is_fno/index_memberships (DhanProvider.
    list_fno_stock_underlyings + nse_indices' synced constituent lists -
    both already-cached lookups, built once here rather than per symbol)
    and upserts the SAME already-fetched candles into equity_daily_bar,
    a rolling raw-OHLCV cache - see app/adapters/db/models.py's
    EquityDailyBar for why the (upcoming) custom screener needs raw bars,
    not only more derived columns. Append-only per symbol (only bar_dates
    past whatever is already stored are inserted - a full day's ~2000
    symbols only ever add ~2000 new rows, not re-write the whole window),
    then prunes anything older than the symbol's own window below (about a year; about three for F&O stocks - see _RETENTION_DAYS_FNO)."""
    run = job_tracker.current()
    now = datetime.now(ZoneInfo(settings.timezone))
    if now.weekday() >= 5:
        run.skip("weekend")
        return

    try:
        provider = get_provider("NSE")
        symbols = provider.list_nse_equities()
    except Exception as exc:
        logger.exception("scheduled equity screener snapshot: could not list NSE equities")
        run.fail(f"could not list NSE equities: {type(exc).__name__}: {exc}"[:300])
        return

    try:
        fno_symbols = set(provider.list_fno_stock_underlyings())
    except Exception:
        logger.exception("scheduled equity screener snapshot: could not list F&O underlyings - is_fno left false for this run")
        fno_symbols = set()
    # symbol -> the index keys (NIFTY50, NIFTY100, ...) it belongs to, inverted
    # once from nse_indices' own per-index constituent lists rather than a
    # per-symbol lookup across every known index.
    symbol_indices: dict[str, list[str]] = {}
    for key in nse_indices.list_universes():
        for symbol in nse_indices.get_constituents(key) or []:
            symbol_indices.setdefault(symbol, []).append(key)

    today = now.date()
    # ~380 calendar days comfortably covers 252 TRADING days (the 52-week
    # window equity_screener.py needs) even across weekends/holidays - also
    # equity_daily_bar's own retention window, pruned to the same cutoff below.
    from_date = today - timedelta(days=_RETENTION_DAYS)
    from_date_fno = today - timedelta(days=_RETENTION_DAYS_FNO)
    full_refresh = today.weekday() == 0
    tally = {"written": 0, "too_little_history": 0, "failed": 0}
    run.set_total(len(symbols))
    db = SessionLocal()
    try:
        for i, symbol in enumerate(symbols):
            run.tick(i, tally)
            try:
                # Incremental: bars already in equity_daily_bar are not re-downloaded. Only the
                # days since the last stored bar (plus a few days' overlap) are fetched, and the
                # screener row is computed from stored + new bars. A symbol with no/short stored
                # history, a stale cache, or the weekly Monday refresh (picks up split/bonus
                # adjustments to old bars) does the full-window fetch instead.
                sym_from = from_date_fno if symbol in fno_symbols else from_date
                stored = (
                    db.query(EquityDailyBar)
                    .filter(EquityDailyBar.symbol == symbol, EquityDailyBar.bar_date >= sym_from)
                    .order_by(EquityDailyBar.bar_date.asc())
                    .all()
                )
                existing_max = stored[-1].bar_date if stored else None
                incremental, fetch_from = _plan_daily_fetch([b.bar_date for b in stored], today, sym_from, symbol in fno_symbols, full_refresh)
                fetched = _retry_when_throttled(provider.get_candle_history, symbol, "daily", fetch_from, today)
                if incremental:
                    stored_candles = [
                        Candle(exchange=b.exchange, symbol=b.symbol, interval="daily", open=b.open, high=b.high, low=b.low, close=b.close, volume=b.volume, timestamp=f"{b.bar_date.isoformat()}T00:00:00", provider="cache")
                        for b in stored
                    ]
                    candles = stored_candles + [c for c in fetched if date.fromisoformat(c.timestamp[:10]) > existing_max]
                else:
                    candles = fetched

                # Cache the raw bars regardless of whether there's enough history for the
                # regime/ADX read below - a symbol too young/thin for a real ADX read can
                # still have perfectly good bars for the custom screener to evaluate a
                # short-lookback expression against (or none at all yet, which is a
                # correct, informative absence - not a reason to skip caching what DOES
                # exist). Must run BEFORE the `result is None: continue` below, not after -
                # a thin symbol would otherwise never get cached at all.
                if not incremental and stored:
                    # Replace, not append: a full fetch covers the whole window again, and adjusted history (a split, a bonus) differs from what
                    # was stored; appending only bars newer than the stored maximum would also skip the older ones a backfill fetched.
                    db.query(EquityDailyBar).filter(EquityDailyBar.symbol == symbol).delete()
                    existing_max = None
                for c in fetched:
                    bar_date = date.fromisoformat(c.timestamp[:10])
                    if existing_max is not None and bar_date <= existing_max:
                        continue
                    db.add(EquityDailyBar(symbol=symbol, exchange=c.exchange, bar_date=bar_date, open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume))
                db.query(EquityDailyBar).filter(EquityDailyBar.symbol == symbol, EquityDailyBar.bar_date < sym_from).delete()

                result = compute_equity_screener_row(candles)
                if result is None:
                    db.commit()  # the bar cache above still needs to be saved even with nothing else to write
                    tally["too_little_history"] += 1
                    continue  # not enough history yet - see equity_screener.py's own MIN_BARS floor

                row = (
                    db.query(EquityScreenerSnapshot)
                    .filter(EquityScreenerSnapshot.symbol == symbol, EquityScreenerSnapshot.snapshot_date == today)
                    .first()
                )
                if row is None:
                    row = EquityScreenerSnapshot(symbol=symbol, exchange="NSE", snapshot_date=today)
                    db.add(row)
                row.close = result.close
                row.pct_change_5d = result.pct_change_5d
                row.pct_change_20d = result.pct_change_20d
                row.adx = result.adx
                row.regime = result.regime
                row.high_52w = result.high_52w
                row.low_52w = result.low_52w
                row.pct_from_52w_high = result.pct_from_52w_high
                row.pct_from_52w_low = result.pct_from_52w_low
                row.proximity = result.proximity
                row.is_fno = symbol in fno_symbols
                for field in ("avg_turnover_cr", "ret_3m_pct", "mom_12_1_pct", "rsi3", "dist_ema20_pct", "atr_pct", "vol_ratio"):
                    setattr(row, field, getattr(result, field))
                row.index_memberships = ",".join(sorted(symbol_indices.get(symbol, []))) or None

                db.commit()
                tally["written"] += 1
            except Exception:
                tally["failed"] += 1
                logger.exception("scheduled equity screener snapshot failed for %s", symbol)
                db.rollback()
    finally:
        db.close()
    run.tick(len(symbols), tally)
    _log_eod_summary("equity screener snapshot", len(symbols), tally)


@tracked("zone-scan-record", "Zone scan")
def _record_zone_scan() -> None:
    """Writes one market_data.zone_scan row per NSE F&O stock for today: the daily and weekly market structure, whether price is at (or
    approaching) an untested demand or supply zone, and the tier that gives it once the day's open-interest labels are laid against it - see
    app/domain/zone_scan.py for what each means. It only READS what the other two end-of-day jobs have already stored (equity_daily_bar from the
    screener, oi_eod_snapshot from the OI job), so it makes no provider calls and a whole run takes seconds. It therefore has to run after them
    (settings.zone_scan_hour/minute), and skips rather than writing yesterday's bars under today's date when the screener has not got there.
    Idempotent: a re-run replaces the day's rows."""
    run = job_tracker.current()
    now = datetime.now(ZoneInfo(settings.timezone))
    if now.weekday() >= 5:
        run.skip("weekend")
        return
    today = now.date()
    tally = {"written": 0, "too_little_history": 0, "at_zone": 0, "failed": 0}
    db = SessionLocal()
    try:
        latest = db.query(func.max(EquityScreenerSnapshot.snapshot_date)).filter(EquityScreenerSnapshot.is_fno.is_(True)).scalar()
        if latest is None:
            run.fail("no F&O stocks in the screener snapshot yet")
            return
        symbols = [r[0] for r in db.query(EquityScreenerSnapshot.symbol).filter(EquityScreenerSnapshot.is_fno.is_(True), EquityScreenerSnapshot.snapshot_date == latest)]
        newest = db.query(func.max(EquityDailyBar.bar_date)).filter(EquityDailyBar.symbol.in_(symbols)).scalar()
        if newest is None or newest < today:
            run.skip(f"no daily bar for {today} yet (the screener has not stored it, or the market was shut); newest stored bar is {newest}")
            return
        bars: dict[str, list[Candle]] = {}
        for b in db.query(EquityDailyBar).filter(EquityDailyBar.symbol.in_(symbols)).order_by(EquityDailyBar.symbol.asc(), EquityDailyBar.bar_date.asc()):
            bars.setdefault(b.symbol, []).append(
                Candle(exchange=b.exchange, symbol=b.symbol, interval="daily", open=b.open, high=b.high, low=b.low, close=b.close, volume=b.volume, timestamp=f"{b.bar_date.isoformat()}T00:00:00", provider="cache")
            )
        labels = {s: (c, p) for s, c, p in db.query(OiEodSnapshot.symbol, OiEodSnapshot.call_buildup, OiEodSnapshot.put_buildup).filter(OiEodSnapshot.snapshot_date == today)}
        run.set_total(len(symbols))
        for i, symbol in enumerate(symbols):
            run.tick(i, tally)
            try:
                candles = bars.get(symbol, [])
                if not candles or date.fromisoformat(candles[-1].timestamp[:10]) < today:
                    continue  # no bar for today: a halted or newly suspended stock, left out rather than read off a stale series
                read = read_zones(candles)
                if read is None:
                    tally["too_little_history"] += 1
                    continue
                call_label, put_label = labels.get(symbol, (None, None))
                tier, agrees = tier_for(read, call_label, put_label)
                row = db.query(ZoneScan).filter(ZoneScan.symbol == symbol, ZoneScan.snapshot_date == today).first()
                if row is None:
                    row = ZoneScan(symbol=symbol, exchange="NSE", snapshot_date=today)
                    db.add(row)
                row.close, row.daily_trend, row.weekly_trend, row.weekly_bars = read.close, read.daily_trend, read.weekly_trend, read.weekly_bars
                row.zone_kind, row.zone_proximal, row.zone_distal, row.zone_position = read.zone_kind, read.zone_proximal, read.zone_distal, read.zone_position
                row.zone_distance_pct, row.zone_distance_atr = read.zone_distance_pct, read.zone_distance_atr
                row.weekly_zone, row.weekly_agrees = read.weekly_zone, read.weekly_agrees
                row.call_buildup, row.put_buildup, row.oi_agrees, row.tier = call_label, put_label, agrees, tier
                db.commit()
                tally["written"] += 1
                if tier:
                    tally["at_zone"] += 1
            except Exception:
                tally["failed"] += 1
                logger.exception("zone scan failed for %s", symbol)
                db.rollback()
    finally:
        db.close()
    run.tick(len(symbols), tally)
    _log_eod_summary("zone scan", len(symbols), tally)


@tracked("premarket-report-record", "Pre-market bias report")
def _record_premarket_report() -> None:
    """Builds today's pre-market bias report (app/domain/premarket_report.py) on the platform OpenRouter key and stores it.
    Weekdays only (a cron day_of_week), so no weekend row; a market holiday still produces one, which is harmless. A run
    where nothing could be fetched is recorded as failed rather than storing an empty report."""
    from app.domain.premarket_report import build_report, save_report, today_ist

    run = job_tracker.current()
    report = build_report(settings.openrouter_api_key or None, read_new_rbi=True)
    ok = sum(1 for i in report["inputs"] if i["ok"])
    run.set_total(len(report["inputs"]))
    run.tick(ok, {"ok": ok, "failed": len(report["inputs"]) - ok})
    if ok == 0:
        run.fail("no pre-market inputs could be fetched")
        return
    db = SessionLocal()
    try:
        save_report(db, today_ist(), report)
    finally:
        db.close()
    if report["ai_error"]:
        run.note(report["ai_error"])
    # Push it to everyone subscribed (each with their own chat, once a day). Never fails the job.
    try:
        from app.domain.notification_jobs import send_premarket

        sent = send_premarket(report)
        logger.info("pre-market report: push sent=%d failed=%d already_sent=%d", sent.sent, sent.failed, sent.skipped)
    except Exception:
        logger.exception("pre-market report: the push could not be sent")


@tracked("session-summary-nse", "Post-session summary: NSE")
def _send_session_summary_nse() -> None:
    from app.domain.notification_jobs import send_session_summary

    run = job_tracker.current()
    sent = send_session_summary("NSE", datetime.now(ZoneInfo(settings.timezone)).date())
    run.tick(1, {"sent": sent.sent, "failed": sent.failed, "already_sent": sent.skipped})
    logger.info("NSE session summary: sent=%d failed=%d already_sent=%d", sent.sent, sent.failed, sent.skipped)


@tracked("session-summary-mcx", "Post-session summary: MCX")
def _send_session_summary_mcx() -> None:
    from app.domain.notification_jobs import send_session_summary

    run = job_tracker.current()
    sent = send_session_summary("MCX", datetime.now(ZoneInfo(settings.timezone)).date())
    run.tick(1, {"sent": sent.sent, "failed": sent.failed, "already_sent": sent.skipped})
    logger.info("MCX session summary: sent=%d failed=%d already_sent=%d", sent.sent, sent.failed, sent.skipped)


@tracked("session-summary-crypto", "Post-session summary: crypto")
def _send_session_summary_crypto() -> None:
    from app.domain.notification_jobs import send_session_summary

    run = job_tracker.current()
    sent = send_session_summary("CRYPTO")
    run.tick(1, {"sent": sent.sent, "failed": sent.failed, "already_sent": sent.skipped})
    logger.info("crypto summary: sent=%d failed=%d already_sent=%d", sent.sent, sent.failed, sent.skipped)


def _notification_retry() -> None:
    """Re-send notifications whose first attempt failed (see app/domain/notifications.py). Not tracked in the job log: it runs every
    few minutes and almost always has nothing to do."""
    from app.domain.notification_jobs import retry_failed

    retry_failed()


def _notification_ops_check() -> None:
    """Tell the operator about an expired / expiring Dhan token or a failed background job, once each."""
    from app.domain.notification_jobs import check_ops

    check_ops()


def _check_price_alerts() -> None:
    """Evaluate every active market_data.price_alerts row against a fresh
    LTP and push the ones that just crossed to Telegram - see
    app/domain/price_alerts.py."""
    from app.domain.price_alerts import dispatch_due

    db = SessionLocal()
    try:
        dispatch_due(db)
    except Exception:
        logger.exception("scheduled price-alert check failed")
        db.rollback()
    finally:
        db.close()


def _check_zone_live() -> None:
    """The price against every zone armed on a chart (app/domain/zone_watch.py): announce a touch at once."""
    from app.domain.zone_watch import check_live

    db = SessionLocal()
    try:
        check_live(db)
    except Exception:
        logger.exception("scheduled zone check failed")
        db.rollback()
    finally:
        db.close()


def _check_zone_bars() -> None:
    """The candles that closed since each zone was armed: a touch the live check missed (a wick) and how each touching candle closed."""
    from app.domain.zone_watch import check_bars

    db = SessionLocal()
    try:
        check_bars(db)
    except Exception:
        logger.exception("scheduled zone candle check failed")
        db.rollback()
    finally:
        db.close()


@tracked("zones-morning", "Your zones today")
def _send_zones_morning() -> None:
    from app.domain.zone_watch import send_morning

    run = job_tracker.current()
    db = SessionLocal()
    try:
        sent = send_morning(db, datetime.now(ZoneInfo(settings.timezone)).date())
    finally:
        db.close()
    run.tick(1, {"sent": sent.sent, "failed": sent.failed, "skipped": sent.skipped})
    logger.info("zones morning list: sent=%d failed=%d skipped=%d", sent.sent, sent.failed, sent.skipped)


def job_catalog() -> list[dict]:
    """The jobs worth tracking, in the order they are shown: what each is, when it is due, and what is next. The price-alert
    check (every few seconds) is deliberately absent: a run row per poll would bury the rest."""
    s = settings
    jobs = [
        ("oi-eod-snapshot-record", "OI buildup snapshot", f"Weekdays {s.oi_eod_snapshot_hour:02d}:{s.oi_eod_snapshot_minute:02d}", "Stores each F&O stock's total call and put open interest for the day, which the OI buildup scan and its history read."),
        ("equity-screener-snapshot-record", "Equity screener snapshot", f"Weekdays {s.equity_screener_snapshot_hour:02d}:{s.equity_screener_snapshot_minute:02d}", "Fetches the new daily bars for every NSE stock (a full year only on Mondays or for a new stock) and stores the screener row, which the Screener and custom scans read."),
        ("zone-scan-record", "Zone scan", f"Weekdays {s.zone_scan_hour:02d}:{s.zone_scan_minute:02d}", "Reads each F&O stock's stored daily and weekly bars for an untested demand or supply zone at price, sets it against the day's open-interest read, and stores the tier for the OI scan page's At a zone filter."),
        ("session-summary-nse", "Post-session summary: NSE", f"Weekdays {s.session_summary_nse_hour:02d}:{s.session_summary_nse_minute:02d}", "Sends each subscriber how the NSE session went and their own closed trades that day."),
        ("session-summary-mcx", "Post-session summary: MCX", f"Weekdays {s.session_summary_mcx_hour:02d}:{s.session_summary_mcx_minute:02d}", "Sends each subscriber how gold, crude, silver and natural gas did and their own closed MCX trades that day."),
        ("session-summary-crypto", "Post-session summary: crypto", f"Daily {s.session_summary_crypto_hour:02d}:{s.session_summary_crypto_minute:02d}", "Sends each subscriber the last 24 hours in BTC and ETH and their own crypto trades that day."),
        ("zones-morning", "Your zones today", f"Daily {s.zone_morning_hour:02d}:{s.zone_morning_minute:02d}", "Sends each person the zones and levels they have armed, with how far the price is from each."),
        ("premarket-report-record", "Pre-market bias report", f"Weekdays {s.premarket_report_hour:02d}:{s.premarket_report_minute:02d}", "Reads the overnight US close, crude, USDINR, yields, ADRs and GIFT Nifty and works out the day's likely market bias."),
        ("instrument-sync-daily", "Instrument master sync", f"Daily {s.instrument_sync_hour:02d}:{s.instrument_sync_minute:02d}, and at start-up", "Refreshes the broker's list of tradeable instruments and the NSE index memberships."),
        ("sentiment-history-record", "Sentiment recorder", f"Every {s.sentiment_history_interval_minutes} minutes while a market is open", "Records the option-chain sentiment badge for the main indices."),
    ]
    if s.dhan_token_renew_interval_hours > 0:
        jobs.append(("dhan-token-renew", "Dhan token renewal", f"Checked every 10 minutes: renews in the quiet window {s.dhan_renew_window_start}-{s.dhan_renew_window_end} IST (after MCX closes), once the token is {s.dhan_token_renew_interval_hours} hours old", "Extends the platform Dhan access token for another 24 hours, outside market hours, and not during a running scan unless the token has under 3 hours left."))
    out = []
    for job_id, label, schedule, what in jobs:
        scheduled = _scheduler.get_job(job_id)
        out.append({"job_id": job_id, "label": label, "schedule": schedule, "what": what, "next_run_at": getattr(scheduled, "next_run_time", None)})
    return out


def start_scheduler() -> None:
    # Where runs are recorded, and close out any run the last stop cut off.
    job_tracker.configure(job_tracker.DbStore(SessionLocal))
    job_tracker.mark_interrupted_on_start()
    _scheduler.add_job(
        _sync_all,
        CronTrigger(hour=settings.instrument_sync_hour, minute=settings.instrument_sync_minute, timezone=settings.timezone),
        id="instrument-sync-daily",
        replace_existing=True,
    )
    # dhan_token_renew_interval_hours=0 disables this entirely (both the
    # periodic job and the on-boot run below) - dev and test share one
    # physical Dhan account/token, so only one stack should ever renew it
    # automatically; the other would otherwise periodically invalidate
    # whichever token the first is currently using. See config.py/
    # docs/architecture.md.
    if settings.dhan_token_renew_interval_hours > 0:
        _scheduler.add_job(
            _renew_dhan_token,
            IntervalTrigger(minutes=10),
            id="dhan-token-renew",
            replace_existing=True,
        )
    # Always on (even with renewal off): adopt a token saved on the Settings page within minutes of it being saved.
    _scheduler.add_job(
        _sync_platform_dhan,
        IntervalTrigger(minutes=settings.platform_dhan_sync_minutes),
        id="dhan-token-sync",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.add_job(
        _record_sentiment_history,
        # CronTrigger, not IntervalTrigger - an interval trigger's phase is
        # whatever moment this job happened to be added (i.e. whenever the
        # backend last started), so rows land on an arbitrary offset like
        # :02/:07/:12 instead of a clean :00/:05/:10 - which the OI strip's
        # sparklines (LiveChartPanel.tsx's sentimentSteps) then have to
        # round down to display cleanly. Recording ON that boundary instead
        # means every row already falls on one, no rounding needed downstream.
        CronTrigger(minute=f"*/{settings.sentiment_history_interval_minutes}", timezone=settings.timezone),
        id="sentiment-history-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _record_oi_eod_snapshot,
        CronTrigger(day_of_week="mon-fri", hour=settings.oi_eod_snapshot_hour, minute=settings.oi_eod_snapshot_minute, timezone=settings.timezone),
        id="oi-eod-snapshot-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _record_equity_screener_snapshot,
        CronTrigger(day_of_week="mon-fri", hour=settings.equity_screener_snapshot_hour, minute=settings.equity_screener_snapshot_minute, timezone=settings.timezone),
        id="equity-screener-snapshot-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _record_zone_scan,
        CronTrigger(day_of_week="mon-fri", hour=settings.zone_scan_hour, minute=settings.zone_scan_minute, timezone=settings.timezone),
        id="zone-scan-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _record_premarket_report,
        # timezone= is required: a CronTrigger passed in ready-made ignores the scheduler's own, so without it this
        # would fire at 08:45 in the container's UTC (14:15 IST) - see docs/architecture.md "Background-job run log".
        CronTrigger(day_of_week="mon-fri", hour=settings.premarket_report_hour, minute=settings.premarket_report_minute, timezone=settings.timezone),
        id="premarket-report-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _send_session_summary_nse,
        CronTrigger(day_of_week="mon-fri", hour=settings.session_summary_nse_hour, minute=settings.session_summary_nse_minute, timezone=settings.timezone),
        id="session-summary-nse", replace_existing=True, max_instances=1, coalesce=True,
    )
    _scheduler.add_job(
        _send_session_summary_mcx,
        CronTrigger(day_of_week="mon-fri", hour=settings.session_summary_mcx_hour, minute=settings.session_summary_mcx_minute, timezone=settings.timezone),
        id="session-summary-mcx", replace_existing=True, max_instances=1, coalesce=True,
    )
    _scheduler.add_job(
        _send_session_summary_crypto,
        CronTrigger(hour=settings.session_summary_crypto_hour, minute=settings.session_summary_crypto_minute, timezone=settings.timezone),
        id="session-summary-crypto", replace_existing=True, max_instances=1, coalesce=True,
    )
    _scheduler.add_job(_notification_retry, IntervalTrigger(minutes=5), id="notification-retry", replace_existing=True, max_instances=1, coalesce=True)
    _scheduler.add_job(_notification_ops_check, IntervalTrigger(minutes=10), id="notification-ops-check", replace_existing=True, max_instances=1, coalesce=True)
    _scheduler.add_job(_check_zone_live, IntervalTrigger(seconds=settings.zone_watch_check_interval_seconds), id="zone-watch-live", replace_existing=True, max_instances=1, coalesce=True)
    _scheduler.add_job(_check_zone_bars, IntervalTrigger(seconds=60), id="zone-watch-bars", replace_existing=True, max_instances=1, coalesce=True)
    _scheduler.add_job(
        _send_zones_morning,
        CronTrigger(hour=settings.zone_morning_hour, minute=settings.zone_morning_minute, timezone=settings.timezone),
        id="zones-morning", replace_existing=True, max_instances=1, coalesce=True,
    )
    _scheduler.add_job(
        _check_price_alerts,
        IntervalTrigger(seconds=settings.price_alert_check_interval_seconds),
        id="price-alert-check",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    # Run once immediately in the background so quotes work without
    # waiting for the next scheduled run (e.g. right after a restart).
    _scheduler.add_job(_sync_platform_dhan, id="dhan-token-sync-initial", replace_existing=True)
    _scheduler.add_job(_sync_all, id="instrument-sync-initial", replace_existing=True)
    _scheduler.add_job(_record_sentiment_history, id="sentiment-history-record-initial", replace_existing=True)
    if settings.dhan_token_renew_interval_hours > 0:
        # Same reasoning - extends the .env-seeded token's life right away
        # instead of waiting a full dhan_token_renew_interval_hours, minimizing
        # the window where a soon-to-expire seed token could lapse first.
        _scheduler.add_job(_renew_dhan_token, id="dhan-token-renew-initial", replace_existing=True)
