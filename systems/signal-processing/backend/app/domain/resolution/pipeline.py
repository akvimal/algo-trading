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
    publish to the Redis stream."""
    strategy = fetch_strategy(signal.strategy_id)

    if strategy["status"] != "live":
        raise ResolutionError(f"strategy is not live (status={strategy['status']})")

    active_from = strategy.get("active_from_time")
    active_to = strategy.get("active_to_time")
    if active_from and active_to and not is_within_active_window(signal.timestamp, active_from, active_to):
        raise ResolutionError(f"signal received outside strategy's active window ({active_from}–{active_to} IST)")

    horizon = strategy["horizon"]
    instrument_type = strategy["instrument_type"]

    option_strategy = choose_strategy(
        signal,
        horizon,
        instrument_type,
        strategy.get("option_position_style", "spread"),
        strategy.get("option_strike_moneyness", "ATM"),
    )

    square_off_time = strategy.get("square_off_time")
    if square_off_time and active_to:
        # active_to_time also bounds how long a position this strategy
        # opens can stay open - take the earlier of the two so execution's
        # existing square-off machinery (open_position's late-entry
        # rejection, square_off_due_positions' periodic close) enforces it
        # with no execution-side changes at all. Never pushes square-off
        # *later* than the strategy's own configured value.
        square_off_time = min(time.fromisoformat(square_off_time), time.fromisoformat(active_to))

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
        square_off_time=square_off_time,
        duplicate_signal_policy=strategy.get("duplicate_signal_policy", "add_position"),
        counter_signal_policy=strategy.get("counter_signal_policy", "skip"),
    )
