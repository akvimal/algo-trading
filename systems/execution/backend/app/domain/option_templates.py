"""Fixed bias-to-template option strategy legs - ported from
signal-processing's app/domain/resolution/option_templates.py (no shared
code across systems/* by design - see CLAUDE.md). Pure functions - the
chain dict passed in is already-fetched (app/adapters/quotes/client.py's
get_option_chain), same shape market-data's OptionChain model returns
(underlying_last_price, expiry, strikes: [{strike, ce, pe}], each leg
carrying oi/moneyness/security_id/greeks/...).

Unlike the signal-processing original, this module has NO choose_expiry
function - the Manual tab's option orders take an explicit, user-picked
expiry (see open_manual_option_group in option_position_manager.py), not
an automatically-chosen one. Everything else (moneyness offsets, spread
width, OI-liquidity nudge, naked/spread leg building) is identical."""

from typing import Literal, Optional

# How many strikes OTM the short leg sits from the primary (long) leg -
# fixed for now, not user-configurable (matches the "fixed template" scope
# - only the primary leg's own moneyness is configurable, see
# _MONEYNESS_OFFSETS below).
SPREAD_WIDTH_STRIKES = 2
# Liquidity floor when picking the short leg's exact strike - an OI below
# this nudges the search further OTM instead, see _pick_short_leg_index.
MIN_SHORT_LEG_OI = 1000

# option_strike_moneyness -> signed strike-count offset from ATM, always
# expressed in "OTM direction" terms (positive = further OTM, negative =
# further ITM) - the actual index arithmetic still needs leg_key's own
# direction (+1 CE / -1 PE), same convention _pick_short_leg_index already
# uses for the short leg. Default 'ATM' (0) reproduces today's behavior
# exactly.
_MONEYNESS_OFFSETS: dict[str, int] = {"ITM2": -2, "ITM1": -1, "ATM": 0, "OTM1": 1, "OTM2": 2}


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


def _pick_short_leg_index(strikes: list[dict], atm_index: int, direction: int, leg_key: str, width: int = SPREAD_WIDTH_STRIKES) -> int:
    """The ideal short-leg index is atm_index + direction*width (default
    SPREAD_WIDTH_STRIKES, clamped into range) - `width` is the caller's own
    override (the Scan page's leg table lets the second leg's own strike
    step independently of the primary leg's moneyness, see ScanOptionBias.tsx)
    for how many strikes it sits from the primary leg; every other caller
    still gets the fixed default. If that strike's OI is below
    MIN_SHORT_LEG_OI, keeps stepping further in `direction` (further OTM)
    looking for one that clears it - falls back to the clamped ideal index
    if none do before running out of strikes, rather than returning
    nothing."""
    n = len(strikes)
    ideal = max(0, min(n - 1, atm_index + direction * width))

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


def bull_call_spread(chain: dict, moneyness: str = "ATM", width: int = SPREAD_WIDTH_STRIKES) -> list[dict]:
    """BUY a call at the requested moneyness (ATM by default), SELL a call
    `width` strikes further OTM from THAT strike (not necessarily from ATM
    itself, if moneyness shifted the primary leg) - `width` defaults to
    SPREAD_WIDTH_STRIKES but is the caller's own override, letting the
    short leg's own strike step independently of the primary leg's
    moneyness (see ScanOptionBias.tsx). Raises ValueError if the chain has
    no ATM call to anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "ce", moneyness)
    if primary_index is None:
        raise ValueError("no ATM call strike found in chain")
    short_index = _pick_short_leg_index(strikes, primary_index, +1, "ce", width)
    return [
        _leg(strikes, primary_index, "ce", "BUY", chain["expiry"]),
        _leg(strikes, short_index, "ce", "SELL", chain["expiry"]),
    ]


def bear_put_spread(chain: dict, moneyness: str = "ATM", width: int = SPREAD_WIDTH_STRIKES) -> list[dict]:
    """BUY a put at the requested moneyness (ATM by default), SELL a put
    `width` strikes further OTM from THAT strike (see bull_call_spread's
    own `width` note). Raises ValueError if the chain has no ATM put to
    anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "pe", moneyness)
    if primary_index is None:
        raise ValueError("no ATM put strike found in chain")
    short_index = _pick_short_leg_index(strikes, primary_index, -1, "pe", width)
    return [
        _leg(strikes, primary_index, "pe", "BUY", chain["expiry"]),
        _leg(strikes, short_index, "pe", "SELL", chain["expiry"]),
    ]


def bull_put_spread(chain: dict, moneyness: str = "ATM", width: int = SPREAD_WIDTH_STRIKES) -> list[dict]:
    """SELL a put at the requested moneyness (ATM by default) - the credit
    leg - and BUY a put `width` strikes further OTM (lower strike) as
    protection, capping the loss at the strike width minus the credit
    received. The net-credit, bullish counterpart to bull_call_spread's
    debit construction - same anchor-then-protection shape as
    bear_put_spread, BUY/SELL swapped (see its own `width` note too). See
    option_position_manager's _spread_sizing_basis for how a negative
    net_debit (this template always produces one, when quotes are sane)
    gets sized by max loss instead of premium cost. Raises ValueError if
    the chain has no ATM put to anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "pe", moneyness)
    if primary_index is None:
        raise ValueError("no ATM put strike found in chain")
    protection_index = _pick_short_leg_index(strikes, primary_index, -1, "pe", width)
    return [
        _leg(strikes, primary_index, "pe", "SELL", chain["expiry"]),
        _leg(strikes, protection_index, "pe", "BUY", chain["expiry"]),
    ]


def bear_call_spread(chain: dict, moneyness: str = "ATM", width: int = SPREAD_WIDTH_STRIKES) -> list[dict]:
    """SELL a call at the requested moneyness (ATM by default) - the
    credit leg - and BUY a call `width` strikes further OTM (higher
    strike) as protection. The net-credit, bearish counterpart to
    bear_put_spread's debit construction. Raises ValueError if the chain
    has no ATM call to anchor off of."""
    strikes = chain["strikes"]
    primary_index = _find_primary_leg_index(strikes, "ce", moneyness)
    if primary_index is None:
        raise ValueError("no ATM call strike found in chain")
    protection_index = _pick_short_leg_index(strikes, primary_index, +1, "ce", width)
    return [
        _leg(strikes, primary_index, "ce", "SELL", chain["expiry"]),
        _leg(strikes, protection_index, "ce", "BUY", chain["expiry"]),
    ]


def naked_call(chain: dict, moneyness: str = "ATM") -> list[dict]:
    """BUY a call at the requested moneyness (ATM by default) outright -
    no short leg. Single-leg counterpart to bull_call_spread
    (option_position_style='naked') - no SPREAD_WIDTH_STRIKES/
    MIN_SHORT_LEG_OI concerns since there's no short leg to place. Raises
    ValueError if the chain has no ATM call to anchor off of."""
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
