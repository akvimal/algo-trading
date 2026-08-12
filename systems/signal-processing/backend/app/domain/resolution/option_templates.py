"""Fixed bias-to-template option strategy legs (Phase 4b of the options
trading module - see docs/architecture.md). Pure functions - the chain
dict passed in is already-fetched (app/adapters/market_data/client.py's
get_option_chain), same shape market-data's OptionChain model returns
(underlying_last_price, expiry, strikes: [{strike, ce, pe}], each leg
carrying oi/moneyness/security_id/greeks/...). Not a general rule engine:
exactly two template FAMILIES, chosen per-strategy via
Strategy.option_position_style (signal-generation) - 'spread' (bullish ->
bull call spread, bearish -> bear put spread) or 'naked' (bullish -> naked
call, bearish -> naked put, single BUY leg only) - see
app/domain/resolution/strategy.py for where signal bias and
option_position_style together pick between them."""

from datetime import date
from typing import Literal, Optional

# How many strikes OTM the short leg sits from the long (ATM) leg - fixed
# for now, not user-configurable (matches the "fixed template" scope).
SPREAD_WIDTH_STRIKES = 2
# Liquidity floor when picking the short leg's exact strike - an OI below
# this nudges the search further OTM instead, see _pick_short_leg_index.
MIN_SHORT_LEG_OI = 1000
# Positional strategies avoid an expiry closing too soon into the hold -
# picks the nearest expiry that's at least this many days out.
MIN_POSITIONAL_DAYS_TO_EXPIRY = 7


def choose_expiry(expiries: list[str], horizon: str, today: date) -> Optional[str]:
    """intraday: nearest expiry, no matter how soon. positional: nearest
    expiry that's at least MIN_POSITIONAL_DAYS_TO_EXPIRY out - falls back
    to the furthest available expiry if none qualify (better to trade a
    contract with more time left than refuse to trade at all). None if
    `expiries` is empty."""
    if not expiries:
        return None
    ordered = sorted(expiries)
    if horizon != "positional":
        return ordered[0]
    for expiry in ordered:
        if (date.fromisoformat(expiry) - today).days >= MIN_POSITIONAL_DAYS_TO_EXPIRY:
            return expiry
    return ordered[-1]


def _find_atm_index(strikes: list[dict], leg_key: Literal["ce", "pe"]) -> Optional[int]:
    for i, strike in enumerate(strikes):
        leg = strike.get(leg_key)
        if leg is not None and leg["moneyness"] == "ATM":
            return i
    return None


def _pick_short_leg_index(strikes: list[dict], atm_index: int, direction: int, leg_key: str) -> int:
    """The ideal short-leg index is atm_index + direction*SPREAD_WIDTH_STRIKES
    (clamped into range). If that strike's OI is below MIN_SHORT_LEG_OI,
    keeps stepping further in `direction` (further OTM) looking for one
    that clears it - falls back to the clamped ideal index if none do
    before running out of strikes, rather than returning nothing."""
    n = len(strikes)
    ideal = max(0, min(n - 1, atm_index + direction * SPREAD_WIDTH_STRIKES))

    index = ideal
    while 0 <= index < n:
        leg = strikes[index].get(leg_key)
        if leg is not None and leg["oi"] >= MIN_SHORT_LEG_OI:
            return index
        index += direction
    return ideal


def _leg(strikes: list[dict], index: int, leg_key: str, action: str, expiry: str) -> dict:
    leg = strikes[index][leg_key]
    return {
        "action": action,
        "option_type": leg_key.upper(),
        "strike": strikes[index]["strike"],
        "expiry": expiry,
        "security_id": leg["security_id"],
    }


def bull_call_spread(chain: dict) -> list[dict]:
    """BUY the ATM call, SELL a call SPREAD_WIDTH_STRIKES OTM (a higher
    strike) from it. Raises ValueError if the chain has no ATM call."""
    strikes = chain["strikes"]
    atm_index = _find_atm_index(strikes, "ce")
    if atm_index is None:
        raise ValueError("no ATM call strike found in chain")
    short_index = _pick_short_leg_index(strikes, atm_index, +1, "ce")
    return [
        _leg(strikes, atm_index, "ce", "BUY", chain["expiry"]),
        _leg(strikes, short_index, "ce", "SELL", chain["expiry"]),
    ]


def bear_put_spread(chain: dict) -> list[dict]:
    """BUY the ATM put, SELL a put SPREAD_WIDTH_STRIKES OTM (a lower
    strike) from it. Raises ValueError if the chain has no ATM put."""
    strikes = chain["strikes"]
    atm_index = _find_atm_index(strikes, "pe")
    if atm_index is None:
        raise ValueError("no ATM put strike found in chain")
    short_index = _pick_short_leg_index(strikes, atm_index, -1, "pe")
    return [
        _leg(strikes, atm_index, "pe", "BUY", chain["expiry"]),
        _leg(strikes, short_index, "pe", "SELL", chain["expiry"]),
    ]


def naked_call(chain: dict) -> list[dict]:
    """BUY the ATM call outright - no short leg. Single-leg counterpart to
    bull_call_spread (option_position_style='naked', see
    app/domain/resolution/strategy.py) - no SPREAD_WIDTH_STRIKES/
    MIN_SHORT_LEG_OI concerns since there's no short leg to place. Raises
    ValueError if the chain has no ATM call."""
    strikes = chain["strikes"]
    atm_index = _find_atm_index(strikes, "ce")
    if atm_index is None:
        raise ValueError("no ATM call strike found in chain")
    return [_leg(strikes, atm_index, "ce", "BUY", chain["expiry"])]


def naked_put(chain: dict) -> list[dict]:
    """BUY the ATM put outright - no short leg. Single-leg counterpart to
    bear_put_spread. Raises ValueError if the chain has no ATM put."""
    strikes = chain["strikes"]
    atm_index = _find_atm_index(strikes, "pe")
    if atm_index is None:
        raise ValueError("no ATM put strike found in chain")
    return [_leg(strikes, atm_index, "pe", "BUY", chain["expiry"])]
