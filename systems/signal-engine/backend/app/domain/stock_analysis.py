"""One stock's combined read: what its price chart says (weekly and daily trend, strength, volume, support and resistance, order blocks)
next to what its business says (the AI's read of its screener.in page), folded into one verdict a person can take in at a glance.

The technical side reuses the Weekly Advisor's own engine (app/domain/weekly_advisor/regime_engine.py's weighted votes and
pipeline.py's snapshots), so the two screens never disagree about the same stock. The fundamental side is the cached AI read
(screener_fetch.py). Putting them together is plain rules, not another model call: it is free, instant and can be checked.

`build_analysis` is pure (snapshots in, analysis out); `analyze_stock` is the part that fetches."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.adapters.market_data import client as market_data_client
from app.domain.weekly_advisor import regime_engine as regime
from app.domain.weekly_advisor.contracts import FundamentalSnapshot, OISnapshot, TechnicalSnapshot, Zone
from app.domain.weekly_advisor.pipeline import EXCHANGE, _fetch_order_blocks, build_technical_snapshot
from app.domain.weekly_advisor.regime_engine import OrderBlockZone
from app.domain.weekly_advisor.screener_fetch import FundamentalAnalysis

Bias = Literal["bullish", "bearish", "neutral"]
Agreement = Literal["aligned", "mixed", "conflicting", "technical_only"]

MIN_BARS = 50
# A support or resistance zone further than this from the price says little about where it goes next, so it is not drawn.
MAX_LEVEL_DISTANCE_PCT = 30.0


class Level(BaseModel):
    low: float
    high: float
    basis: str
    timeframe: Literal["weekly", "daily"]
    distance_pct: float = Field(description="How far the zone's near edge is from the price, as a percentage of the price.")


class SignalPoint(BaseModel):
    category: str
    direction: Optional[Bias] = None
    text: str


class TechnicalView(BaseModel):
    bias: Bias
    confidence: float = Field(ge=0, le=1)
    trend_strength: Literal["trending", "decelerating", "ranging"]
    points: list[str] = Field(default_factory=list)
    support: list[Level] = Field(default_factory=list)
    resistance: list[Level] = Field(default_factory=list)


class FundamentalView(BaseModel):
    available: bool
    bias: Optional[Bias] = None
    confidence: Optional[float] = None
    summary: Optional[str] = None
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    fetched_at: Optional[datetime] = None
    # Why there is none, in words, when `available` is false (no key yet, the page could not be read...).
    note: Optional[str] = None
    # True when the only thing missing is the person's OpenRouter key, so the page can point them to Settings.
    needs_key: bool = False


class Verdict(BaseModel):
    bias: Bias
    confidence: float = Field(ge=0, le=1)
    agreement: Agreement
    headline: str
    reading: str


class StockAnalysis(BaseModel):
    symbol: str
    as_of: date
    price: float
    verdict: Verdict
    technical: TechnicalView
    fundamental: FundamentalView
    signals: list[SignalPoint] = Field(default_factory=list)


# ---- the verdict, in words ------------------------------------------------------------------------------------------------------------

_HEADLINES: dict[tuple[str, str], str] = {
    ("bullish", "bullish"): "The trend and the business both point up",
    ("bullish", "bearish"): "Price is rising, but the business case is weak",
    ("bullish", "neutral"): "The trend is up; the business read is mixed",
    ("bearish", "bullish"): "The business looks good, but the trend is down",
    ("bearish", "bearish"): "The trend and the business both point down",
    ("bearish", "neutral"): "The trend is down; the business read is mixed",
    ("neutral", "bullish"): "No clear trend yet, but the business looks good",
    ("neutral", "bearish"): "No clear trend, and the business case is weak",
    ("neutral", "neutral"): "No clear edge from the chart or the business",
}
_TECH_ONLY = {"bullish": "The trend is up (business read not available)", "bearish": "The trend is down (business read not available)", "neutral": "No clear trend (business read not available)"}


def agreement_of(technical: str, fundamental: Optional[str]) -> Agreement:
    """Whether the chart and the business tell the same story: aligned (both lean the same way), conflicting (they lean opposite ways),
    mixed (one of them has no lean), or technical_only (no business read to compare)."""
    if fundamental is None:
        return "technical_only"
    if "neutral" in (technical, fundamental):
        return "mixed"
    return "aligned" if technical == fundamental else "conflicting"


_READING: dict[str, str] = {
    "aligned": "The chart and the business agree, which is a stronger picture than either one alone.",
    "conflicting": "The chart and the business disagree. A move can still happen, but the case for it is weaker, so size and expectations should be smaller.",
    "mixed": "Only one of the two leans a direction. It is a lower-conviction read until the other side firms up.",
    "technical_only": "This is the chart only. Add an OpenRouter key in Settings to bring in the business read.",
}


def verdict_of(tech: Bias, fund: Optional[Bias], overall_bias: Bias, overall_conf: float, trend_strength: str) -> Verdict:
    agreement = agreement_of(tech, fund)
    headline = _TECH_ONLY[tech] if fund is None else _HEADLINES[(tech, fund)]
    reading = _READING[agreement]
    if trend_strength == "ranging":
        reading += " The chart is range-bound, so any lean is less reliable."
    return Verdict(bias=overall_bias, confidence=overall_conf, agreement=agreement, headline=headline, reading=reading)


# ---- the chart, in plain words ----------------------------------------------------------------------------------------------------------

def _adx_phrase(t: TechnicalSnapshot) -> str:
    if t.adx14 >= 25:
        word = "strong"
    elif t.adx14 >= 20:
        word = "moderate"
    else:
        word = "weak (range-bound)"
    return f"Trend strength is {word} (ADX {t.adx14:.0f}, {t.adx14_slope})"


def technical_points(weekly: TechnicalSnapshot, daily: TechnicalSnapshot, extra: list[str]) -> list[str]:
    points = [
        f"Weekly: price is {'above' if weekly.close > weekly.ema50 else 'below'} its 50-week average",
        f"Daily: price is {'above' if daily.close > daily.ema50 else 'below'} its 50-day average",
        _adx_phrase(weekly),
        "Volume is above its 20-bar average" if daily.volume_confirmed else "Volume is light against its 20-bar average",
    ]
    return points + extra


def _levels(zones: list[Zone], price: float, side: str, timeframe: str) -> list[Level]:
    out: list[Level] = []
    for z in zones:
        if side == "below" and z.high <= price:
            out.append(Level(low=z.low, high=z.high, basis=z.basis, timeframe=timeframe, distance_pct=round((price - z.high) / price * 100, 1)))
        elif side == "above" and z.low >= price:
            out.append(Level(low=z.low, high=z.high, basis=z.basis, timeframe=timeframe, distance_pct=round((z.low - price) / price * 100, 1)))
    return out


def nearest_levels(weekly: TechnicalSnapshot, daily: TechnicalSnapshot, price: float, count: int = 2) -> tuple[list[Level], list[Level]]:
    """The closest support zones under the price and resistance zones over it, from both timeframes, nearest first (a zone that overlaps one
    already taken is dropped, so the same band is not listed twice)."""

    def pick(levels: list[Level]) -> list[Level]:
        chosen: list[Level] = []
        for lv in sorted(levels, key=lambda l: l.distance_pct):
            if all(lv.high < c.low or lv.low > c.high for c in chosen):
                chosen.append(lv)
            if len(chosen) == count:
                break
        return chosen

    support = _levels(daily.support_zones, price, "below", "daily") + _levels(weekly.support_zones, price, "below", "weekly")
    resistance = _levels(daily.resistance_zones, price, "above", "daily") + _levels(weekly.resistance_zones, price, "above", "weekly")
    return pick(support), pick(resistance)


def _clean(reason: str) -> str:
    return reason.replace("(daily, half-weight) ", "Daily: ")


def _short(text: str, n: int = 140) -> str:
    text = text.strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


# ---- putting it together ------------------------------------------------------------------------------------------------------------------

def build_analysis(
    symbol: str,
    weekly: TechnicalSnapshot,
    daily: TechnicalSnapshot,
    weekly_blocks: Optional[list[OrderBlockZone]],
    daily_blocks: Optional[list[OrderBlockZone]],
    fundamentals: Optional[FundamentalAnalysis],
    fundamentals_note: Optional[str],
    as_of: date,
    needs_key: bool = False,
) -> StockAnalysis:
    no_oi = OISnapshot(available=False)
    tech = regime.assess_regime(primary=weekly, oi=no_oi, secondary=daily, order_blocks=weekly_blocks, daily_order_blocks=daily_blocks)
    snap: Optional[FundamentalSnapshot] = None
    if fundamentals is not None and fundamentals.bias is not None:
        snap = FundamentalSnapshot(
            available=True, bias=fundamentals.bias, confidence=fundamentals.confidence, summary=fundamentals.summary, pros=fundamentals.pros,
            cons=fundamentals.cons, reasons=fundamentals.reasons, fetched_at=fundamentals.fetched_at,
        )
    overall = regime.assess_regime(
        primary=weekly, oi=no_oi, secondary=daily, order_blocks=weekly_blocks, daily_order_blocks=daily_blocks, fundamental=snap,
    )

    price = daily.close
    all_support, all_resistance = nearest_levels(weekly, daily, price)
    support = [l for l in all_support if l.distance_pct <= MAX_LEVEL_DISTANCE_PCT]
    resistance = [l for l in all_resistance if l.distance_pct <= MAX_LEVEL_DISTANCE_PCT]
    # The structure and order-block votes read well as they are; the trend/ADX ones are restated above in plainer words.
    extra = [_clean(s.reason) for s in tech.signals if s.category in ("structure", "order_blocks") and s.weight > 0]
    # What the missing levels mean is worth saying: no zone above the price means it is at or near its highs; none close below means a long fall to the next shelf.
    if not all_resistance:
        extra.append("Nothing overhead: price is at or near its highs, so there is no resistance to measure against")
    elif not resistance:
        extra.append(f"No resistance close by: the nearest zone is {all_resistance[0].distance_pct:.0f}% above")
    if not support and all_support:
        extra.append(f"No support close by: the nearest zone is {all_support[0].distance_pct:.0f}% below")
    elif not all_support:
        extra.append("No support below: price is near its lows")
    technical = TechnicalView(
        bias=tech.bias, confidence=tech.confidence, trend_strength=tech.trend_strength,
        points=technical_points(weekly, daily, extra), support=support, resistance=resistance,
    )
    if snap is not None:
        fundamental = FundamentalView(
            available=True, bias=snap.bias, confidence=snap.confidence, summary=snap.summary,
            pros=[_short(p) for p in snap.pros[:3]], cons=[_short(c) for c in snap.cons[:3]], reasons=snap.reasons, fetched_at=snap.fetched_at,
        )
    else:
        fundamental = FundamentalView(available=False, note=fundamentals_note or "The business read is not available right now.", needs_key=needs_key)

    signals = [
        SignalPoint(category=s.category, direction=s.direction, text=_clean(s.reason))
        for s in overall.signals
        if s.weight > 0 or s.category == "momentum"
    ]
    verdict = verdict_of(tech.bias, snap.bias if snap is not None else None, overall.bias, overall.confidence, tech.trend_strength)
    return StockAnalysis(symbol=symbol, as_of=as_of, price=price, verdict=verdict, technical=technical, fundamental=fundamental, signals=signals)


class NotEnoughHistory(ValueError):
    """The stock has too little price history for a weekly and a daily read (a new listing, or a symbol that is not an NSE equity)."""


def analyze_stock(
    symbol: str, fundamentals: Optional[FundamentalAnalysis], fundamentals_note: Optional[str], as_of: Optional[date] = None, needs_key: bool = False
) -> StockAnalysis:
    """Fetches the stock's weekly and daily history (and its order blocks) from market-data and builds the combined read. Raises
    NotEnoughHistory when there is too little history; a market-data failure for the order blocks only drops that one vote."""
    as_of = as_of or date.today()
    weekly_bars = market_data_client.get_candle_history(EXCHANGE, symbol, "weekly", as_of - timedelta(days=3 * 365), as_of, source="yahoo")
    daily_bars = market_data_client.get_candle_history(EXCHANGE, symbol, "daily", as_of - timedelta(days=365), as_of, source="yahoo")
    if len(weekly_bars) < MIN_BARS or len(daily_bars) < MIN_BARS:
        raise NotEnoughHistory(f"{symbol} has too little price history for a weekly and daily read ({len(weekly_bars)} weekly and {len(daily_bars)} daily bars; at least {MIN_BARS} of each are needed)")
    weekly = build_technical_snapshot(weekly_bars, "weekly")
    daily = build_technical_snapshot(daily_bars, "daily")
    weekly_blocks = _fetch_order_blocks(symbol, as_of, "weekly", 3 * 365)
    daily_blocks = _fetch_order_blocks(symbol, as_of, "daily", 365)
    return build_analysis(symbol, weekly, daily, weekly_blocks, daily_blocks, fundamentals, fundamentals_note, as_of, needs_key)
