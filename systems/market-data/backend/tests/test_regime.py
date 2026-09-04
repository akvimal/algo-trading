from app.domain.models import Candle
from app.domain.regime import assess_regime, compute_adx


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


def _trending_up(n: int = 80, step: float = 8.0) -> list[Candle]:
    out = []
    price = 100.0
    for i in range(n):
        o = price
        cl = price + step
        out.append(_c(i, o, cl + 1, o - 1, cl))
        price = cl
    return out


def _ranging(n: int = 80, amp: float = 3.0) -> list[Candle]:
    out = []
    base = 100.0
    for i in range(n):
        mid = base + (amp if i % 2 == 0 else -amp)
        out.append(_c(i, base, mid + 1, mid - amp - 1, base + (0.2 if i % 3 else -0.2)))
    return out


def test_adx_is_high_for_a_clean_trend_and_low_for_chop():
    up = compute_adx(_trending_up())
    chop = compute_adx(_ranging())
    assert up > 40
    assert chop < 25
    assert up > chop


def test_assess_regime_labels_a_strong_uptrend():
    r = assess_regime(_trending_up())
    assert r.regime == "trending_up"  # DMI direction drives this (no pullbacks for structure_state)
    assert r.adx >= 25
    assert "with the direction" in r.advice


def test_assess_regime_labels_chop_as_ranging_or_transitional():
    r = assess_regime(_ranging())
    assert r.regime in ("ranging", "transitional")


def test_assess_regime_short_series_is_transitional_with_a_note():
    r = assess_regime([_c(i, 100, 101, 99, 100) for i in range(10)])
    assert r.regime == "transitional"
    assert r.adx == 0.0
    assert "history" in r.advice.lower()
