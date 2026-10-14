"""Numbers for messages a person reads: no float noise (133097.25000000003), no needless ".0"."""

from decimal import Decimal
from typing import Union


def num(value: Union[int, float, Decimal]) -> str:
    """Two decimals at most, thousands separated, trailing zeros dropped: 50000.0 -> '50,000', 133097.25000000003 -> '133,097.25'."""
    text = f"{float(value):,.2f}"
    return text.rstrip("0").rstrip(".") if "." in text else text
