"""Open interest by strike, kept every few minutes (app/scheduler.py's _record_oi_strikes).

Dhan has no history of intraday OI, so an OI-based intraday strategy can only be tested against what is recorded going forward. This is the
pure half: which strikes of a fetched chain are kept, and the row each becomes."""

from typing import Optional

from app.domain.models import OptionChain, OptionChainStrike

# The strikes kept either side of the money. NIFTY strikes are 50 apart and BANKNIFTY's 100, so this is about +-750 and +-1500 points: wider than any
# short strike a same-day spread would use, narrow enough to be a few dozen rows a snapshot.
STRIKES_EACH_SIDE = 15
RECORDED_UNDERLYINGS = {"NSE": ["NIFTY", "BANKNIFTY"]}
RETENTION_DAYS = 90


def _leg(strike: OptionChainStrike, side: str) -> dict:
    leg = strike.ce if side == "ce" else strike.pe
    if leg is None:
        return {f"{side}_oi": None, f"{side}_prev_oi": None, f"{side}_ltp": None, f"{side}_iv": None}
    return {f"{side}_oi": leg.oi, f"{side}_prev_oi": leg.previous_oi, f"{side}_ltp": leg.last_price, f"{side}_iv": leg.implied_volatility}


def strike_rows(chain: OptionChain, each_side: int = STRIKES_EACH_SIDE) -> list[dict]:
    """One row per kept strike: the `each_side` strikes either side of the one nearest the spot price. Empty for a chain with no strikes."""
    strikes = sorted(chain.strikes, key=lambda s: s.strike)
    if not strikes:
        return []
    atm = min(range(len(strikes)), key=lambda i: abs(strikes[i].strike - chain.underlying_last_price))
    kept = strikes[max(0, atm - each_side) : atm + each_side + 1]
    return [
        {"expiry": chain.expiry, "spot_price": chain.underlying_last_price, "strike": s.strike, **_leg(s, "ce"), **_leg(s, "pe")}
        for s in kept
    ]


def nearest_expiry(expiries: list[str]) -> Optional[str]:
    return sorted(expiries)[0] if expiries else None
