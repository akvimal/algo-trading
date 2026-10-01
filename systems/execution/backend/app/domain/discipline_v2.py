"""Discipline v2 (docs/discipline-v2-spec.md, step 3): a behaviour score built around greed, fear and impatience.

It scores the PROCESS of each closed manual trade, never its profit. Every trade is run through a list of checks; each check
has a score from 0 to 1, a category (risk, entry, management, day) and an emotion it speaks to (greed, fear, patience). A check
that cannot be measured (a trade opened before the data existed, a limit that is not configured) is simply left out, never
guessed. The result is three emotion sub-scores, an overall number over the last 20 trades, the mistakes that cost the most,
and a one-line weekly coaching sentence.

Pure: facts in, scores out. `app/domain/discipline_load.py` builds the facts from the database, and
`what_if_after_exit` is given candles by its caller.
"""

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from app.config import settings

WINDOW_TRADES = 20
MIN_TRADES_FOR_SCORE = 5
CATEGORY_WEIGHTS = {"risk": 30, "management": 30, "entry": 25, "day": 15}
EMOTIONS = ("greed", "fear", "patience")

# Stops/targets set within this long of the entry count as part of the entry plan (the ticket attaches an option order's
# stop and target with a second request right after it opens).
ENTRY_PLAN_WINDOW = timedelta(seconds=90)

_TARGET_EXITS = {"target", "spot_target", "combined_target", "individual_target"}
_STOP_EXITS = {"stop_loss", "spot_stop_loss", "combined_stop_loss", "individual_stop_loss"}
_TOL = 1e-6


@dataclass
class EventFact:
    field: str  # stop_loss / spot_stop_loss / combined_stop_loss / target / spot_target / combined_target
    move: str
    source: str
    accepted: bool
    created_at: datetime
    tight_trail: Optional[bool] = None
    old_price: Optional[float] = None
    new_price: Optional[float] = None

    @property
    def is_stop(self) -> bool:
        return "stop" in self.field

    @property
    def is_target(self) -> bool:
        return "target" in self.field


@dataclass
class TradeFacts:
    id: str
    kind: str  # position | group
    segment: str
    symbol: str
    action: str
    entry_time: datetime
    exit_time: datetime
    exit_reason: Optional[str]
    order_type: Optional[str]
    entry_price: Optional[float]  # the price the stop and target are measured on (the underlying's, for an option group)
    exit_price: Optional[float]
    quantity: Optional[float]
    system_quantity: Optional[float]
    stop0: Optional[float]  # the stop as planned at entry
    target0: Optional[float]  # the target as planned at entry
    stop_final: Optional[float]
    target_final: Optional[float]
    pnl: Optional[float]
    entry_setup_tag: Optional[str]
    reviewed: bool
    auto_traded: bool = False
    entry_interval: Optional[str] = None
    emotion_tag: Optional[str] = None  # calm / fearful / greedy / fomo, answered after a loss or an early exit
    events: list[EventFact] = field(default_factory=list)


@dataclass
class Check:
    key: str
    category: str
    emotion: str
    score: float
    mistake: Optional[str] = None


@dataclass
class TradeScore:
    facts: TradeFacts
    checks: list[Check]
    flags: list[str]
    planned_rr: Optional[float]
    exit_r: Optional[float]
    exit_kind: Optional[str]

    @property
    def score(self) -> Optional[int]:
        if not self.checks:
            return None
        return int(sum(c.score for c in self.checks) / len(self.checks) * 100 + 0.5)

    @property
    def mistakes(self) -> list[str]:
        return [c.mistake for c in self.checks if c.mistake]

    @property
    def needs_emotion(self) -> bool:
        """A loss or an early exit (closed by hand before the plan, or trailed out too tight) with no answer yet to "how did you
        feel?". Never for an auto-traded fill, and never asked of a trade that went to plan."""
        t = self.facts
        if t.auto_traded or t.emotion_tag:
            return False
        return (t.pnl is not None and t.pnl < 0) or self.exit_kind in ("early_exit", "tight_trail")


@dataclass
class DisciplineConfig:
    min_rr: float = 2.0
    cooldown_minutes: int = 15
    max_trades_per_day: int = 6
    daily_loss_limit: Optional[float] = None  # money; None = not configured
    timezone: str = "Asia/Kolkata"

    @classmethod
    def from_settings(cls, min_rr: float, daily_loss_limit: Optional[float]) -> "DisciplineConfig":
        return cls(
            min_rr=min_rr,
            cooldown_minutes=settings.discipline_cooldown_minutes,
            max_trades_per_day=settings.discipline_max_trades_per_day,
            daily_loss_limit=daily_loss_limit,
            timezone=settings.equity_history_timezone,
        )


