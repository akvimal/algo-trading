"""Indian trading charges for paper P&L (NSE and MCX).

A paper P&L that ignores brokerage, STT and the rest is flattering: a scalper
who nets +Rs 300 on gross can be net negative once the charges are paid. Crypto
already simulates Delta's fees (delta_fees.py); NSE/MCX had none. This computes
the round-trip charges for one position (or one option group) from its legs.

RATES ARE DATA, NOT LAW. They were checked on 2026-09-25 against Zerodha's
published charges table, Zerodha's bulletin on the STT revision, and Dhan's pricing
page (Dhan is the platform's broker). That is a SECONDARY source for the statutory
parts (STT/CTT, exchange, SEBI, stamp duty): compare against the NSE/MCX/SEBI
circulars before anyone relies on the numbers for anything but paper P&L. The big
change that caught the previous table out: STT on F&O was raised on 1 April 2026
(futures 0.02% -> 0.05% on sell, options 0.10% -> 0.15% on the premium on sell).
These rates are "as of today": a trade that closed before a rate change was charged
under the older schedule in real life, and paper trades are always priced at the
current one. Bump SCHEDULE_VERSION when you edit them. The breakdown stored on each
closed position records the version it was computed under, so old trades stay
explainable after a rate change.

Per leg (one leg = one executed order), on that leg's turnover (price x qty):
  brokerage  Dhan's model: equity intraday min(Rs 20, 0.03% of turnover) per order;
             futures and options (NSE and MCX) a flat Rs 20 per order; equity
             delivery none
  STT / CTT  on the buy and/or sell side, by kind
  exchange   transaction charge, both sides
  SEBI       turnover fee, both sides
  stamp duty buy side only
  DP         equity delivery SELL only: Rs 12.50 per instruction (Dhan)
  GST        18% of (brokerage + exchange + SEBI + DP)
Not modelled: IPFT, the exact per-exchange rounding, agricultural MCX contracts
(SEBI fee Rs 1/crore instead of Rs 10/crore), option exercise STT (a paper position
is always closed by a trade), currency derivatives, and partial-close order
counting (each partially closed piece is charged as its own round trip, so a
partial close slightly overstates the flat brokerage and DP charge).
"""

from dataclasses import dataclass
from typing import Optional

SCHEDULE_VERSION = "2026-09-25.1"

GST_RATE = 0.18

NSE_EQUITY_INTRADAY = "nse_equity_intraday"
NSE_EQUITY_DELIVERY = "nse_equity_delivery"
NSE_FUTURES = "nse_futures"
NSE_OPTIONS = "nse_options"
MCX_FUTURES = "mcx_futures"
MCX_OPTIONS = "mcx_options"


@dataclass(frozen=True)
class Rates:
    brokerage_pct: Optional[float]  # fraction of turnover; None = flat fee only
    brokerage_flat: float  # rupees per order (the cap when brokerage_pct is set)
    tax_buy: float  # STT/CTT fraction on buy turnover
    tax_sell: float  # STT/CTT fraction on sell turnover
    exchange: float  # transaction charge fraction, both sides
    sebi: float  # SEBI turnover fee fraction, both sides
    stamp_buy: float  # stamp duty fraction, buy side
    dp_sell: float = 0.0  # rupees per delivery SELL instruction (a depository charge)


# Fractions of turnover (0.0003 = 0.03%). Checked 2026-09-25, see the module docstring.
RATES: dict[str, Rates] = {
    NSE_EQUITY_INTRADAY: Rates(0.0003, 20.0, 0.0, 0.00025, 0.0000307, 0.000001, 0.00003),
    NSE_EQUITY_DELIVERY: Rates(None, 0.0, 0.001, 0.001, 0.0000307, 0.000001, 0.00015, dp_sell=12.5),
    NSE_FUTURES: Rates(None, 20.0, 0.0, 0.0005, 0.0000183, 0.000001, 0.00002),
    NSE_OPTIONS: Rates(None, 20.0, 0.0, 0.0015, 0.0003553, 0.000001, 0.00003),
    MCX_FUTURES: Rates(None, 20.0, 0.0, 0.0001, 0.000021, 0.000001, 0.00002),
    MCX_OPTIONS: Rates(None, 20.0, 0.0, 0.0005, 0.000418, 0.000001, 0.00003),
}


