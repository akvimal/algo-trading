"""Discipline v2 credentials (docs/discipline-v2-spec.md, section 6): motivation, never a gate.

Each credential rewards one habit over a RUN of trades. The run is the number of qualifying trades in a row, newest backwards,
so one slip drops it and the level with it - a credential always reflects the habit as it is now, never a banked past. The best
run ever is kept too, so a lapse is shown as a lapse ("held Silver, broke the run") rather than as nothing.

What it deliberately does not do: reward profit, volume or trade count; count days traded (a day off never breaks a run); or
connect to anything - it is not an input to the live-trading gate. Auto-traded fills are never counted.

Pure: takes the TradeScores discipline_v2 already computed.
"""

from dataclasses import dataclass
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from app.domain.discipline_v2 import TradeScore

LEVELS = ("bronze", "silver", "gold")

# exit kinds that mean the trade was held to its plan (a stop, a target, a trail that followed the rules, the time exit)
_HELD = {"target", "clean_stop", "trail_beyond_plan", "rule_trail", "scalp_trail", "trail_loss", "square_off", "manual_at_plan", "counter_signal"}
_FEAR_MISTAKES = {"tight_trail", "early_exit", "undersized_habit", "target_pulled"}


def _check(s: TradeScore, key: str):
    return next((c for c in s.checks if c.key == key), None)


# ---- per-trade predicates: True = counts toward the run, False = breaks it, None = does not apply (skipped, run unchanged) ----


def risk_keeper(s: TradeScore) -> Optional[bool]:
    c = _check(s, "size_adherence")
    if c is None:
        return None  # not measurable (no stop, or opened before the size was recorded)
    # at the system size, never above it, and not sized down below half (a tiny order does not count as keeping to the plan)
    return c.score >= 1.0 and "undersized" not in s.flags


def patient_entry(s: TradeScore) -> Optional[bool]:
    stop, tag, style = _check(s, "stop_planned"), _check(s, "setup_tagged"), _check(s, "entry_style")
    if stop is None or tag is None or style is None:
        return None
    day = [_check(s, "cooldown"), _check(s, "trading_window")]
    return stop.score >= 1.0 and tag.score >= 1.0 and style.score >= 1.0 and all(c is None or c.score >= 1.0 for c in day)


def steady_hands(s: TradeScore) -> Optional[bool]:
    kept = _check(s, "stop_kept")
    if kept is None:
        return None
    return kept.score >= 1.0 and s.exit_kind != "tight_trail" and "tight_trail" not in s.mistakes


def plan_holder(s: TradeScore) -> Optional[bool]:
    if s.exit_kind is None:
        return None
    return s.exit_kind in _HELD


def loss_acceptor(s: TradeScore) -> Optional[bool]:
    """Looks only at losing trades: a win neither adds to the run nor breaks it. A loss counts when the stop was left alone."""
    pnl = s.facts.pnl
    if pnl is None or pnl >= 0:
        return None
    return s.exit_kind == "clean_stop"


@dataclass(frozen=True)
class CredentialDef:
    key: str
    label: str
    blurb: str
    unit: str  # what the run counts, for the sentence "12 of 20 trades in a row"
    thresholds: tuple[int, int, int]
    predicate: Callable[[TradeScore], Optional[bool]]


DEFS: list[CredentialDef] = [
    CredentialDef("loss_acceptor", "Loss Acceptor", "Took the loss as planned: the stop was left alone and the trade closed there. The most valuable habit here.", "losses taken as planned in a row", (10, 25, 50), loss_acceptor),
    CredentialDef("risk_keeper", "Risk Keeper", "Traded at the size the system's risk sizing gave, never above it.", "trades at the system size in a row", (20, 50, 100), risk_keeper),
    CredentialDef("patient_entry", "Patient Entry", "A planned stop, a tagged setup, a limit or wait-for-price entry, and no re-entry in a cooldown or at the open and close.", "patient entries in a row", (15, 40, 80), patient_entry),
    CredentialDef("steady_hands", "Steady Hands", "Never tried to widen a live stop and never trailed one too tight.", "trades with steady hands in a row", (20, 50, 100), steady_hands),
    CredentialDef("plan_holder", "Plan Holder", "Held the trade to its stop, its target or a trail that followed the rules.", "trades held to the plan in a row", (10, 30, 60), plan_holder),
]


@dataclass
class CredentialStatus:
    key: str
    label: str
    blurb: str
    unit: str
    count: int  # the run right now
    level: Optional[str]  # bronze / silver / gold, or None
    next_level: Optional[str]
    next_at: Optional[int]  # the run needed for the next level
    best_count: int
    best_level: Optional[str]
    lapsed: bool  # held a higher level than now
    available: bool = True  # False when it needs a setting the person has not made (Day Closer needs a daily loss limit)
    detail: Optional[str] = None  # a line of plain-language context (the rate behind Calm Under Pressure, say)


def level_for(count: int, thresholds: tuple[int, int, int]) -> Optional[str]:
    earned = None
    for name, need in zip(LEVELS, thresholds):
        if count >= need:
            earned = name
    return earned


def _runs(values: list[Optional[bool]]) -> tuple[int, int]:
    """(the run at the end, the best run anywhere) over predicate results, oldest first. None is skipped without breaking a run."""
    current = best = 0
    for v in values:
        if v is None:
            continue
        current = current + 1 if v else 0
        best = max(best, current)
    return current, best


