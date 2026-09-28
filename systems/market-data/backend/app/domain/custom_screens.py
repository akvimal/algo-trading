"""Pure evaluation core for the custom equity screener - parses a typed
expression once (app/domain/screener_expr.py) and runs it against a set of
already-fetched candidate symbols, each with its own already-fetched daily
bars. No DB/provider dependency here - app/api/routes/custom_screens.py
does the actual querying (the base-universe filter against
equity_screener_snapshot, the batch equity_daily_bar fetch) and calls this;
same "pure core, thin route" split equity_screener.py/oi_summary.py use."""

from dataclasses import dataclass
from typing import Optional

from app.domain.models import Candle
from app.domain.screener_expr import EvalContext, evaluate_expression, parse_expression


@dataclass
class ScreenCandidate:
    """One candidate stock's own latest snapshot read plus its raw daily
    bars (oldest-first) - what run_custom_screen needs per symbol. `close`
    here is carried straight from equity_screener_snapshot's own latest
    row (cheap, already computed) rather than re-derived from bars."""

    symbol: str
    exchange: str
    close: float
    bars: list[Candle]


@dataclass
class ScreenMatch:
    symbol: str
    exchange: str
    close: float


def run_custom_screen(expression: str, candidates: list[ScreenCandidate]) -> list[ScreenMatch]:
    """Raises screener_expr.ExpressionError (unchanged) if `expression`
    itself does not parse - the caller maps that straight to a 422 with
    the same plain-language reason, since this is exactly what the person
    typed. One candidate's evaluation never affects another's; a stock
    with too little history for what the expression asks just evaluates
    to False (see screener_expr's own None-safety), not an error - the
    same "a thin symbol has nothing to report yet, skipped rather than
    aborting the batch" spirit every EOD job in this service already has."""
    condition = parse_expression(expression)  # raises up front: one clear error, not one per candidate
    matches: list[ScreenMatch] = []
    for c in candidates:
        ctx = EvalContext(daily_bars=c.bars)
        if evaluate_expression(condition, ctx):
            matches.append(ScreenMatch(symbol=c.symbol, exchange=c.exchange, close=c.close))
    return matches


def matches_universe_filters(
    is_fno: Optional[bool], index_memberships: Optional[str], close: float,
    filter_is_fno: Optional[bool], filter_index: Optional[str], filter_min_price: Optional[float], filter_max_price: Optional[float],
) -> bool:
    """Whether one snapshot row passes the base-universe filters - None on
    any filter_* means that dimension is not filtered at all. Pure so the
    filtering logic (which SQL alone would otherwise bury in the route) is
    directly testable; the route applies it while paging through
    candidates rather than loading the whole ~2000-row snapshot table to
    filter in Python, but the logic itself is identical either way."""
    if filter_is_fno is not None and bool(is_fno) != filter_is_fno:
        return False
    if filter_index is not None and filter_index not in (index_memberships or "").split(","):
        return False
    if filter_min_price is not None and close < filter_min_price:
        return False
    if filter_max_price is not None and close > filter_max_price:
        return False
    return True
