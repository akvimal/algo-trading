"""Classifies an option strike as ITM/ATM/OTM relative to the underlying's
spot price - the one piece of "classification" logic that belongs in the
data layer (app/providers/dhan.py's get_option_chain), not strategy
selection (Phase 4b, not built yet - see docs/architecture.md). Pure
functions, no Dhan/network dependency."""

from typing import Literal


def infer_strike_step(strikes: list[float]) -> float:
    """The gap between adjacent strikes, inferred from the chain itself
    rather than assumed - Dhan's option-chain response doesn't send a
    step size, and it varies by underlying (e.g. 50 for NIFTY, 100 for
    BANKNIFTY, much smaller for individual stocks). Uses the most common
    gap between consecutive sorted strikes so one missing/extra strike in
    the chain doesn't skew a naive min() or first-gap approach. Raises
    ValueError for fewer than 2 strikes - there's no gap to infer."""
    if len(strikes) < 2:
        raise ValueError("need at least 2 strikes to infer a strike step")
    ordered = sorted(strikes)
    gaps = [round(b - a, 4) for a, b in zip(ordered, ordered[1:])]
    return max(set(gaps), key=gaps.count)


def classify_moneyness(strike: float, spot: float, option_type: Literal["CE", "PE"], strike_step: float) -> Literal["ITM", "ATM", "OTM"]:
    """ATM = within half a strike-step of spot (the nearest strike or two,
    depending on whether spot sits exactly on a strike). Otherwise ITM/OTM
    depend on option_type: a call is ITM below spot and OTM above it; a
    put is the mirror image."""
    if abs(strike - spot) <= strike_step / 2:
        return "ATM"
    if option_type == "CE":
        return "ITM" if strike < spot else "OTM"
    return "ITM" if strike > spot else "OTM"
