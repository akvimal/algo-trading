"""POST /strategies/{id}/backtest-signals request/response shapes - see
app/domain/generation/external_backtest.py for the actual simulation this
backs. A dedicated file (not models.py/rule.py) since this is neither a
Strategy field nor a Rule one - it's a one-off report shape, same
reasoning RuleBacktestRequest/RuleBacktestGridRequest get their own
grouping in rule.py rather than living in models.py."""

from datetime import datetime, time
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.domain.generation.models import StopLossInterval
from app.domain.generation.rule import Interval


class ExternalBacktestSignal(BaseModel):
    """One row of the imported signal list (e.g. a Chartink alert-history
    CSV export) - deliberately just symbol+timestamp, no price/action
    columns, matching what that kind of export actually contains. Every
    row shares the request's own single `direction` (a Chartink scan is
    always one-directional, see docs/architecture.md's multi_condition
    rule notes) rather than carrying its own."""

    symbol: str = Field(min_length=1)
    timestamp: datetime


class ExternalBacktestRequest(BaseModel):
    """`signals` all share one direction and get backtested against a
    GRID of exit configurations (the opposite of every other backtest
    here, which fixes exit config and searches entry-detection params) -
    see external_backtest.py's own module docstring. Only one
    stop_loss_method's own grid is ever populated at a time (same "one
    fixed method per request" rule backtest.py's own grid_search already
    enforces) - 'previous_candle' has no per-combo value to sweep at all
    (stop_loss_interval alone decides it), 'percent' sweeps
    stop_loss_percent_grid, 'indicator' sweeps
    stop_loss_indicator_param_grid (same shape expand_stop_loss_grid
    already takes for Rule grid search)."""

    signals: list[ExternalBacktestSignal] = Field(min_length=1)
    direction: Literal["bullish", "bearish"]
    interval: Interval
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
    # 'previous_candle' only - which candle series to check against,
    # fetched separately from `interval` above (same as every other
    # backtest's sl_candles - see ExitConfig's own docstring).
    stop_loss_interval: Optional[StopLossInterval] = None
    # 'percent' only.
    stop_loss_percent_grid: Optional[list[float]] = Field(default=None, min_length=1)
    # 'indicator' only.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_param_grid: Optional[dict[str, list[int]]] = None
    # None alongside real values means "also try no target at all" (SL/
    # opposite-signal/end-of-data exit only) - a legitimate grid point,
    # not omitted-vs-set ambiguity the way a single-run request would have.
    target_percent_grid: list[Optional[float]] = Field(default_factory=lambda: [None])
    trailing_grid: list[bool] = Field(default_factory=lambda: [False])
    square_off_time: Optional[time] = None


class ExternalBacktestCombo(BaseModel):
    """One exit-config combination's aggregate performance across every
    signal in the request - see external_backtest.py's
    grid_search_external_signals. stop_loss_value is a float
    (stop_loss_percent) for method='percent', a dict
    (stop_loss_indicator_params) for method='indicator', or None for
    method='previous_candle'/unset (nothing swept on that axis)."""

    stop_loss_value: Optional[float | dict] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool
    trade_count: int
    hypothetical_pnl: float
    win_rate: float
    max_drawdown: float


class ExternalBacktestSkippedSymbol(BaseModel):
    """One symbol market-data couldn't resolve or fetch candle history
    for - degrades that one symbol's signals rather than failing the
    whole request, same "one bad constituent shouldn't abort the pooled
    backtest" convention _backtest_pooled_symbols already uses for
    universe/watchlist rules. `reason` is a human-readable explanation
    (see strategies.py's _skip_reason_for_candle_failure) so a caller can
    tell "this symbol's own signal is just too old for the provider's
    intraday-history window" apart from "this symbol doesn't exist" or a
    transient market-data outage, instead of every skip looking the same."""

    symbol: str
    reason: str


class ExternalBacktestResponse(BaseModel):
    """Ranked by hypothetical_pnl descending (best exit setup first) -
    see grid_search_external_signals."""

    signal_count: int
    symbols_tested: int
    symbols_skipped: list[ExternalBacktestSkippedSymbol]
    results: list[ExternalBacktestCombo]


class ExternalBacktestTradeRequest(BaseModel):
    """POST /strategies/{id}/backtest-signals/trades - the single-exit-
    config drill-down sibling of ExternalBacktestRequest above: same
    signals/direction/interval, but ONE exit config (not a grid) so the
    individual simulated trades behind one of ExternalBacktestResponse's
    combo rows can actually be inspected, the same way a real Chartink
    scan's own alert-history is symbol+timestamp rows a trader reads one
    at a time. Field shapes deliberately mirror ExternalBacktestCombo's
    own (stop_loss_percent/stop_loss_indicator_params/target_percent/
    trailing_stop_enabled) so a frontend can build this request directly
    from a combo row the grid endpoint already returned."""

    signals: list[ExternalBacktestSignal] = Field(min_length=1)
    direction: Literal["bullish", "bearish"]
    interval: Interval
    stop_loss_method: Optional[Literal["previous_candle", "percent", "indicator"]] = None
    stop_loss_interval: Optional[StopLossInterval] = None
    stop_loss_percent: Optional[float] = None
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict[str, int]] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    square_off_time: Optional[time] = None


class ExternalBacktestTrade(BaseModel):
    """One simulated trade - see app/domain/generation/rules.py's
    SimulatedTrade, with `symbol` attached since a single request here
    pools trades across every symbol in the CSV (SimulatedTrade itself
    carries no symbol - see its own docstring)."""

    symbol: str
    entry_time: str
    direction: str
    entry_price: float
    exit_time: str
    exit_price: float
    exit_reason: str
    pnl: float


class ExternalBacktestTradeResponse(BaseModel):
    """Same aggregate fields as one ExternalBacktestCombo row, plus the
    individual `trades` (sorted oldest-first) behind them - symbols_tested/
    symbols_skipped carry the same meaning as ExternalBacktestResponse's."""

    signal_count: int
    symbols_tested: int
    symbols_skipped: list[ExternalBacktestSkippedSymbol]
    trade_count: int
    hypothetical_pnl: float
    win_rate: float
    max_drawdown: float
    trades: list[ExternalBacktestTrade]
