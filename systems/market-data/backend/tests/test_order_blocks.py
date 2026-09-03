"""Tests for app/domain/order_blocks.py - the pure OHLC SMC structure
detectors behind GET /order-blocks (order blocks, breakers, fair value
gaps, BOS/CHoCH trend state). Plain synthetic candle series, no
provider/network (same "plain fakes" convention the rest of this
backend's tests use)."""

from app.domain.models import Candle
from app.domain.order_blocks import detect_fvgs, detect_order_blocks, structure_state


def _c(i: int, o: float, h: float, lo: float, cl: float) -> Candle:
    return Candle(
        exchange="NSE",
        symbol="NIFTY",
        interval="15min",
        open=o,
        high=h,
        low=lo,
        close=cl,
        volume=1000,
        timestamp=f"bar-{i:03d}",
        provider="fake",
    )


def _flat(count: int, start: int = 0, base: float = 100.0) -> list[Candle]:
    """`count` doji-ish candles tight around `base` - fills the Donchian
    window so a later break is unambiguous."""
    return [_c(start + i, base, base + 0.4, base - 0.4, base) for i in range(count)]


def _doji(i: int, price: float) -> Candle:
    return _c(i, price, price, price, price)


def test_detects_a_demand_zone_after_bullish_break():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 100.1, 98.9, 99.0))  # the down candle = order block
    candles.append(_c(23, 99.0, 102.5, 99.0, 102.3))  # impulse that closes above the prior 20-bar high (100.4)
    candles += _flat(5, start=24, base=102.0)  # stays above the zone - unmitigated

    blocks = detect_order_blocks(candles, lookback=20)

    assert len(blocks) == 1
    ob = blocks[0]
    assert ob.kind == "demand"
    assert ob.origin_timestamp == "bar-022"
    assert ob.proximal == 100.1  # top of the OB candle
    assert ob.distal == 98.9  # bottom
    assert ob.mitigated is False


def test_detects_a_supply_zone_after_bearish_break():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 101.1, 99.9, 101.0))  # the up candle = order block
    candles.append(_c(23, 101.0, 101.0, 97.5, 97.7))  # impulse closing below the prior 20-bar low (99.6)
    candles += _flat(5, start=24, base=98.0)

    blocks = detect_order_blocks(candles, lookback=20)

    assert len(blocks) == 1
    assert blocks[0].kind == "supply"
    assert blocks[0].proximal == 99.9  # bottom of the OB candle (nearer to price on the way down)
    assert blocks[0].distal == 101.1
    assert blocks[0].mitigated is False


def test_zone_marked_mitigated_when_price_wicks_back_in():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 100.1, 98.9, 99.0))
    candles.append(_c(23, 99.0, 102.5, 99.0, 102.3))
    candles.append(_c(24, 102.0, 102.2, 100.05, 101.5))  # low dips to 100.05 <= proximal 100.1 -> mitigated
    candles += _flat(3, start=25, base=101.5)

    blocks = detect_order_blocks(candles, lookback=20)

    assert len(blocks) == 1
    assert blocks[0].mitigated is True


def test_zone_dropped_when_price_closes_through_it():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 100.1, 98.9, 99.0))
    candles.append(_c(23, 99.0, 102.5, 99.0, 102.3))
    candles.append(_c(24, 102.0, 102.2, 98.0, 98.2))  # closes 98.2 < distal 98.9 -> demand invalidated
    candles += _flat(3, start=25, base=98.0)

    blocks = detect_order_blocks(candles, lookback=20)

    assert not any(b.kind == "demand" for b in blocks)  # the bar-022 demand zone is gone


def test_body_mode_uses_open_close_not_wicks():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 100.8, 98.2, 99.3))  # wide wicks, body only 99.3-100.0
    candles.append(_c(23, 99.3, 102.5, 99.3, 102.3))
    candles += _flat(5, start=24, base=102.0)

    blocks = detect_order_blocks(candles, lookback=20, zone_mode="body")

    assert len(blocks) == 1
    assert blocks[0].proximal == 100.0
    assert blocks[0].distal == 99.3


def test_a_fresh_zone_has_role_orderblock():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 100.1, 98.9, 99.0))
    candles.append(_c(23, 99.0, 102.5, 99.0, 102.3))
    candles += _flat(5, start=24, base=102.0)

    assert detect_order_blocks(candles, lookback=20)[0].role == "orderblock"


