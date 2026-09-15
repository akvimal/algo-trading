"""Pydantic models mirroring docs/contracts/weekly-recommendation.v1.schema.json.

Keep this file and the JSON schema in sync by hand (matches repo convention of
no codegen / no Alembic — schema is the source of truth, checked by
tests/test_contract_matches_schema.py).
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

Bias = Literal["bullish", "bearish", "neutral"]
TrendStrength = Literal["trending", "decelerating", "ranging"]
AdxSlope = Literal["rising", "falling", "flat"]
OptionType = Literal["CE", "PE"]
BuildupType = Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]
StrategyAction = Literal[
    "sell_otm_put",
    "sell_otm_call",
    "short_strangle",
    "iron_condor",
    "avoid_new_entry",
    "close_existing",
]


class Zone(BaseModel):
    low: float
    high: float
    basis: str = Field(description="e.g. 'weekly EMA50 confluence', 'pivot cluster x3'")


class TrendChannel(BaseModel):
    upper: float
    mid: float
    lower: float
    slope_per_bar: float


class TechnicalSnapshot(BaseModel):
    timeframe: Literal["daily", "weekly"]
    close: float
    ema20: float
    ema50: float
    adx14: float
    adx14_slope: AdxSlope
    atr14: float
    trend_channel: Optional[TrendChannel] = None
    support_zones: list[Zone] = Field(default_factory=list)
    resistance_zones: list[Zone] = Field(default_factory=list)
    volume: float
    volume_sma20: float
    volume_confirmed: bool


class StrikeOI(BaseModel):
    strike: float
    option_type: OptionType
    oi: float
    oi_change: float
    buildup: BuildupType


class OISnapshot(BaseModel):
    available: bool
    pcr: Optional[float] = None
    max_pain: Optional[float] = None
    aggregate_signal: Optional[BuildupType] = None
    by_strike: list[StrikeOI] = Field(default_factory=list)


class FundamentalSnapshot(BaseModel):
    """A screener.in screenshot read (app/domain/weekly_advisor/
    screener_fetch.py) - `available=False` when nothing's been captured/
    analyzed for this symbol yet or the AI read failed this cycle, same
    "available" convention OISnapshot already uses. `fetched_at` is the
    cached screenshot's own capture time (can be well older than this
    recommendation's `as_of` - see weekly_advisor_fundamentals_cache_days),
    not this request's time."""

    available: bool
    bias: Optional[Bias] = None
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    summary: Optional[str] = None
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    fetched_at: Optional[datetime] = None


class CorporateEvent(BaseModel):
    type: Literal["results", "corporate_action", "other"] = "results"
    date: date
    days_to_event: int
    inside_decision_window: bool
    source: str


class RegimeAssessment(BaseModel):
    bias: Bias
    trend_strength: TrendStrength
    confidence: float = Field(ge=0, le=1)
    reasons: list[str] = Field(default_factory=list)


class StrategyLeg(BaseModel):
    option_type: OptionType
    strike: float
    side: Literal["sell", "buy"]
    basis: str


class EntryWindow(BaseModel):
    earliest: date
    latest: date
    days_to_expiry_at_entry: int


class ExitRule(BaseModel):
    target_pct_of_max_profit: float = 0.65
    hard_exit_days_before_expiry: int = 5


class StrategyRecommendation(BaseModel):
    action: StrategyAction
    legs: list[StrategyLeg] = Field(default_factory=list)
    entry_window: EntryWindow
    exit_rule: ExitRule = Field(default_factory=ExitRule)


class GeneratedBy(BaseModel):
    engine_version: str
    ai_model: Optional[str] = None


class WeeklyRecommendation(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    symbol: str
    as_of: datetime
    technical: TechnicalSnapshot
    oi: OISnapshot
    fundamentals: FundamentalSnapshot = Field(default_factory=lambda: FundamentalSnapshot(available=False))
    corporate_event: Optional[CorporateEvent] = None
    regime: RegimeAssessment
    strategy: StrategyRecommendation
    ai_memo: Optional[str] = None
    generated_by: GeneratedBy