def _rank(level: Optional[str]) -> int:
    return LEVELS.index(level) + 1 if level in LEVELS else 0


# Calm Under Pressure is a RATE over a window of recent trades, not a run: how few of them showed a fear mistake (a tight trail, a
# hand-closed exit, a target pulled in, a habit of sizing down). Window size and the most mistakes allowed in it, per level.
CALM_WINDOWS = (("bronze", 30, 0.25), ("silver", 50, 0.15), ("gold", 100, 0.08))
CALM_THRESHOLDS = (30, 50, 100)


def _fear_rate(window: list[TradeScore]) -> float:
    return sum(1 for s in window if any(m in _FEAR_MISTAKES for m in s.mistakes)) / len(window)


def _calm_level(ordered: list[TradeScore]) -> Optional[str]:
    earned = None
    for name, size, cap in CALM_WINDOWS:
        if len(ordered) < size:
            break
        window = ordered[-size:]
        if _fear_rate(window) > cap:
            break
        if name == "bronze":
            half = size // 2  # and it has to be getting better, not just low: the newer half no worse than the older
            if _fear_rate(window[half:]) > _fear_rate(window[:half]):
                break
        earned = name
    return earned


def _calm(ordered: list[TradeScore]) -> CredentialStatus:
    level = _calm_level(ordered)
    best_level = None
    for i in range(1, len(ordered) + 1):
        if _rank(_calm_level(ordered[:i])) > _rank(best_level):
            best_level = _calm_level(ordered[:i])
    nxt = next(((n, size) for n, size, _ in CALM_WINDOWS if len(ordered) < size or _rank(level) < LEVELS.index(n) + 1), None)
    detail = None
    if ordered:
        size = min(len(ordered), 30)
        detail = f"Fear mistakes in your last {size} trade{'s' if size != 1 else ''}: {round(_fear_rate(ordered[-size:]) * 100)}%"
    return CredentialStatus(
        key="calm_under_pressure", label="Calm Under Pressure", unit="recent trades measured", count=min(len(ordered), 100),
        blurb="Few fear mistakes - tight trails, closing by hand early, pulling a target in, sizing down - and fewer lately than before.",
        level=level, next_level=nxt[0] if nxt else None, next_at=nxt[1] if nxt else None,
        best_count=min(len(ordered), 100), best_level=best_level, lapsed=_rank(best_level) > _rank(level), detail=detail,
    )


DAY_THRESHOLDS = (3, 8, 15)


def _day_closer(ordered: list[TradeScore], daily_loss_limit: Optional[float], tz: str) -> CredentialStatus:
    base = dict(
        key="day_closer", label="Day Closer", unit="loss-limit days respected in a row", thresholds=DAY_THRESHOLDS,
        blurb="On a day your loss limit was reached, you stopped. No trade was taken past it.",
    )
    if daily_loss_limit is None:
        return CredentialStatus(
            key=base["key"], label=base["label"], blurb=base["blurb"], unit=base["unit"], count=0, level=None, next_level="bronze",
            next_at=DAY_THRESHOLDS[0], best_count=0, best_level=None, lapsed=False, available=False,
            detail="Set a daily loss limit on this account to earn it.",
        )
    days: dict = {}
    for s in ordered:
        days.setdefault(s.facts.entry_time.astimezone(ZoneInfo(tz)).date(), []).append(s)
    results: list[Optional[bool]] = []
    for day in sorted(days):
        trades = days[day]
        lost = -sum(t.facts.pnl for t in trades if t.facts.pnl is not None and t.facts.pnl < 0)  # the same losses the loss-limit check counts
        hit = lost >= daily_loss_limit
        broke = any("past_loss_limit" in t.mistakes for t in trades)
        results.append(None if not hit and not broke else (not broke))
    current, best = _runs(results)
    level, best_level = level_for(current, DAY_THRESHOLDS), level_for(best, DAY_THRESHOLDS)
    nxt = next(((n, need) for n, need in zip(LEVELS, DAY_THRESHOLDS) if current < need), None)
    return CredentialStatus(
        key=base["key"], label=base["label"], blurb=base["blurb"], unit=base["unit"], count=current, level=level,
        next_level=nxt[0] if nxt else None, next_at=nxt[1] if nxt else None, best_count=best, best_level=best_level,
        lapsed=_rank(best_level) > _rank(level),
    )


def evaluate(scores: list[TradeScore], daily_loss_limit: Optional[float] = None, tz: str = "Asia/Kolkata") -> list[CredentialStatus]:
    ordered = sorted((s for s in scores if not s.facts.auto_traded), key=lambda s: s.facts.exit_time)
    out: list[CredentialStatus] = []
    for d in DEFS:
        current, best = _runs([d.predicate(s) for s in ordered])
        level, best_level = level_for(current, d.thresholds), level_for(best, d.thresholds)
        nxt = next(((name, need) for name, need in zip(LEVELS, d.thresholds) if current < need), None)
        out.append(
            CredentialStatus(
                key=d.key, label=d.label, blurb=d.blurb, unit=d.unit, count=current, level=level,
                next_level=nxt[0] if nxt else None, next_at=nxt[1] if nxt else None,
                best_count=best, best_level=best_level, lapsed=_rank(best_level) > _rank(level),
            )
        )
    out.append(_day_closer(ordered, daily_loss_limit, tz))
    out.append(_calm(ordered))
    return out