def test_keep_breakers_flips_a_broken_demand_zone_into_a_supply_breaker():
    # OB candle's low (99.7) is ABOVE the window low (99.0, bar 23), so
    # breaking below the zone doesn't also break structure.
    candles = _flat(22)
    candles.append(_c(22, 100.0, 100.1, 99.7, 99.0))  # demand OB, zone 99.7-100.1
    candles.append(_c(23, 99.0, 102.0, 99.0, 101.8))  # bullish break (also the window low)
    candles.append(_c(24, 100.0, 100.2, 99.5, 99.65))  # cl 99.65 < 99.7 zone bottom, > 99.0 window low
    candles += _flat(6, start=25, base=99.0)  # h 99.4 < 99.7 - breaker not retested/reclaimed

    assert detect_order_blocks(candles, lookback=20) == []

    breakers = detect_order_blocks(candles, lookback=20, keep_breakers=True)
    assert len(breakers) == 1
    b = breakers[0]
    assert b.role == "breaker"
    assert b.kind == "supply"  # was demand, flipped
    assert b.proximal == 99.7  # the edge price broke through, nearer to price (now below)
    assert b.distal == 100.1


def test_breaker_dropped_when_price_reclaims_the_other_side():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 100.1, 99.7, 99.0))
    candles.append(_c(23, 99.0, 102.0, 99.0, 101.8))
    candles.append(_c(24, 100.0, 100.2, 99.5, 99.65))  # demand broken -> supply breaker (top 100.1)
    candles.append(_c(25, 99.6, 100.3, 99.6, 100.3))  # cl 100.3 > 100.1 breaker top, < 102 window high
    candles += _flat(3, start=26, base=100.3)

    assert detect_order_blocks(candles, lookback=20, keep_breakers=True) == []


def test_detect_fvgs_finds_a_bullish_gap_and_drops_a_gapless_series():
    assert detect_fvgs([_doji(i, 100.0) for i in range(12)]) == []

    c = [_doji(i, 100.0) for i in range(6)]
    c.append(_c(6, 100.0, 103.0, 99.9, 102.5))   # displacement up (k)
    c.append(_c(7, 102.5, 103.0, 101.0, 102.5))  # k+1: low 101.0 > k-1 high 100.0 -> gap [100.0, 101.0]
    c += [_doji(i, 102.5) for i in range(8, 12)]

    fvgs = detect_fvgs(c, min_gap_atr=0.0)
    assert len(fvgs) == 1
    assert fvgs[0].kind == "bullish"
    assert fvgs[0].bottom == 100.0
    assert fvgs[0].top == 101.0
    assert fvgs[0].origin_timestamp == "bar-006"
    assert fvgs[0].filled is False


def test_detect_fvgs_marks_filled_and_drops_a_gap_closed_through():
    base = [_doji(i, 100.0) for i in range(6)]
    base.append(_c(6, 100.0, 103.0, 99.9, 102.5))
    base.append(_c(7, 102.5, 103.0, 101.0, 102.5))  # bullish gap [100.0, 101.0] at bar-006

    tapped = base + [_c(8, 102.5, 102.5, 100.5, 101.0)] + [_doji(i, 101.0) for i in range(9, 12)]
    assert detect_fvgs(tapped, min_gap_atr=0.0)[0].filled is True  # low 100.5 <= top 101.0

    closed = base + [_c(8, 101.0, 101.0, 99.0, 99.5)] + [_doji(i, 99.5) for i in range(9, 12)]
    assert not any(f.kind == "bullish" for f in detect_fvgs(closed, min_gap_atr=0.0))  # close 99.5 < bottom 100.0


def _spike(i: int, base: float, kind: str, extreme: float) -> Candle:
    """A doji at `base` with one long wick reaching `extreme` - a swing
    high ('h') or low ('l')."""
    if kind == "h":
        return _c(i, base, extreme, base, base)
    return _c(i, base, base, extreme, base)


