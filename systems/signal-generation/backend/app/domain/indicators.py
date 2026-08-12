"""Pure indicator math - no I/O, no DB, so directly unit-testable and
reusable identically by the live engine and the backtest replay (see
rules.py, engine.py, backtest.py). closes/values are always oldest-first
(chronological)."""

from typing import Optional


def compute_rsi(closes: list[float], period: int) -> list[Optional[float]]:
    """Wilder's RSI - one value per input close, None for the warm-up
    bars before `period` deltas are available (needs period+1 closes for
    the first value)."""
    n = len(closes)
    rsi: list[Optional[float]] = [None] * n
    if n <= period:
        return rsi

    deltas = [closes[i] - closes[i - 1] for i in range(1, n)]
    gains = [d if d > 0 else 0.0 for d in deltas]
    losses = [-d if d < 0 else 0.0 for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    rsi[period] = _rsi_from_averages(avg_gain, avg_loss)

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rsi[i + 1] = _rsi_from_averages(avg_gain, avg_loss)

    return rsi


def _rsi_from_averages(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def compute_sma(values: list[Optional[float]], period: int) -> list[Optional[float]]:
    """Simple moving average - None wherever fewer than `period`
    non-None values are available in the trailing window (values may
    itself contain leading None warm-up entries, e.g. an RSI series)."""
    result: list[Optional[float]] = [None] * len(values)
    for i in range(len(values)):
        window = values[max(0, i - period + 1) : i + 1]
        if len(window) < period or any(v is None for v in window):
            continue
        result[i] = sum(window) / period
    return result


def compute_indicator(indicator_type: str, params: dict, closes: list[float]) -> list[Optional[float]]:
    """The indicator's own primary value series - dispatches to the right
    compute_* function for an Indicator's `type`. The one place that
    needs a new branch when a second indicator type is added
    (app/domain/models.py's IndicatorParams union is the other)."""
    if indicator_type == "rsi":
        return compute_rsi(closes, params["period"])
    raise ValueError(f"no compute rule for indicator type {indicator_type!r}")


def compute_indicator_signal(indicator_type: str, params: dict, closes: list[float]) -> list[Optional[float]]:
    """The indicator's own signal line, if it has one - for RSI, the SMA
    of its own value series (`sma_period`), matching how TradingView's
    RSI script bundles its "MA Length" setting into the RSI indicator
    itself rather than a separate rule parameter. rules.evaluate_crossover
    compares this against compute_indicator()'s output directly - neither
    function needs to know indicator_type is "rsi" specifically."""
    if indicator_type == "rsi":
        return compute_sma(compute_rsi(closes, params["period"]), params["sma_period"])
    raise ValueError(f"no signal rule for indicator type {indicator_type!r}")


def indicator_warmup(indicator_type: str, params: dict) -> int:
    """How many bars an indicator (including its own signal line, if it
    has one) needs before it produces a non-None value - used by
    rules.bars_needed to size a history request/backtest warm-up prefix."""
    if indicator_type == "rsi":
        return params["period"] + params["sma_period"]
    raise ValueError(f"no warmup rule for indicator type {indicator_type!r}")