# ---- plan at entry, from the final values and the move log -------------------------------------------------------------


def plan_at_entry(
    entry_time: datetime, stop_final: Optional[float], target_final: Optional[float], events: list[EventFact]
) -> tuple[Optional[float], Optional[float]]:
    """The stop and target as they stood just after entry, found by rewinding the accepted moves made later than that from the
    final values. Older trades with no log simply keep their final values."""
    stop, target = stop_final, target_final
    for e in sorted(events, key=lambda e: e.created_at, reverse=True):
        if not e.accepted or e.created_at <= entry_time + ENTRY_PLAN_WINDOW:
            continue
        if e.is_stop and e.field in ("stop_loss", "spot_stop_loss"):
            stop = e.old_price
        elif e.is_target and e.field in ("target", "spot_target"):
            target = e.old_price
    return stop, target


# ---- one trade ---------------------------------------------------------------------------------------------------------------


def _signed_r(action: str, entry: float, risk: float, price: float) -> float:
    gained = (price - entry) if action == "BUY" else (entry - price)
    return gained / risk


def _after_entry(t: TradeFacts, accepted_only: bool = True) -> list[EventFact]:
    out = [e for e in t.events if e.created_at > t.entry_time + ENTRY_PLAN_WINDOW and (e.accepted or not accepted_only)]
    return sorted(out, key=lambda e: e.created_at)


def evaluate_trade(t: TradeFacts, cfg: DisciplineConfig) -> TradeScore:
    """The checks that belong to this trade alone. Day-level checks (cooldown, trade cap, ...) are added by evaluate_all."""
    checks: list[Check] = []
    flags: list[str] = []
    after = _after_entry(t)
    refused = [e for e in t.events if not e.accepted and e.is_stop and e.move in ("widen", "clear")]
    stop_moves = [e for e in after if e.is_stop and e.move == "tighten"]
    target_moves = [e for e in after if e.is_target and e.move in ("closer", "further")]

    risk = abs(t.entry_price - t.stop0) if t.entry_price is not None and t.stop0 is not None else None
    if risk is not None and risk <= 0:
        risk = None
    planned_rr = (
        abs(t.target0 - t.entry_price) / risk if risk is not None and t.target0 is not None and t.entry_price is not None else None
    )

    # -- risk and size --
    if t.system_quantity and t.quantity:
        ratio = t.quantity / t.system_quantity
        score = 1.0 if ratio <= 1.0 + _TOL else max(0.0, 1.0 - (ratio - 1.0))
        checks.append(Check("size_adherence", "risk", "greed", score, "oversized" if ratio > 1.05 else None))
        if ratio < 0.5:
            flags.append("undersized")  # turned into a habit penalty by evaluate_all

    # -- entry quality --
    checks.append(Check("stop_planned", "entry", "patience", 1.0 if t.stop0 is not None else 0.0, None if t.stop0 is not None else "no_stop"))
    checks.append(Check("reward_planned", "entry", "patience", 1.0 if t.target0 is not None else 0.5, None if t.target0 is not None else "unplanned_reward"))
    if planned_rr is not None:
        met = planned_rr + _TOL >= cfg.min_rr
        checks.append(Check("rr_met", "entry", "patience", 1.0 if met else max(0.0, min(1.0, planned_rr / cfg.min_rr)) * 0.8, None if met else "low_rr"))
    if t.order_type:
        checks.append(Check("entry_style", "entry", "patience", 1.0 if t.order_type == "limit" else 0.7))
    tagged = bool(t.entry_setup_tag)
    checks.append(Check("setup_tagged", "entry", "patience", 1.0 if tagged else 0.0, None if tagged else "untagged"))

    # -- management --
    exit_r: Optional[float] = None
    exit_kind: Optional[str] = None
    reason = t.exit_reason
    last_trail = stop_moves[-1] if stop_moves else None
    if reason in _TARGET_EXITS:
        exit_kind, ladder, mistake = "target", 1.0, None
        if planned_rr is not None:
            exit_r = planned_rr
    elif reason in _STOP_EXITS:
        if last_trail is None:
            exit_kind, ladder, mistake = "clean_stop", 1.0, None
            exit_r = -1.0 if risk is not None else None
        else:
            if risk is not None and t.stop_final is not None and t.entry_price is not None:
                exit_r = _signed_r(t.action, t.entry_price, risk, t.stop_final)
            rule_based = last_trail.source == "auto_trail" or last_trail.tight_trail is not True
            if planned_rr is None:
                exit_kind, ladder, mistake = "scalp_trail", 1.0, None
            elif exit_r is not None and exit_r >= planned_rr - _TOL:
                exit_kind, ladder, mistake = "trail_beyond_plan", 1.0, None
            elif exit_r is not None and exit_r <= 0:
                exit_kind, ladder, mistake = "trail_loss", 0.9, None
            elif rule_based:
                exit_kind, ladder, mistake = "rule_trail", 0.8, None
            else:
                exit_kind, ladder, mistake = "tight_trail", 0.4, "tight_trail"
    elif reason == "square_off":
        exit_kind, ladder, mistake = "square_off", 1.0, None
    elif reason == "manual":
        if t.exit_price is not None and risk is not None and t.entry_price is not None:
            exit_r = _signed_r(t.action, t.entry_price, risk, t.exit_price)
        if planned_rr is not None and exit_r is not None and exit_r >= planned_rr - _TOL:
            exit_kind, ladder, mistake = "manual_at_plan", 1.0, None
        else:
            exit_kind, ladder, mistake = "early_exit", 0.5, "early_exit"
    elif reason == "liquidation":
        exit_kind, ladder, mistake = "liquidation", 0.0, "liquidated"
    elif reason == "counter_signal":
        exit_kind, ladder, mistake = "counter_signal", 1.0, None
    else:
        exit_kind, ladder, mistake = None, 1.0, None
    if exit_kind is not None:
        checks.append(Check("exit_outcome", "management", "fear", ladder, mistake))

    checks.append(Check("stop_kept", "management", "greed", max(0.0, 1.0 - 0.4 * len(refused)), "widen_attempt" if refused else None))
    pushed = [e for e in target_moves if e.move == "further"]
    pulled = [e for e in target_moves if e.move == "closer"]
    if target_moves or t.target0 is not None:
        checks.append(Check("target_pushed", "management", "greed", max(0.0, 1.0 - 0.3 * len(pushed)), "target_pushed" if pushed else None))
        checks.append(Check("target_pulled", "management", "fear", max(0.0, 1.0 - 0.3 * len(pulled)), "target_pulled" if pulled else None))
    if target_moves and stop_moves:
        flags.append("target_and_stop_moved")

    # -- review --
    checks.append(Check("reviewed", "day", "patience", 1.0 if t.reviewed else 0.0, None if t.reviewed else "no_review"))

    return TradeScore(t, checks, flags, planned_rr, exit_r, exit_kind)


