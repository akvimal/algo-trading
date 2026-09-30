"""Slippage for paper fills.

A paper fill at the exact quote is optimistic: a market order pays the spread
and moves the price a little, a stop-loss triggers and fills worse than the stop.
This models that as a COST of `slippage_bps` basis points on the turnover of each
market-type leg, netted into P&L when a position closes (the same chokepoint the
Indian charges use, see india_charges.py). It is a cost, NOT a repricing of the
fill: entry_price / exit_price stay the real market prices, so nothing that reads
them (sizing, stop-loss maths, the charts) changes.

Which legs slip:
  entry  every entry except a resting limit order (order_type == 'limit'); an
         automated Strategy trade has no order_type and is a market fill
  exit   every exit except a limit-style one - a target (the four *target
         reasons) fills at its limit - and a liquidation (a forced price, priced
         by its own formula)
A stop-loss is a stop-MARKET, so it slips.

One rate for all segments and instruments is deliberately crude (an option premium
typically slips more, in bps, than a large-cap share); it is a per-account
setting, and 0 turns it off. New accounts default to 5 bps, an assumption, not a
measurement.
"""

from typing import Optional

# Exits that fill at a limit price (no adverse slippage) or at a forced price.
NO_SLIPPAGE_EXIT_REASONS = {"target", "combined_target", "individual_target", "spot_target", "liquidation"}


def entry_slips(order_type: Optional[str]) -> bool:
    return order_type != "limit"


def exit_slips(exit_reason: Optional[str]) -> bool:
    return exit_reason not in NO_SLIPPAGE_EXIT_REASONS


def slippage_cost(bps: float, entry_turnover: float, exit_turnover: float, order_type: Optional[str], exit_reason: Optional[str]) -> float:
    """The cost, in the position's own currency, of `bps` basis points on each
    leg that slips. 0.0 for a non-positive rate."""
    if bps is None or bps <= 0:
        return 0.0
    rate = bps / 10000.0
    cost = 0.0
    if entry_slips(order_type):
        cost += rate * max(entry_turnover, 0.0)
    if exit_slips(exit_reason):
        cost += rate * max(exit_turnover, 0.0)
    return cost