def test_structure_state_choch_up_bos_up_choch_down_bos_down():
    c: list[Candle] = [_doji(i, 100.0) for i in range(3)]
    c.append(_spike(3, 100.0, "h", 104.0))                # swing high H1 = 104 (confirmed at bar 5)
    c += [_doji(4, 101.0), _spike(5, 101.0, "l", 98.0)]   # swing low L1 = 98
    c += [_doji(6, 100.0), _doji(7, 100.0)]
    c.append(_c(8, 103.0, 106.0, 103.0, 106.0))           # close 106 > H1 -> first break: CHoCH up
    c += [_doji(9, 104.0), _spike(10, 104.0, "l", 101.0)] # swing low L2 = 101 (confirmed at bar 12)
    c += [_doji(11, 103.0), _doji(12, 103.0)]
    c.append(_spike(13, 103.0, "h", 108.0))               # swing high H2 = 108 (confirmed at bar 15)
    c += [_doji(14, 106.0), _doji(15, 106.0)]
    c.append(_c(16, 106.0, 112.0, 106.0, 112.0))          # close 112 > H2, last break up -> BOS up (trend up)
    c += [_doji(17, 110.0), _doji(18, 110.0)]
    c.append(_c(19, 110.0, 110.0, 95.0, 95.0))            # close 95 < L2 (101), last break up -> CHoCH down
    c += [_doji(20, 96.0), _doji(21, 96.0)]
    c.append(_spike(22, 96.0, "l", 93.0))                 # swing low L3 = 93 (confirmed at bar 24)
    c += [_doji(23, 95.0), _doji(24, 95.0)]
    c.append(_c(25, 95.0, 95.0, 90.0, 90.0))              # close 90 < L3, last break down -> BOS down

    trend, events = structure_state(c, swing_lookback=2)

    assert [(e.kind, e.direction) for e in events] == [
        ("choch", "up"),
        ("bos", "up"),
        ("choch", "down"),
        ("bos", "down"),
    ]
    assert events[1].price == 108.0  # the BOS-up broke H2
    assert trend == "down"  # confirmed by the BOS-down


def test_structure_state_reports_range_after_a_choch_with_no_confirming_bos():
    c: list[Candle] = [_doji(i, 100.0) for i in range(3)]
    c.append(_spike(3, 100.0, "h", 104.0))
    c += [_doji(4, 101.0), _spike(5, 101.0, "l", 98.0)]
    c += [_doji(6, 100.0), _doji(7, 100.0)]
    c.append(_c(8, 103.0, 106.0, 103.0, 106.0))           # CHoCH up
    c += [_doji(9, 104.0), _spike(10, 104.0, "l", 101.0)]
    c += [_doji(11, 103.0), _doji(12, 103.0)]
    c.append(_spike(13, 103.0, "h", 108.0))
    c += [_doji(14, 106.0), _doji(15, 106.0)]
    c.append(_c(16, 106.0, 112.0, 106.0, 112.0))          # BOS up -> trend up
    c += [_doji(17, 110.0), _doji(18, 110.0)]
    c.append(_c(19, 110.0, 110.0, 95.0, 95.0))            # CHoCH down -> clears the uptrend, no BOS down yet

    trend, _events = structure_state(c, swing_lookback=2)
    assert trend == "range"


def test_structure_state_is_range_for_a_flat_or_tiny_series():
    assert structure_state([_doji(i, 100.0) for i in range(40)], swing_lookback=2) == ("range", [])
    assert structure_state([_doji(i, 100.0) for i in range(4)], swing_lookback=5) == ("range", [])


def test_counter_trend_tags_zones_opposing_the_trend():
    candles = _flat(22)
    candles.append(_c(22, 100.0, 101.1, 99.9, 101.0))  # up candle -> supply OB after the bearish break
    candles.append(_c(23, 101.0, 101.0, 97.5, 97.7))
    candles += _flat(5, start=24, base=98.0)

    assert detect_order_blocks(candles, lookback=20)[0].counter_trend is False  # trend defaults to "range"
    assert detect_order_blocks(candles, lookback=20, trend="up")[0].counter_trend is True  # supply vs uptrend
    assert detect_order_blocks(candles, lookback=20, trend="down")[0].counter_trend is False


def test_returns_empty_for_a_series_shorter_than_the_window():
    assert detect_order_blocks(_flat(10), lookback=20) == []


def test_max_zones_caps_and_keeps_most_recent():
    candles = _flat(20)
    idx = 20
    # Three separate demand setups at rising price levels.
    for base in (100.0, 110.0, 120.0):
        candles.append(_c(idx, base, base + 0.1, base - 1.1, base - 1.0))
        candles.append(_c(idx + 1, base - 1.0, base + 3.0, base - 1.0, base + 2.8))
        candles += _flat(20, start=idx + 2, base=base + 2.5)
        idx = len(candles)

    blocks = detect_order_blocks(candles, lookback=20, max_zones=2)

    assert len(blocks) == 2
    # oldest-first in the result, most-recent kept when trimming
    assert [b.origin_timestamp for b in blocks] == sorted(b.origin_timestamp for b in blocks)
    assert blocks[-1].proximal > blocks[0].proximal
