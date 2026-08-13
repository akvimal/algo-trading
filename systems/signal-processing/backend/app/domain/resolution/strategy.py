from datetime import date
from typing import Optional

import requests

from app.adapters.market_data.client import get_expiry_list, get_option_chain, resolve_underlying
from app.domain.models import SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.option_templates import (
    bear_put_spread,
    bull_call_spread,
    choose_expiry,
    naked_call,
    naked_put,
)


def choose_strategy(
    signal: SignalIngest,
    horizon: str,
    instrument_type: str,
    option_position_style: str = "spread",
    option_strike_moneyness: str = "ATM",
) -> Optional[dict]:
    """Pick an option strategy (spread, naked leg, ...) - NOT to be
    confused with signal-generation's Strategy entity (signal.strategy_id),
    which is a different concept (which signal source/config produced this
    signal). This function decides option *legs*, given horizon/
    instrument_type/option_position_style/option_strike_moneyness already
    resolved from that Strategy.

    Only relevant once instrument_type == "option" - None (not an
    option strategy) otherwise. A fixed bias->template rule set for now,
    not a general strategy-selection engine - option_position_style picks
    the template FAMILY ('spread', the default, or 'naked'), signal bias
    picks the direction within it: bullish (BUY) -> bull_call_spread or
    naked_call, bearish (SELL) -> bear_put_spread or naked_put.
    option_strike_moneyness ('ATM' default) then picks which strike the
    primary/long leg within that template actually uses -
    ITM2/ITM1/ATM/OTM1/OTM2, see option_templates.py's
    _MONEYNESS_OFFSETS. See app/domain/resolution/option_templates.py,
    docs/architecture.md Phase 4b for the spread templates and the "naked
    call/put option style" section for naked/moneyness. Raises
    ResolutionError (not a silent None) if any
    step can't resolve - a signal that can't get real legs shouldn't
    resolve as instrument_type='option' with nothing to trade, same
    "persisted as rejected, nothing published" handling resolve() already
    gives every other ResolutionError.

    Works for NSE, MCX, and CRYPTO (SignalIngest.exchange's three values) -
    the option chain is always referenced against resolve_underlying(...)
    .chart_symbol, not signal.symbol directly, since that's the only thing
    correct in all four underlying shapes: an NSE index option chains off
    the index spot, an NSE equity option off the equity itself (chart_symbol
    == trade_symbol there), an MCX commodity option off its active-month
    futures contract (MCX has no separate spot, so chart_symbol ==
    trade_symbol there too, but neither equals the bare underlying name
    signal.symbol carries, e.g. "GOLDM" vs "GOLDM-04Sep2026-FUT"), and a
    CRYPTO option off the perpetual future itself (Delta Exchange India has
    no separate spot either, so chart_symbol == trade_symbol == signal.symbol
    there, e.g. "BTCUSD" - see market-data's DeltaProvider.resolve_underlying).
    This function itself carries no exchange-specific logic at all - it just
    calls resolve_underlying/get_expiry_list/get_option_chain generically and
    reads the chain's already-normalized dict shape, so a new exchange only
    ever needs a new market-data provider, never a change here.
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
        if option_position_style == "naked":
            if signal.action == "BUY":
                return {"type": "naked_call", "legs": naked_call(chain, option_strike_moneyness)}
            return {"type": "naked_put", "legs": naked_put(chain, option_strike_moneyness)}
        if signal.action == "BUY":
            return {"type": "bull_call_spread", "legs": bull_call_spread(chain, option_strike_moneyness)}
        return {"type": "bear_put_spread", "legs": bear_put_spread(chain, option_strike_moneyness)}
    except ValueError as exc:
        raise ResolutionError(f"could not build an option strategy for '{signal.symbol}': {exc}") from exc
