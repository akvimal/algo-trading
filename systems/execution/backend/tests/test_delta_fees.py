import pytest

from app.domain.delta_fees import (
    GST_RATE,
    asset_from_symbol,
    compute_futures_liquidation_fee,
    compute_futures_trading_fee,
    compute_liquidation_price,
    compute_margin_posted,
    compute_option_trading_fee,
)


def test_asset_from_symbol_matches_known_flat_rate_assets():
    assert asset_from_symbol("BTCUSD") == "BTC"
    assert asset_from_symbol("ETHUSD") == "ETH"
    assert asset_from_symbol("PAXGUSD") == "PAXG"


def test_asset_from_symbol_unknown_returns_none():
    assert asset_from_symbol("SOLUSD") is None


def test_compute_futures_trading_fee_applies_gst():
    fee = compute_futures_trading_fee(notional=10_000.0)
    assert fee == pytest.approx(10_000.0 * 0.0005 * (1 + GST_RATE))
    assert fee == pytest.approx(5.90)


def test_compute_option_trading_fee_under_cap():
    # notional small enough that the %-of-notional fee stays under the cap
    fee = compute_option_trading_fee(notional=1_000.0, premium_amount=1_000.0)
    assert fee == pytest.approx(1_000.0 * 0.00010 * (1 + GST_RATE))


def test_compute_option_trading_fee_capped_for_a_cheap_option():
    # Large notional (many lots) against a tiny premium - the %-of-notional
    # fee would exceed a sane fraction of what was actually paid, so the
    # 3.5%-of-premium cap kicks in instead.
    fee = compute_option_trading_fee(notional=1_000_000.0, premium_amount=1.0)
    assert fee == pytest.approx(0.035 * 1.0)


def test_compute_margin_posted_is_notional_over_leverage():
    assert compute_margin_posted(notional=10_000.0, leverage=10) == pytest.approx(1_000.0)


def test_compute_liquidation_price_long_below_entry():
    price = compute_liquidation_price("BUY", entry_price=72_000.0, leverage=10, maintenance_margin_pct=0.005)
    assert price == pytest.approx(72_000.0 * (1 - (0.1 - 0.005)))
    assert price < 72_000.0


def test_compute_liquidation_price_short_above_entry():
    price = compute_liquidation_price("SELL", entry_price=72_000.0, leverage=10, maintenance_margin_pct=0.005)
    assert price == pytest.approx(72_000.0 * (1 + (0.1 - 0.005)))
    assert price > 72_000.0


def test_compute_futures_liquidation_fee_uses_flat_rate_for_known_asset():
    fee = compute_futures_liquidation_fee("BTCUSD", notional=10_000.0, leverage=10)
    assert fee == pytest.approx(10_000.0 * 0.0005 * (1 + GST_RATE))


def test_compute_futures_liquidation_fee_uses_tiered_rate_for_unknown_asset():
    # leverage=15 -> smallest documented tier >= 15 is 20x (0.50%)
    fee = compute_futures_liquidation_fee("SOLUSD", notional=10_000.0, leverage=15)
    assert fee == pytest.approx(10_000.0 * 0.0050 * (1 + GST_RATE))


def test_compute_futures_liquidation_fee_clamps_above_highest_tier():
    # leverage=150 exceeds every documented tier - falls back to 100x's rate
    fee = compute_futures_liquidation_fee("SOLUSD", notional=10_000.0, leverage=150)
    assert fee == pytest.approx(10_000.0 * 0.0010 * (1 + GST_RATE))


def test_worked_example_matches_spec_exactly():
    """BTC futures, $1,000 capital, 10x leverage, entry $72,000 - reproduces
    c:\\Users\\admin\\Downloads\\delta_exchange_fee_liquidation_rules.md
    section 3's own regression case exactly."""
    capital = 1_000.0
    leverage = 10
    entry_price = 72_000.0
    notional = capital * leverage
    assert notional == pytest.approx(10_000.0)

    liquidation_price = compute_liquidation_price("BUY", entry_price, leverage, maintenance_margin_pct=0.005)
    assert liquidation_price == pytest.approx(65_160.0)

    open_fee = compute_futures_trading_fee(notional)
    assert open_fee == pytest.approx(5.90)

    liquidation_fee = compute_futures_liquidation_fee("BTCUSD", notional, leverage)
    assert liquidation_fee == pytest.approx(5.90)

    margin_posted = compute_margin_posted(notional, leverage)
    assert margin_posted == pytest.approx(1_000.0)

    total_cost = margin_posted + open_fee + liquidation_fee
    assert total_cost == pytest.approx(1_011.80)
