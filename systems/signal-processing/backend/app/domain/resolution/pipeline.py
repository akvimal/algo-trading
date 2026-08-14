from datetime import datetime, time
from zoneinfo import ZoneInfo

from app.adapters.strategies.client import fetch_strategy
from app.domain.models import ResolvedOrderDraft, SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.strategy import choose_strategy

_TZ = "Asia/Kolkata"  # NSE-only platform end-to-end today - see execution.settings.timezone's own default.


def is_within_active_window(ts: datetime, active_from_time: str, active_to_time: str) -> bool:
    """Pure, directly unit-testable - mirrors execution's own
    is_within_intraday_window (app/domain/position_manager.py there).
    `ts` is the signal's own timestamp (when it actually fired), not
    wall-clock time at resolution - see resolve()'s docstring."""
    local_time = ts.astimezone(ZoneInfo(_TZ)).time()
    return time.fromisoformat(active_from_time) <= local_time <= time.fromisoformat(active_to_time)


def resolve(signal: SignalIngest) -> ResolvedOrderDraft:
    """horizon/instrument_type come from the signal's Strategy
    (signal-generation), not from guessing - see docs/architecture.md.
    Position size is deliberately not decided here - execution computes
    its own quantity from capital_per_trade and the signal's price.
    Raises ResolutionError if the strategy is unknown, unreachable, not
    live, or the signal arrived outside the strategy's optional active
    window (active_from_time/active_to_time - every source_type, not just
    in_house); the caller persists that as a rejected order and does not
    publish to the Redis stream. Manual test signals (source="manual" -
    the frontend's "Send test signal"/Manual tab) are exempt from the
    live-status check only, so a strategy can be exercised end-to-end
    before being promoted to live - every other source (chartink,
    in_house) still requires it."""
    strategy = fetch_strategy(signal.strategy_id)

    if strategy["status"] != "live" and signal.source != "manual":
        raise ResolutionError(f"strategy is not live (status={strategy['status']})")

    active_from = strategy.get("active_from_time")
    active_to = strategy.get("active_to_time")
    if active_from and active_to:
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
        if not is_within_active_window(signal.timestamp, active_from, active_to):
            raise ResolutionError(f"signal received outside strategy's active window ({active_from}–{active_to} IST)")

    horizon = strategy["horizon"]
    instrument_type = strategy["instrument_type"]

    option_strategy = choose_strategy(
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
        target_percent=strategy.get("target_percent"),
        trailing_stop_enabled=strategy.get("trailing_stop_enabled", False),
        duplicate_signal_policy=strategy.get("duplicate_signal_policy", "skip"),
        counter_signal_policy=strategy.get("counter_signal_policy", "close_and_flip"),
        # instrument_type='option' only - None for spot/future, mirrors how
        # `strategy` (the legs dict) itself is None for non-option orders.
        # NOT passed into choose_strategy - it only affects how execution
        # monitors/closes an already-resolved group, not which legs get built.
        option_sl_scope=strategy.get("option_sl_scope", "combined") if instrument_type == "option" else None,
        # instrument_type='option' only - takes precedence over stop-loss-
        # based sizing entirely in execution when set. See
        # docs/contracts/resolved-order.schema.json.
        option_fixed_lots=strategy.get("option_fixed_lots") if instrument_type == "option" else None,
    )
