"""app/domain/oi_strikes: which strikes of a chain are kept for the intraday OI history, and the row each becomes."""

from app.domain.models import OptionChain, OptionChainStrike, OptionGreeks, OptionLegQuote
from app.domain.oi_strikes import nearest_expiry, strike_rows


def leg(oi, ltp=100.0):
    return OptionLegQuote(
        security_id="1", last_price=ltp, oi=oi, previous_oi=oi - 10, volume=1, implied_volatility=12.5, top_bid_price=ltp - 1, top_ask_price=ltp + 1,
        greeks=OptionGreeks(delta=0.5, theta=-1.0, gamma=0.001, vega=2.0), moneyness="ATM",
    )


def chain(spot, strikes, ce_only=()):
    return OptionChain(
        underlying_symbol="NIFTY", underlying_exchange="NSE", expiry="2026-10-20", underlying_last_price=spot,
        strikes=[OptionChainStrike(strike=k, ce=leg(1000 + i), pe=None if k in ce_only else leg(2000 + i)) for i, k in enumerate(strikes)],
    )


def test_keeps_the_strikes_around_the_one_nearest_the_spot():
    c = chain(24512.0, [24000 + 50 * i for i in range(40)])  # 24000 .. 25950
    rows = strike_rows(c, each_side=3)
    assert [r["strike"] for r in rows] == [24350, 24400, 24450, 24500, 24550, 24600, 24650]
    assert all(r["spot_price"] == 24512.0 and r["expiry"] == "2026-10-20" for r in rows)


def test_a_row_carries_both_sides_oi_price_and_iv():
    row = strike_rows(chain(100.0, [100.0]))[0]
    assert (row["ce_oi"], row["pe_oi"], row["ce_prev_oi"], row["ce_ltp"], row["ce_iv"]) == (1000, 2000, 990, 100.0, 12.5)


def test_a_strike_with_no_put_has_empty_put_figures():
    row = strike_rows(chain(100.0, [100.0], ce_only={100.0}))[0]
    assert row["ce_oi"] == 1000 and row["pe_oi"] is None and row["pe_ltp"] is None


def test_near_the_edge_of_the_chain_it_keeps_what_there_is():
    assert len(strike_rows(chain(24000.0, [24000, 24050, 24100]), each_side=15)) == 3
    assert strike_rows(chain(24000.0, [])) == []


def test_the_nearest_expiry_is_the_earliest():
    assert nearest_expiry(["2026-11-24", "2026-10-20"]) == "2026-10-20"
    assert nearest_expiry([]) is None