# ---- across trades -----------------------------------------------------------------------------------------------------------


def _local(moment: datetime, tz: str) -> datetime:
    return moment.astimezone(ZoneInfo(tz))


def _off_window(t: TradeFacts, tz: str) -> Optional[bool]:
    """NSE only: the first 10 minutes after the open and the last 15 before the close are no-trade windows."""
    if t.segment != "NSE":
        return None
    local = _local(t.entry_time, tz)
    minutes = local.hour * 60 + local.minute
    return minutes < 9 * 60 + 25 or minutes >= 15 * 60 + 15


def evaluate_all(trades: list[TradeFacts], cfg: DisciplineConfig) -> list[TradeScore]:
    """Scores every trade (oldest first), adding the checks that depend on the trades around it: re-entering soon after a loss,
    too many trades in a day, trading past the day's loss limit, a habit of sizing down, and trade-with-target-and-stop flags."""
    ordered = sorted(trades, key=lambda t: t.entry_time)
    scores = [evaluate_trade(t, cfg) for t in ordered]

    # exits so far, to see what had just happened when each trade was entered
    for i, s in enumerate(scores):
        t = s.facts
        local_day = _local(t.entry_time, cfg.timezone).date()
        earlier = [x.facts for x in scores[:i]]
        same_day_before = [e for e in earlier if _local(e.entry_time, cfg.timezone).date() == local_day]

        recent_loss = any(
            e.pnl is not None and e.pnl < 0 and e.symbol == t.symbol and e.exit_time <= t.entry_time
            and t.entry_time - e.exit_time < timedelta(minutes=cfg.cooldown_minutes)
            for e in earlier
        )
        s.checks.append(Check("cooldown", "day", "patience", 0.0 if recent_loss else 1.0, "revenge" if recent_loss else None))

        off = _off_window(t, cfg.timezone)
        if off is not None:
            s.checks.append(Check("trading_window", "day", "patience", 0.0 if off else 1.0, "off_window" if off else None))

        over = len(same_day_before) + 1 > cfg.max_trades_per_day
        s.checks.append(Check("trade_cap", "day", "greed", 0.0 if over else 1.0, "overtrade" if over else None))

        if cfg.daily_loss_limit is not None:
            lost = -sum(e.pnl for e in same_day_before if e.pnl is not None and e.pnl < 0 and e.exit_time <= t.entry_time)
            breached = lost >= cfg.daily_loss_limit
            s.checks.append(Check("loss_limit", "day", "greed", 0.0 if breached else 1.0, "past_loss_limit" if breached else None))

    # sizing down once is neutral; three times in ten trades is a habit
    for i, s in enumerate(scores):
        if "undersized" in s.flags:
            recent = scores[max(0, i - 9) : i + 1]
            habitual = sum(1 for x in recent if "undersized" in x.flags) >= 3
            s.checks.append(Check("size_habit", "risk", "fear", 0.4 if habitual else 1.0, "undersized_habit" if habitual else None))
        elif s.facts.system_quantity and s.facts.quantity:
            s.checks.append(Check("size_habit", "risk", "fear", 1.0))
    return scores


