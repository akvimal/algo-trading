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
option_position_style together pick between them. Within either family,
Strategy.option_strike_moneyness (also signal-generation, 'ATM' default)
picks the primary/long leg's strike - ITM2/ITM1/ATM/OTM1/OTM2, see
_MONEYNESS_OFFSETS - a spread's short leg still sits SPREAD_WIDTH_STRIKES
further out from wherever the primary leg landed, not from ATM itself."""

from datetime import date
from typing import Literal, Optional

# How many strikes OTM the short leg sits from the primary (long) leg -
# fixed for now, not user-configurable (matches the "fixed template" scope
# - only the primary leg's own moneyness is configurable, see
# _MONEYNESS_OFFSETS below).
SPREAD_WIDTH_STRIKES = 2
# Liquidity floor when picking the short leg's exact strike - an OI below
# this nudges the search further OTM instead, see _pick_short_leg_index.
MIN_SHORT_LEG_OI = 1000
# Positional strategies avoid an expiry closing too soon into the hold -
# picks the nearest expiry that's at least this many days out.
MIN_POSITIONAL_DAYS_TO_EXPIRY = 7

# Strategy.option_strike_moneyness (signal-generation) -> signed strike-count
# offset from ATM, always expressed in "OTM direction" terms (positive =
# further OTM, negative = further ITM) - the actual index arithmetic still
# needs leg_key's own direction (+1 CE / -1 PE), same convention
# _pick_short_leg_index already uses for the short leg. Default 'ATM' (0)
# reproduces today's behavior exactly.
_MONEYNESS_OFFSETS: dict[str, int] = {"ITM2": -2, "ITM1": -1, "ATM": 0, "OTM1": 1, "OTM2": 2}


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


def _find_primary_leg_index(strikes: list[dict], leg_key: Literal["ce", "pe"], moneyness: str) -> Optional[int]:
    """The primary (long) leg's index for the requested moneyness - ATM
    found via _find_atm_index, then shifted by _MONEYNESS_OFFSETS[moneyness]
    in leg_key's own OTM direction (+1 CE / -1 PE, matching
    market-data's classify_moneyness: a call is OTM above spot, a put OTM
    below it), clamped into range same as _pick_short_leg_index does - a
    requested ITM2/OTM2 the chain doesn't actually have that many strikes
    for clamps to whatever's furthest available in that direction, rather
    than failing. None if the chain has no ATM strike at all - same
    failure mode _find_atm_index already has, propagated unchanged."""
    atm_index = _find_atm_index(strikes, leg_key)
    if atm_index is None:
        return None
    direction = 1 if leg_key == "ce" else -1
    offset = _MONEYNESS_OFFSETS[moneyness]
    n = len(strikes)
    return max(0, min(n - 1, atm_index + direction * offset))


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


def bull_call_spread(chain: dict, moneyness: str = "ATM") -> list[dict]:
    """BUY a call at the requested moneyness (ATM by default), SELL a call
    SPREAD_WIDTH_STRIKES further OTM from THAT strike (not necessarily
    from ATM itself, if moneyness shifted the primary leg). Raises
    ValueError if the chain has no ATM call to anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "ce", moneyness)
    if primary_index is None:
        raise ValueError("no ATM call strike found in chain")
    short_index = _pick_short_leg_index(strikes, primary_index, +1, "ce")
    return [
        _leg(strikes, primary_index, "ce", "BUY", chain["expiry"]),
        _leg(strikes, short_index, "ce", "SELL", chain["expiry"]),
    ]


def bear_put_spread(chain: dict, moneyness: str = "ATM") -> list[dict]:
    """BUY a put at the requested moneyness (ATM by default), SELL a put
    SPREAD_WIDTH_STRIKES further OTM from THAT strike. Raises ValueError
    if the chain has no ATM put to anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "pe", moneyness)
    if primary_index is None:
        raise ValueError("no ATM put strike found in chain")
    short_index = _pick_short_leg_index(strikes, primary_index, -1, "pe")
    return [
        _leg(strikes, primary_index, "pe", "BUY", chain["expiry"]),
        _leg(strikes, short_index, "pe", "SELL", chain["expiry"]),
    ]


def naked_call(chain: dict, moneyness: str = "ATM") -> list[dict]:
    """BUY a call at the requested moneyness (ATM by default) outright -
    no short leg. Single-leg counterpart to bull_call_spread
    (option_position_style='naked', see app/domain/resolution/strategy.py)
    - no SPREAD_WIDTH_STRIKES/MIN_SHORT_LEG_OI concerns since there's no
    short leg to place. Raises ValueError if the chain has no ATM call to
    anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "ce", moneyness)
    if primary_index is None:
        raise ValueError("no ATM call strike found in chain")
    return [_leg(strikes, primary_index, "ce", "BUY", chain["expiry"])]


def naked_put(chain: dict, moneyness: str = "ATM") -> list[dict]:
    """BUY a put at the requested moneyness (ATM by default) outright - no
    short leg. Single-leg counterpart to bear_put_spread. Raises
    ValueError if the chain has no ATM put to anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "pe", moneyness)
    if primary_index is None:
        raise ValueError("no ATM put strike found in chain")
    return [_leg(strikes, primary_index, "pe", "BUY", chain["expiry"])]
