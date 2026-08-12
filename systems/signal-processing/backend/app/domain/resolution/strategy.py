from datetime import date
from typing import Optional

import requests

from app.adapters.market_data.client import get_expiry_list, get_option_chain, resolve_underlying
from app.domain.models import SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.option_templates import bear_put_spread, bull_call_spread, choose_expiry


def choose_strategy(signal: SignalIngest, horizon: str, instrument_type: str) -> Optional[dict]:
    """Pick an option strategy (spread, straddle, naked leg, ...) - NOT to
    be confused with signal-generation's Strategy entity (signal.strategy_id),
    which is a different concept (which signal source/config produced this
    signal). This function decides option *legs*, given horizon/instrument_type
    already resolved from that Strategy.

    Only relevant once instrument_type == "option" - None (not an
    option strategy) otherwise. A fixed bias->template rule set for now,
    not a general strategy-selection engine - bullish (BUY) signals get a
    bull call spread, bearish (SELL) a bear put spread, see
    app/domain/resolution/option_templates.py - see docs/architecture.md
    Phase 4b for why. Raises ResolutionError (not a silent None) if any
    step can't resolve - a signal that can't get real legs shouldn't
    resolve as instrument_type='option' with nothing to trade, same
    "persisted as rejected, nothing published" handling resolve() already
    gives every other ResolutionError.

    Works for both NSE and MCX (SignalIngest.exchange's only two values) -
    the option chain is always referenced against resolve_underlying(...)
    .chart_symbol, not signal.symbol directly, since that's the only thing
    correct in all three underlying shapes: an NSE index option chains off
    the index spot, an NSE equity option off the equity itself (chart_symbol
    == trade_symbol there), and an MCX commodity option off its active-month
    futures contract (MCX has no separate spot, so chart_symbol ==
    trade_symbol there too, but neither equals the bare underlying name
    signal.symbol carries, e.g. "GOLDM" vs "GOLDM-04Sep2026-FUT").
    """
    if instrument_type != "option":
        return None

    resolved = resolve_underlying(signal.exchange, signal.symbol)
    if resolved is None:
        raise ResolutionError(f"could not resolve underlying '{signal.symbol}' on {signal.exchange} for options")

    try:
        expiries = get_expiry_list(resolved.chart_exchange, resolved.chart_symbol)
    except requests.RequestException as exc:
        raise ResolutionError(f"could not resolve option expiries for '{resolved.chart_symbol}': {exc}") from exc
    if not expiries:
        raise ResolutionError(f"could not resolve option expiries for '{resolved.chart_symbol}'")

    today = signal.timestamp.date() if signal.timestamp else date.today()
    expiry = choose_expiry(expiries, horizon, today)
    if expiry is None:
        raise ResolutionError(f"could not choose an option expiry for '{resolved.chart_symbol}'")

    try:
        chain = get_option_chain(resolved.chart_exchange, resolved.chart_symbol, expiry)
    except requests.RequestException as exc:
        raise ResolutionError(f"could not resolve option chain for '{resolved.chart_symbol}' ({expiry}): {exc}") from exc
    if chain is None:
        raise ResolutionError(f"could not resolve option chain for '{resolved.chart_symbol}' ({expiry})")

    try:
        if signal.action == "BUY":
            return {"type": "bull_call_spread", "legs": bull_call_spread(chain)}
        return {"type": "bear_put_spread", "legs": bear_put_spread(chain)}
    except ValueError as exc:
        raise ResolutionError(f"could not build an option strategy for '{signal.symbol}': {exc}") from exc
