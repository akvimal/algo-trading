from datetime import datetime, time
from typing import Callable
from zoneinfo import ZoneInfo

from app.domain.processing.models import ResolvedOrderDraft, SignalIngest
from app.domain.processing.resolution.errors import ResolutionError
from app.domain.processing.resolution.option_strategy import choose_option_strategy

_TZ = "Asia/Kolkata"  # NSE-only platform end-to-end today - see execution.settings.timezone's own default.

# Mon-Sun abbreviations, ISO order (Monday first) - matches Python's own
# date.weekday() convention (0=Monday...6=Sunday), mirrors signal-generation's
# identical WEEKDAY_NAMES (app/domain/models.py there) - duplicated, not
# imported, since systems/* are self-contained (see docs/architecture.md).
_WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def is_within_active_window(ts: datetime, active_windows: list[dict]) -> bool:
    """Pure, directly unit-testable - mirrors execution's own
    is_within_intraday_window (app/domain/position_manager.py there).
    `ts` is the signal's own timestamp (when it actually fired), not
    wall-clock time at resolution - see resolve()'s docstring. True if
    `local_time` falls within ANY one of active_windows (each a
    {"start": "HH:MM:SS", "end": "HH:MM:SS"} dict, straight from the
    Strategy's own JSON response) - multiple windows may overlap,
    harmlessly. Caller (resolve() below) already skips this entirely
    when active_windows is empty, so this is never called with one."""
    local_time = ts.astimezone(ZoneInfo(_TZ)).time()
    return any(time.fromisoformat(w["start"]) <= local_time <= time.fromisoformat(w["end"]) for w in active_windows)


def matches_active_weekday(ts: datetime, active_weekdays: list[str]) -> bool:
    """Pure, directly unit-testable - same shape as is_within_active_window
    above, for the day-of-week filter instead of time-of-day. `ts` is the
    signal's own timestamp, not wall-clock time at resolution. True if
    today's (in IST) weekday name is in active_weekdays (e.g.
    ["Mon","Tue","Wed","Thu","Fri"]). Caller (resolve() below) already
    skips this entirely when active_weekdays is empty, so this is never
    called with one."""
    local_date = ts.astimezone(ZoneInfo(_TZ)).date()
    return _WEEKDAY_NAMES[local_date.weekday()] in active_weekdays


def resolve(signal: SignalIngest, fetch_strategy: Callable[[str], dict]) -> ResolvedOrderDraft:
    """horizon/instrument_type come from the signal's Strategy, not from
    guessing - see docs/architecture.md. Position size is deliberately not
    decided here - execution computes its own quantity from
    capital_per_trade and the signal's price. Raises ResolutionError if
    the strategy is unknown, not live, the signal arrived outside every
    one of the strategy's optional active_windows, or on a day outside its
    optional active_weekdays (both every source_type, not just in_house);
    the caller persists that as a rejected order and does not publish to
    the Redis stream. Manual test signals (source="manual" - the
    frontend's "Send test signal"/Manual tab) are exempt from the
    live-status check only, so a strategy can be exercised end-to-end
    before being promoted to live - every other source (chartink,
    in_house) still requires it.

    fetch_strategy is injected (rather than this module calling the DB or
    the generation_lookup module directly) so this stays a pure, DB-free
    function - exactly the same reasoning as execution's
    option_position_manager.py taking GetExpiryList/GetOptionChain as
    plain Callables. Since the signal-engine merge (2026-08-28), the real
    caller's fetch_strategy reads the Strategy/Rule rows directly
    in-process (app/domain/processing/resolution/generation_lookup.py) -
    there used to be a genuine "signal-generation unreachable" failure
    mode here, from an HTTP call to a separate service; that mode no
    longer exists now that it's a function call in the same process."""
    strategy = fetch_strategy(signal.strategy_id)

    if strategy["status"] != "live" and signal.source != "manual":
        raise ResolutionError(f"strategy is not live (status={strategy['status']})")

    active_windows = strategy.get("active_windows") or []
    if active_windows:
        # create_signal_from_ingest (the only production caller) always
        # normalizes signal.timestamp to a real value before calling
        # resolve() - this is defense-in-depth for any other caller, so a
        # missing timestamp degrades to the same clean ResolutionError
        # (persisted as a 'rejected' order, per this function's own
        # docstring) rather than an unhandled AttributeError 500 -
        # reproduced live 2026-08-14, the first time a Strategy ever had
        # both fields set (every earlier signal short-circuited this
        # branch entirely, since `and` is lazy).
        if signal.timestamp is None:
            raise ResolutionError("signal has no timestamp - cannot evaluate active window")
        if not is_within_active_window(signal.timestamp, active_windows):
            windows_desc = ", ".join(f"{w['start']}–{w['end']}" for w in active_windows)
            raise ResolutionError(f"signal received outside strategy's active window(s) ({windows_desc} IST)")

    active_weekdays = strategy.get("active_weekdays") or []
    if active_weekdays:
        if signal.timestamp is None:
            raise ResolutionError("signal has no timestamp - cannot evaluate active weekday")
        if not matches_active_weekday(signal.timestamp, active_weekdays):
            weekdays_desc = ", ".join(active_weekdays)
            raise ResolutionError(f"signal received on a day outside strategy's active weekday(s) ({weekdays_desc})")

    horizon = strategy["horizon"]
    instrument_type = strategy["instrument_type"]

    option_strategy = choose_option_strategy(
        signal,
        horizon,
        instrument_type,
        strategy.get("option_position_style", "spread"),
        strategy.get("option_strike_moneyness", "ATM"),
        strategy.get("contract_day_filter", "any"),
    )

    return ResolvedOrderDraft(
        horizon=horizon,
        instrument_type=instrument_type,
        segment=strategy["segment"],
        strategy=option_strategy,
        # Passed through unchanged from the resolved Strategy - execution
        # uses these to size/monitor the position, never calling
        # signal-generation directly. See docs/contracts/resolved-order.schema.json.
        stop_loss_method=strategy.get("stop_loss_method"),
        stop_loss_interval=strategy.get("stop_loss_interval"),
        stop_loss_percent=strategy.get("stop_loss_percent"),
        stop_loss_indicator_type=strategy.get("stop_loss_indicator_type"),
        stop_loss_indicator_params=strategy.get("stop_loss_indicator_params"),
        target_percent=strategy.get("target_percent"),
        trailing_stop_enabled=strategy.get("trailing_stop_enabled", False),
        duplicate_signal_policy=strategy.get("duplicate_signal_policy", "skip"),
        counter_signal_policy=strategy.get("counter_signal_policy", "close_and_flip"),
        # instrument_type='option' only - None for spot/future, mirrors how
        # `strategy` (the legs dict) itself is None for non-option orders.
        # NOT passed into choose_option_strategy - it only affects how execution
        # monitors/closes an already-resolved group, not which legs get built.
        option_sl_scope=strategy.get("option_sl_scope", "combined") if instrument_type == "option" else None,
        # Every instrument_type (renamed from option_fixed_lots, which used
        # to be options-only) - takes precedence over stop-loss-based
        # sizing entirely in execution when set. See
        # docs/contracts/resolved-order.schema.json.
        fixed_lots=strategy.get("fixed_lots"),
        # segment='NSE'+horizon='positional'+instrument_type='spot' only -
        # see docs/contracts/resolved-order.schema.json.
        use_margin=strategy.get("use_margin", False),
    )
