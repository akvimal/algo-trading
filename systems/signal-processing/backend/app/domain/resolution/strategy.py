from datetime import date
from typing import Optional

import requests

from app.adapters.market_data.client import get_expiry_list, get_option_chain
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
    gives every other ResolutionError. Options are NSE-only today,
    matching market-data's Phase 4a chain support.
    """
    if instrument_type != "option":
        return None
    if signal.exchange != "NSE":
        raise ResolutionError(f"options are only supported on NSE (signal exchange={signal.exchange})")

    try:
        expiries = get_expiry_list(signal.exchange, signal.symbol)
    except requests.RequestException as exc:
        raise ResolutionError(f"could not resolve option expiries for '{signal.symbol}': {exc}") from exc
    if not expiries:
        raise ResolutionError(f"could not resolve option expiries for '{signal.symbol}'")

    today = signal.timestamp.date() if signal.timestamp else date.today()
    expiry = choose_expiry(expiries, horizon, today)
    if expiry is None:
        raise ResolutionError(f"could not choose an option expiry for '{signal.symbol}'")

    try:
        chain = get_option_chain(signal.exchange, signal.symbol, expiry)
    except requests.RequestException as exc:
        raise ResolutionError(f"could not resolve option chain for '{signal.symbol}' ({expiry}): {exc}") from exc
    if chain is None:
        raise ResolutionError(f"could not resolve option chain for '{signal.symbol}' ({expiry})")

    try:
        if signal.action == "BUY":
            return {"type": "bull_call_spread", "legs": bull_call_spread(chain)}
        return {"type": "bear_put_spread", "legs": bear_put_spread(chain)}
    except ValueError as exc:
        raise ResolutionError(f"could not build an option strategy for '{signal.symbol}': {exc}") from exc
