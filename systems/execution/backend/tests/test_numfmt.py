from decimal import Decimal

from app.domain.numfmt import num


def test_drops_float_noise_and_trailing_zeros():
    assert num(133097.25000000003) == "133,097.25"
    assert num(50000.0) == "50,000"
    assert num(33.0) == "33"
    assert num(Decimal("12.50")) == "12.5"
    assert num(0.001) == "0"
