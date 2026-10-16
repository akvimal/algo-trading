from app.domain import oi_alert_outcomes as o


def test_moves_are_measured_from_the_alert_nights_close_and_missing_bars_stay_unknown():
    assert o.pct_moves(100.0, [101.0, 99.0, 103.0]) == [1.0, -1.0, 3.0]
    assert o.pct_moves(100.0, [101.0]) == [1.0, None, None]
    assert o.pct_moves(None, [101.0]) == [None, None, None] and o.pct_moves(100.0, []) == [None, None, None]


def test_a_bearish_alert_is_right_when_the_price_falls():
    assert o.signed("bearish", [-2.0, 1.0, None]) == [2.0, -1.0, None]
    assert o.signed("bullish", [-2.0, 1.0, None]) == [-2.0, 1.0, None]


def test_the_market_comparison_needs_enough_stocks_per_horizon():
    many = [[1.0, 2.0, None]] * 25
    assert o.market_moves(many) == [1.0, 2.0, None]
    assert o.market_moves(many[:5]) == [None, None, None]
