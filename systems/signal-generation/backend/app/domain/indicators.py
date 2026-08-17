"""Pure indicator math - no I/O, no DB, so directly unit-testable and
reusable identically by the live engine and the backtest replay (see
rules.py, engine.py, backtest.py). closes/values are always oldest-first
(chronological)."""

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    # Type-checking only - app.domain.rules imports this module (for
    # compute_indicator/compute_indicator_signal/indicator_warmup), so a
    # top-level import here would cycle. evaluate_regime_indicator/
    # regime_indicator_warmup below import app.domain.regime lazily
    # (function-local) for the same reason - regime.py itself imports
    # Bias/CandleClose from app.domain.rules.
    from app.domain.rules import Bias, CandleClose


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


def evaluate_regime_indicator(indicator_type: str, params: dict, candles: "list[CandleClose]", bias: "Bias") -> Optional[bool]:
    """Dispatches to the matching app/domain/regime.py check_* function -
    mirrors compute_indicator's own if/elif dispatch shape, one level up
    (a regime check's "value" is already a bullish/bearish pass/fail, not
    a scalar series a rule then compares against a signal line). Regime
    indicators are evaluated directly by app/domain/engine.py's
    _regime_confirmed, not through rules.evaluate - see Rule.
    regime_indicator_ids."""
    # Local import - see this module's own TYPE_CHECKING note up top.
    from app.domain.regime import (
        check_adx,
        check_dmi_direction,
        check_ema_slope,
        check_efficiency_ratio,
        check_structure,
        check_supertrend,
    )

    if indicator_type == "structure":
        return check_structure(candles, bias, params["swing_lookback"])
    if indicator_type == "efficiency_ratio":
        return check_efficiency_ratio(candles, bias, params["period"], params["trend_threshold"])
    if indicator_type == "adx":
        return check_adx(candles, bias, params["period"], params["trend_threshold"])
    if indicator_type == "dmi_direction":
        return check_dmi_direction(candles, bias, params["period"])
    if indicator_type == "ema_slope":
        return check_ema_slope(
            candles, bias, params["ema_period"], params["slope_lookback"], params["slope_threshold"], params["atr_period"]
        )
    if indicator_type == "supertrend":
        return check_supertrend(candles, bias, params["period"], params["multiplier"])
    raise ValueError(f"no regime-evaluate rule for indicator type {indicator_type!r}")


def regime_indicator_warmup(indicator_type: str, params: dict) -> int:
    """Per-type bar-count estimate, mirroring indicator_warmup's shape -
    same "extra empty bars cost nothing, this is a coarse over-estimate
    not a tight bound" philosophy as regime.regime_warmup, decomposed per
    check instead of one shared max()."""
    if indicator_type == "structure":
        return params["swing_lookback"] * 8  # ~2 confirmed pivots of each type
    if indicator_type == "efficiency_ratio":
        return params["period"] + 1
    if indicator_type == "adx":
        return params["period"] * 3  # DM smoothing + DX-into-ADX smoothing both need to settle
    if indicator_type == "dmi_direction":
        return params["period"] * 3  # same DMI settle as adx - +DI/-DI come from the same smoothing pass
    if indicator_type == "ema_slope":
        return max(params["ema_period"] + params["slope_lookback"], params["atr_period"] + 1)
    if indicator_type == "supertrend":
        return params["period"] + 1  # single ATR smoothing pass, same settle as compute_atr itself
    raise ValueError(f"no regime-warmup rule for indicator type {indicator_type!r}")
