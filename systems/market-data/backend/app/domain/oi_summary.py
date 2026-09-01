"""Aggregates a fetched OptionChain plus per-leg OI-change figures into
GET /options/oi-summary's response - PCR, chain-wide OI-change totals,
ATM IV, and a per-strike breakdown. Pure function, no Dhan/network
dependency (the caller - app/api/routes/options.py - does the actual
chain fetch and per-leg get_oi_changes calls); kept separate from
app/domain/models.py so this aggregation logic is unit-testable without
constructing a provider."""

from typing import Callable, Literal, Optional

from app.domain.models import OptionChain, OptionOiLeg, OptionOiSummary, OptionOiSummaryStrike

# (strike, option_type, current_oi) -> (change_5m, change_15m)
OiChangeLookup = Callable[[float, str, int], tuple[Optional[int], Optional[int]]]
# (strike, option_type, current_price) -> (change_5m, change_15m)
PriceChangeLookup = Callable[[float, str, float], tuple[Optional[float], Optional[float]]]
# (current_spot) -> (change_5m, change_15m) - one series per underlying,
# not per-leg (see DhanProvider.get_spot_price_changes's own docstring).
SpotPriceChangeLookup = Callable[[float], tuple[Optional[float], Optional[float]]]

Buildup = Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]


def _classify_buildup(oi_change_15m: Optional[int], price_change_15m: Optional[float]) -> Optional[Buildup]:
    """Classic OI-vs-price 2x2 read, using the 15m window (steadier than
    5m for a classification meant to hold for a while, not flicker every
    poll tick): OI up + price up = long buildup (fresh longs), OI up +
    price down = short buildup (fresh shorts), OI down + price up = short
    covering (shorts exiting), OI down + price down = long unwinding
    (longs exiting). None whenever either change is unknown or exactly
    flat - nothing to classify yet."""
    if not oi_change_15m or not price_change_15m:
        return None
    if oi_change_15m > 0:
        return "long_buildup" if price_change_15m > 0 else "short_buildup"
    return "short_covering" if price_change_15m > 0 else "long_unwinding"


def build_oi_summary(
    chain: OptionChain,
    oi_changes: OiChangeLookup,
    price_changes: Optional[PriceChangeLookup] = None,
    spot_price_changes: Optional[SpotPriceChangeLookup] = None,
) -> OptionOiSummary:
    total_call_oi = 0
    total_put_oi = 0
    call_chg_5m_sum = 0
    call_chg_5m_complete = True
    call_chg_15m_sum = 0
    call_chg_15m_complete = True
    put_chg_5m_sum = 0
    put_chg_5m_complete = True
    put_chg_15m_sum = 0
    put_chg_15m_complete = True
    atm_call_iv: Optional[float] = None
    atm_put_iv: Optional[float] = None
    strikes: list[OptionOiSummaryStrike] = []

    for row in chain.strikes:
        call_leg: Optional[OptionOiLeg] = None
        put_leg: Optional[OptionOiLeg] = None

        if row.ce is not None:
            chg_5m, chg_15m = oi_changes(row.strike, "CE", row.ce.oi)
            price_chg_15m = price_changes(row.strike, "CE", row.ce.last_price)[1] if price_changes is not None else None
            call_leg = OptionOiLeg(
                oi=row.ce.oi,
                oi_change_5m=chg_5m,
                oi_change_15m=chg_15m,
                implied_volatility=row.ce.implied_volatility,
                last_price=row.ce.last_price,
                volume=row.ce.volume,
                top_bid_price=row.ce.top_bid_price,
                top_ask_price=row.ce.top_ask_price,
                moneyness=row.ce.moneyness,
                price_change_15m=price_chg_15m,
                buildup=_classify_buildup(chg_15m, price_chg_15m),
            )
            total_call_oi += row.ce.oi
            if chg_5m is None:
                call_chg_5m_complete = False
            else:
                call_chg_5m_sum += chg_5m
            if chg_15m is None:
                call_chg_15m_complete = False
            else:
                call_chg_15m_sum += chg_15m
            if row.ce.moneyness == "ATM":
                atm_call_iv = row.ce.implied_volatility

        if row.pe is not None:
            chg_5m, chg_15m = oi_changes(row.strike, "PE", row.pe.oi)
            price_chg_15m = price_changes(row.strike, "PE", row.pe.last_price)[1] if price_changes is not None else None
            put_leg = OptionOiLeg(
                oi=row.pe.oi,
                oi_change_5m=chg_5m,
                oi_change_15m=chg_15m,
                implied_volatility=row.pe.implied_volatility,
                last_price=row.pe.last_price,
                volume=row.pe.volume,
                top_bid_price=row.pe.top_bid_price,
                top_ask_price=row.pe.top_ask_price,
                moneyness=row.pe.moneyness,
                price_change_15m=price_chg_15m,
                buildup=_classify_buildup(chg_15m, price_chg_15m),
            )
            total_put_oi += row.pe.oi
            if chg_5m is None:
                put_chg_5m_complete = False
            else:
                put_chg_5m_sum += chg_5m
            if chg_15m is None:
                put_chg_15m_complete = False
            else:
                put_chg_15m_sum += chg_15m
            if row.pe.moneyness == "ATM":
                atm_put_iv = row.pe.implied_volatility

        strikes.append(OptionOiSummaryStrike(strike=row.strike, call=call_leg, put=put_leg))

    total_call_oi_change_15m = call_chg_15m_sum if call_chg_15m_complete else None
    total_put_oi_change_15m = put_chg_15m_sum if put_chg_15m_complete else None
    # Chain-wide (TOTAL call/put OI) buildup, classified against the
    # UNDERLYING's own spot-price direction - not any one leg's premium,
    # which OptionOiLeg.buildup already uses (see _classify_buildup's own
    # docstring for the 2x2 read; this is the same classification, just a
    # different price reference for a figure that's a sum across many
    # strikes' worth of OI rather than one strike's own reading). None
    # whenever spot_price_changes isn't supplied at all (unit tests that
    # don't care about this) or hasn't warmed up yet.
    spot_change_15m = spot_price_changes(chain.underlying_last_price)[1] if spot_price_changes is not None else None
    total_call_buildup = _classify_buildup(total_call_oi_change_15m, spot_change_15m)
    total_put_buildup = _classify_buildup(total_put_oi_change_15m, spot_change_15m)

    return OptionOiSummary(
        underlying_symbol=chain.underlying_symbol,
        underlying_exchange=chain.underlying_exchange,
        expiry=chain.expiry,
        underlying_last_price=chain.underlying_last_price,
        total_call_oi=total_call_oi,
        total_put_oi=total_put_oi,
        pcr=(total_put_oi / total_call_oi) if total_call_oi > 0 else None,
        total_call_oi_change_5m=call_chg_5m_sum if call_chg_5m_complete else None,
        total_put_oi_change_5m=put_chg_5m_sum if put_chg_5m_complete else None,
        total_call_oi_change_15m=total_call_oi_change_15m,
        total_put_oi_change_15m=total_put_oi_change_15m,
        total_call_buildup=total_call_buildup,
        total_put_buildup=total_put_buildup,
        atm_call_iv=atm_call_iv,
        atm_put_iv=atm_put_iv,
        strikes=strikes,
    )