# ---- the rolling score --------------------------------------------------------------------------------------------------------


def _mean(values: list[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def _pct(x: Optional[float]) -> Optional[int]:
    return None if x is None else int(x * 100 + 0.5)


FEELING_WORD = {"calm": "calm", "fearful": "fearful", "greedy": "greedy", "fomo": "FOMO"}

# What a mistake costs, for choosing the one habit to coach (higher = worse), and the plain-language sentence for it.
SEVERITY = {
    "past_loss_limit": 10, "widen_attempt": 9, "oversized": 8, "liquidated": 8, "no_stop": 8, "revenge": 7, "overtrade": 6,
    "tight_trail": 6, "early_exit": 5, "undersized_habit": 5, "target_pushed": 5, "target_pulled": 4, "low_rr": 4,
    "off_window": 3, "unplanned_reward": 3, "untagged": 2, "no_review": 1,
}
COACHING = {
    "past_loss_limit": "kept trading after your day's loss limit was reached",
    "widen_attempt": "tried to widen a stop that was already live",
    "oversized": "took more size than the system's risk sizing allowed",
    "liquidated": "let a position run to liquidation",
    "no_stop": "entered without a stop",
    "revenge": "re-entered the same instrument right after a loss",
    "overtrade": "took more trades in a day than your cap",
    "tight_trail": "trailed a stop too close to price and got stopped out of winners early",
    "early_exit": "closed a trade by hand before it reached its plan",
    "undersized_habit": "kept sizing well below the system's size after losses",
    "target_pushed": "pushed a target further away while the trade was open",
    "target_pulled": "pulled a target closer while the trade was open",
    "low_rr": "entered trades whose planned reward-to-risk was under your minimum",
    "off_window": "traded inside the first or last minutes of the session",
    "unplanned_reward": "entered without a target",
    "untagged": "did not tag the setup before entering",
    "no_review": "did not review the trade afterwards",
}
MISTAKE_EMOTION = {
    "past_loss_limit": "greed", "widen_attempt": "greed", "oversized": "greed", "liquidated": "greed", "overtrade": "greed",
    "target_pushed": "greed", "tight_trail": "fear", "early_exit": "fear", "undersized_habit": "fear", "target_pulled": "fear",
    "revenge": "patience", "no_stop": "patience", "low_rr": "patience", "off_window": "patience", "unplanned_reward": "patience",
    "untagged": "patience", "no_review": "patience",
}


def summarize(scores: list[TradeScore], now: Optional[datetime] = None) -> dict:
    """The rolling score over the last WINDOW_TRADES trades (auto-traded fills are never scored), the three emotion sub-scores,
    the category rates, the mistake counts and the weekly coaching line."""
    scored = [s for s in scores if not s.facts.auto_traded]
    window = sorted(scored, key=lambda s: s.facts.exit_time)[-WINDOW_TRADES:]

    by_cat: dict[str, list[float]] = {}
    by_emotion: dict[str, list[float]] = {e: [] for e in EMOTIONS}
    for s in window:
        for c in s.checks:
            by_cat.setdefault(c.category, []).append(c.score)
            by_emotion[c.emotion].append(c.score)
    cat_rates = {k: _mean(v) for k, v in by_cat.items()}

    # three trades in the last ten with a target AND a stop moved: a deduction from management
    last_ten = window[-10:]
    flagged = sum(1 for s in last_ten if "target_and_stop_moved" in s.flags)
    deduction = 0.1 if flagged >= 3 else 0.0
    if deduction and cat_rates.get("management") is not None:
        cat_rates["management"] = max(0.0, cat_rates["management"] - deduction)

    parts = [(rate, CATEGORY_WEIGHTS[k]) for k, rate in cat_rates.items() if rate is not None and k in CATEGORY_WEIGHTS]
    total_w = sum(w for _, w in parts)
    overall = sum(r * w for r, w in parts) / total_w if total_w else None
    score = _pct(overall) if len(window) >= MIN_TRADES_FOR_SCORE and overall is not None else None

    counts: Counter = Counter(m for s in window for m in s.mistakes)
    emotion_counts = Counter(s.facts.emotion_tag for s in window if s.facts.emotion_tag)
    if flagged >= 3:
        counts["target_and_stop_moved"] += flagged

    week_cutoff = (now or max((s.facts.exit_time for s in scored), default=datetime.now().astimezone())) - timedelta(days=7)
    week = [s for s in scored if s.facts.exit_time >= week_cutoff]
    week_counts: Counter = Counter(m for s in week for m in s.mistakes)
    coaching = _coaching_line(week_counts, len(week), week)

    return {
        "score": score,
        "trade_count": len(window),
        "emotions": {e: _pct(_mean(by_emotion[e])) for e in EMOTIONS},
        "categories": {k: _pct(v) for k, v in cat_rates.items()},
        "mistakes": dict(counts),
        "week_mistakes": dict(week_counts),
        "target_and_stop_moved": flagged,
        "emotion_counts": dict(emotion_counts),
        "needs_emotion": sum(1 for s in window if s.needs_emotion),
        "coaching": coaching,
    }


def _coaching_line(week_counts: Counter, week_trades: int, week: Optional[list] = None) -> Optional[dict]:
    """One sentence naming the habit that cost the most this week: how often, times how much it hurts. None when the week had
    no trades, or nothing went wrong."""
    if week_trades == 0:
        return None
    ranked = sorted(((SEVERITY.get(m, 1) * n, m, n) for m, n in week_counts.items() if m in COACHING), reverse=True)
    if not ranked:
        return {"mistake": None, "emotion": None, "count": 0, "line": f"A clean week: {week_trades} trade{'s' if week_trades != 1 else ''}, no process mistakes."}
    _, mistake, n = ranked[0]
    times = f"{n} time{'s' if n != 1 else ''}"
    line = f"This week you {COACHING[mistake]} ({times} in {week_trades} trade{'s' if week_trades != 1 else ''}). That is the one habit to work on next."
    # What the person said they felt on those very trades, when they said it on at least two of them.
    felt = Counter(s.facts.emotion_tag for s in (week or []) if mistake in s.mistakes and s.facts.emotion_tag)
    if sum(felt.values()) >= 2:
        feeling, k = felt.most_common(1)[0]
        line += f" You tagged {FEELING_WORD.get(feeling, feeling)} on {k} of the {sum(felt.values())} you answered."
    return {
        "mistake": mistake,
        "emotion": MISTAKE_EMOTION.get(mistake),
        "count": n,
        "line": line,
    }


# ---- what-if after an early exit ----------------------------------------------------------------------------------------------


def what_if_after_exit(t: TradeFacts, risk: Optional[float], candles: list[dict]) -> Optional[dict]:
    """After a trade was closed early (a tight trail or a manual exit), how far did price go in the trade's favour until the end
    of that day? `candles` are the bars from the exit onwards, each with `timestamp`, `high` and `low`. Returns the best
    reward in R and whether the planned target was reached, or None when it cannot be worked out."""
    if t.exit_price is None or t.entry_price is None or risk is None or risk <= 0 or not candles:
        return None
    buy = t.action == "BUY"
    after = []
    for c in candles:
        ts = c.get("timestamp")
        when = datetime.fromisoformat(ts.replace("Z", "+00:00")) if isinstance(ts, str) else ts
        if when is not None and when >= t.exit_time:
            after.append(c)
    if not after:
        return None
    best = max(c["high"] for c in after) if buy else min(c["low"] for c in after)
    extra = ((best - t.exit_price) if buy else (t.exit_price - best)) / risk
    reached = None
    if t.target0 is not None:
        reached = best >= t.target0 if buy else best <= t.target0
    return {"extra_r": round(max(0.0, extra), 2), "target_reached": reached}
