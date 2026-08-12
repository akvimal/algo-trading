from app.adapters.strategies.client import fetch_strategy
from app.domain.models import ResolvedOrderDraft, SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.strategy import choose_strategy


def resolve(signal: SignalIngest) -> ResolvedOrderDraft:
    """horizon/instrument_type come from the signal's Strategy
    (signal-generation), not from guessing - see docs/architecture.md.
    Position size is deliberately not decided here - execution computes
    its own quantity from capital_per_trade and the signal's price.
    Raises ResolutionError if the strategy is unknown, unreachable, or not
    live; the caller persists that as a rejected order and does not
    publish to the Redis stream."""
    strategy = fetch_strategy(signal.strategy_id)

    if strategy["status"] != "live":
        raise ResolutionError(f"strategy is not live (status={strategy['status']})")

    horizon = strategy["horizon"]
    instrument_type = strategy["instrument_type"]

    option_strategy = choose_strategy(signal, horizon, instrument_type)

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
        square_off_time=strategy.get("square_off_time"),
        duplicate_signal_policy=strategy.get("duplicate_signal_policy", "add_position"),
        counter_signal_policy=strategy.get("counter_signal_policy", "skip"),
    )
