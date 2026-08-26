"""Delta Exchange India fee/liquidation simulation for CRYPTO paper trading -
pure, DB-free formulas (no side effects, same shape as position_manager.py's
own _STOP_LOSS_COMPUTE_FUNCS/_indicator_history_window) so position_manager.py
and option_position_manager.py can both call these without either owning the
math. Every rate is a named constant, never inlined in a formula - see
docs/architecture.md's own section on this module for the full scope/caveats.

Source: fee/liquidation screenshots the user provided 2026-08-21 (see
c:\\Users\\admin\\Downloads\\delta_exchange_fee_liquidation_rules.md) - NOT
pulled live from Delta's API. Several of these are promotional/discounted
rates (options taker fee, gold/silver fees, the option fee cap) - re-verify
against Delta's live fee page periodically, this config won't self-update.

Scope, confirmed 2026-08-21:
- Taker rate ONLY, always - every fill in this platform happens at a live
  LTP (get_ltp_batch), never a resting limit order, so there's no maker
  concept to wire up at all.
- Liquidation applies to CRYPTO FUTURES only. CRYPTO options never carry
  liquidation risk in this platform: naked_call/naked_put are long-only
  (open_option_group rejects a naked leg whose action != "BUY" - no
  margin/undefined-risk handling anywhere in this platform), and a
  spread's short leg is always fully collateralized by its paired long
  leg. Options still get trading-fee simulation (compute_option_trading_fee)
  - just never a liquidation trigger.
- No margin-pool locking - capital_per_trade * leverage sizing is
  untouched; this module only adds real cash outflows (fees, and, on
  liquidation, the position's own posted margin).
"""

from typing import Optional

DELTA_FEE_CONFIG_VERSION = "2026-08-21"

GST_RATE = 0.18

FUTURES_TAKER_FEE_RATE = 0.0005  # 0.05%
OPTIONS_TAKER_FEE_RATE = 0.00010  # 0.010% - shown as a promo rate, was 0.03%
OPTIONS_FEE_CAP_PCT_OF_PREMIUM = 0.035  # 3.5% cap - was 10%

# Instruments with a fixed liquidation-fee rate regardless of leverage.
FUTURES_FLAT_LIQUIDATION_RATE = {"BTC": 0.0005, "ETH": 0.0010, "PAXG": 0.0020}

# "All other" futures - rate depends on the CONTRACT's own max leverage, which
# this platform has no real data source for anywhere (market-data's
# DeltaProvider only exposes contract_value/lot size, never a max-leverage
# figure) - _tiered_liquidation_rate approximates it off the account's own
# configured leverage instead (the smallest documented tier that could
# actually support that leverage), an explicit approximation matching the
# spec's own "approximation, see caveats" framing for Rule D.
FUTURES_TIERED_LIQUIDATION_RATE: list[tuple[float, float]] = [
    (10, 0.0100),
    (20, 0.0050),
    (25, 0.0050),
    (50, 0.0020),
    (100, 0.0010),
]

MAINTENANCE_MARGIN_PCT_DEFAULT = 0.005  # 0.5% - placeholder, see module docstring


def asset_from_symbol(symbol: str) -> Optional[str]:
    """"BTCUSD" -> "BTC", "ETHUSD" -> "ETH", "PAXGUSD" -> "PAXG" - prefix
    match against FUTURES_FLAT_LIQUIDATION_RATE's own keys, longest first so
    a hypothetical overlapping prefix never resolves to the wrong asset.
    None for anything else (e.g. a plain altcoin future) - _tiered_
    liquidation_rate is what handles those instead."""
    for asset in sorted(FUTURES_FLAT_LIQUIDATION_RATE, key=len, reverse=True):
        if symbol.upper().startswith(asset):
            return asset
    return None


def compute_futures_trading_fee(notional: float) -> float:
    """Rule A, futures - always the taker rate (see module docstring)."""
    return notional * FUTURES_TAKER_FEE_RATE * (1 + GST_RATE)


def compute_option_trading_fee(notional: float, premium_amount: float) -> float:
    """Rule A, options - taker rate, GST, then capped at
    OPTIONS_FEE_CAP_PCT_OF_PREMIUM * premium_amount (a cheap option's
    percentage-of-notional fee can otherwise exceed a sane fraction of what
    was actually paid for it)."""
    fee_with_gst = notional * OPTIONS_TAKER_FEE_RATE * (1 + GST_RATE)
    return min(fee_with_gst, OPTIONS_FEE_CAP_PCT_OF_PREMIUM * premium_amount)


def compute_margin_posted(notional: float, leverage: float) -> float:
    """notional / leverage - Rule D's initial_margin_pct (1/leverage)
    applied to notional. Also Rule E's margin_posted, the full amount
    treated as lost on liquidation (see compute_liquidation_price's own
    docstring on why liquidation wipes the WHOLE posted margin, not just
    the raw price-distance loss)."""
    return notional / leverage


def compute_liquidation_price(
    action: str, entry_price: float, leverage: float, maintenance_margin_pct: float = MAINTENANCE_MARGIN_PCT_DEFAULT
) -> float:
    """Rule D - an approximation (ignores funding, exact per-contract
    maintenance-margin tiers, and Delta's own liquidation-trigger buffer -
    see the spec's caveats). Directional estimate for when to force-close,
    not a promise of matching Delta's real engine to the cent.

    Deliberately NOT used to compute the realized loss on liquidation -
    position_manager._evaluate_exits instead wipes the FULL compute_margin_
    posted() amount (+ the liquidation fee) once this price is crossed, per
    Rule E's total_cost formula, which is more conservative than the raw
    (entry - liquidation_price) * quantity distance this function's own
    inputs would imply."""
    initial_margin_pct = 1 / leverage
    distance_to_liquidation_pct = initial_margin_pct - maintenance_margin_pct
    if action == "BUY":
        return entry_price * (1 - distance_to_liquidation_pct)
    return entry_price * (1 + distance_to_liquidation_pct)  # SELL - liquidates above entry


def _tiered_liquidation_rate(leverage: float) -> float:
    for tier_leverage, rate in FUTURES_TIERED_LIQUIDATION_RATE:
        if leverage <= tier_leverage:
            return rate
    return FUTURES_TIERED_LIQUIDATION_RATE[-1][1]  # leverage exceeds every documented tier - closest available assumption


def compute_futures_liquidation_fee(symbol: str, notional: float, leverage: float) -> float:
    """Rule C, futures - the flat per-asset rate if `symbol` resolves to one
    of BTC/ETH/PAXG, else the leverage-tiered rate (see FUTURES_TIERED_
    LIQUIDATION_RATE's own docstring on the approximation involved).
    Replaces the normal close fee entirely for that leg - never charge
    both, see position_manager._evaluate_exits' liquidation branch."""
    asset = asset_from_symbol(symbol)
    rate = FUTURES_FLAT_LIQUIDATION_RATE[asset] if asset is not None else _tiered_liquidation_rate(leverage)
    return rate * notional * (1 + GST_RATE)