@dataclass(frozen=True)
class Breakdown:
    brokerage: float = 0.0
    tax: float = 0.0  # STT / CTT
    exchange: float = 0.0
    sebi: float = 0.0
    stamp: float = 0.0
    gst: float = 0.0
    dp: float = 0.0  # depository charge (delivery sells)

    @property
    def total(self) -> float:
        return self.brokerage + self.tax + self.exchange + self.sebi + self.stamp + self.gst + self.dp

    def __add__(self, other: "Breakdown") -> "Breakdown":
        return Breakdown(
            self.brokerage + other.brokerage,
            self.tax + other.tax,
            self.exchange + other.exchange,
            self.sebi + other.sebi,
            self.stamp + other.stamp,
            self.gst + other.gst,
            self.dp + other.dp,
        )

    def as_dict(self) -> dict:
        """Rounded to paise, plus the schedule version it was computed under."""
        return {
            "brokerage": round(self.brokerage, 2),
            "tax": round(self.tax, 2),
            "exchange": round(self.exchange, 2),
            "sebi": round(self.sebi, 2),
            "stamp": round(self.stamp, 2),
            "gst": round(self.gst, 2),
            "dp": round(self.dp, 2),
            "total": round(self.total, 2),
            "schedule": SCHEDULE_VERSION,
        }


def kind_for(segment: str, instrument_type: str, horizon: Optional[str]) -> Optional[str]:
    """Which charge schedule applies, or None when charges are not modelled
    (crypto has its own fee simulation, see delta_fees.py). NSE cash equity is
    intraday only when the position is intraday, otherwise delivery (this also
    covers NSE MTF, whose interest is charged separately). MCX has no cash
    market, so a stray 'spot' there is treated as futures."""
    if segment == "NSE":
        if instrument_type == "spot":
            return NSE_EQUITY_INTRADAY if horizon == "intraday" else NSE_EQUITY_DELIVERY
        if instrument_type == "future":
            return NSE_FUTURES
        if instrument_type == "option":
            return NSE_OPTIONS
    if segment == "MCX":
        if instrument_type == "option":
            return MCX_OPTIONS
        return MCX_FUTURES
    return None


def leg_charges(kind: str, side: str, turnover: float) -> Breakdown:
    """Charges for ONE executed order of `turnover` rupees on `side` (BUY/SELL)."""
    if turnover <= 0:
        return Breakdown()
    r = RATES[kind]
    if r.brokerage_pct is None:
        brokerage = r.brokerage_flat
    else:
        brokerage = min(r.brokerage_flat, r.brokerage_pct * turnover) if r.brokerage_flat > 0 else r.brokerage_pct * turnover
    tax = turnover * (r.tax_buy if side == "BUY" else r.tax_sell)
    exchange = turnover * r.exchange
    sebi = turnover * r.sebi
    stamp = turnover * r.stamp_buy if side == "BUY" else 0.0
    dp = r.dp_sell if side == "SELL" else 0.0
    gst = GST_RATE * (brokerage + exchange + sebi + dp)
    return Breakdown(brokerage, tax, exchange, sebi, stamp, gst, dp)


def _opposite(side: str) -> str:
    return "SELL" if side == "BUY" else "BUY"


def round_trip_charges(kind: str, open_side: str, entry_price: float, exit_price: float, quantity: float) -> Breakdown:
    """Entry order on `open_side`, then the opposite order to close."""
    return leg_charges(kind, open_side, entry_price * quantity) + leg_charges(kind, _opposite(open_side), exit_price * quantity)


def group_charges(kind: str, legs: list[tuple[str, float, float, float]]) -> Breakdown:
    """An option group: sum of each leg's round trip. `legs` is a list of
    (open_side, entry_price, exit_price, quantity)."""
    total = Breakdown()
    for open_side, entry_price, exit_price, quantity in legs:
        total = total + round_trip_charges(kind, open_side, entry_price, exit_price, quantity)
    return total
