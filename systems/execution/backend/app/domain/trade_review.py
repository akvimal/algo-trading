"""Post-trade review by cause: what went wrong with a trade, filed under the earliest step that failed.

A trade can fail in three places, and an earlier failure explains the later ones:
  study      - was the trade analysed before entry? (against the trend, ignored the regime, event risk, wrong setup, impulse)
  plan       - was it defined before entry? (no stop, no target, poor reward-to-risk, oversized, chased, no exit rule)
  execution  - was the plan followed? (moved the stop, exited early, held past the plan, added to a loser, revenge, broke the limits)
A trade's root cause is the earliest level among its mistake tags; 'clean' means the person says nothing went wrong (a clean trade can still lose).

Pure: tags and facts in, suggestions and totals out. The discipline checks (app/domain/discipline_v2.py) already detect most plan and
execution mistakes from the order and its move log; the study ones come from the context the ticket snapshotted at entry. A suggestion is
only ever a suggestion: the person confirms the tags, and nothing here is guessed when the data was not captured."""

from __future__ import annotations

from typing import Optional

LEVELS = ("study", "plan", "execution")

TAXONOMY: dict[str, dict[str, str]] = {
    "study": {
        "against_trend": "Against the trend",
        "ignored_regime": "Ignored the regime / OI read",
        "event_risk": "Traded into news or an event",
        "wrong_setup": "Wrong setup for the conditions",
        "impulse": "Impulse or tip, no analysis",
    },
    "plan": {
        "no_stop": "No stop",
        "no_target": "No target",
        "low_rr": "Reward-to-risk below minimum",
        "oversized": "Oversized",
        "chased": "Chased the entry",
        "no_exit_rule": "No exit rule",
    },
    "execution": {
        "stop_moved": "Moved or removed the stop",
        "exited_early": "Exited early",
        "held_past_plan": "Held past the plan",
        "added_to_loser": "Added to a loser",
        "revenge": "Revenge trade or overtrading",
        "broke_limits": "Broke a limit (loss, trade cap, session window)",
    },
}
TAG_LEVEL = {tag: level for level, tags in TAXONOMY.items() for tag in tags}
ROOT_CAUSES = LEVELS + ("clean",)

# What the discipline checks call a mistake -> the review tag it becomes (and the level follows from the tag).
FROM_DISCIPLINE = {
    "no_stop": "no_stop", "unplanned_reward": "no_target", "low_rr": "low_rr", "oversized": "oversized",
    "widen_attempt": "stop_moved", "early_exit": "exited_early", "tight_trail": "exited_early", "target_pulled": "exited_early",
    "target_pushed": "held_past_plan", "liquidated": "held_past_plan", "revenge": "revenge", "overtrade": "broke_limits",
    "past_loss_limit": "broke_limits", "off_window": "broke_limits",
}  # "untagged" is deliberately absent: a missing setup tag is not evidence the trade was not studied
_WHY = {
    "widen_attempt": "A live stop was widened or cleared.",
    "tight_trail": "The stop was trailed tight and hit before the plan.",
}


class ReviewError(ValueError):
    pass


def level_of(tag: str) -> str:
    return TAG_LEVEL[tag]


def clean_tags(tags) -> list[str]:
    """The tags as a de-duplicated list in a stable order, refusing anything outside the list."""
    if tags is None:
        return []
    if not isinstance(tags, (list, tuple)):
        raise ReviewError("mistake tags must be a list")
    unknown = [t for t in tags if t not in TAG_LEVEL]
    if unknown:
        raise ReviewError(f"unknown mistake tag(s): {', '.join(map(str, unknown))}")
    order = list(TAG_LEVEL)
    return sorted(set(tags), key=order.index)


def root_cause_for(tags: list[str], clean: bool = False) -> Optional[str]:
    """The earliest level among the tags; 'clean' when the person marked the trade clean; None while nothing is decided. Tags and a clean mark
    together are contradictory and refused."""
    if tags and clean:
        raise ReviewError("a trade cannot be both clean and have mistakes")
    if clean:
        return "clean"
    if not tags:
        return None
    levels = {TAG_LEVEL[t] for t in tags}
    return next(lv for lv in LEVELS if lv in levels)


def against_trend(action: str, context: Optional[dict]) -> Optional[bool]:
    """True when the market was trending the other way at entry, False when it was with the trade or ranging, None when the ticket did not
    record a read (then nothing is assumed)."""
    if not context:
        return None
    regime = context.get("regime")
    if regime not in ("trending_up", "trending_down", "ranging", "transitional"):
        return None
    if regime in ("ranging", "transitional"):
        return False
    return (regime == "trending_up") != (action == "BUY")


OVERRIDE_MIN_R = 1.0  # an override only pays off when the trade won at least this many times the risk it took
_RR_TOL = 0.01
OVERRIDE_WHY = {
    "paid_off": "You overrode the system's read, the plan held and the trade won at least 1R, so the override counts as a pass.",
    "small_win": "You overrode the system's read and won, but by less than 1R: not counted as a pass, not counted against you.",
    "lost": "You overrode the system's read and the trade lost: worth asking whether the read was right.",
    "weak_plan": "You overrode the system's read without a complete plan (a stop and a target at order time, at your minimum reward-to-risk), so a win would not have cleared it.",
}


def override_verdict(entry_context: Optional[dict], stop0, target0, planned_rr: Optional[float], exit_r: Optional[float], pnl: Optional[float], min_rr: float) -> Optional[str]:
    """What became of the person overriding the system's read of the market, or None when they did not.
      paid_off  - the plan held (a stop and a target at order time, reward-to-risk at the minimum) and the trade won at least 1R
      small_win - plan held, won, but under 1R
      lost      - plan held, did not win
      weak_plan - the plan was incomplete: a win never rescues that"""
    if not entry_context or entry_context.get("overridden") is not True:
        return None
    if stop0 is None or target0 is None or planned_rr is None or planned_rr + _RR_TOL < min_rr:
        return "weak_plan"
    if (pnl or 0) > 0:
        return "paid_off" if exit_r is not None and exit_r >= OVERRIDE_MIN_R else "small_win"
    return "lost"


# A trade that went to plan needs no review. The checks "no review" and "untagged setup" are about the paperwork, not the trade, so they do not
# count against it (otherwise not reviewing would be the reason it still needed a review).
ON_PLAN_IGNORED = frozenset({"no_review", "untagged"})


def won_at_min_rr(pnl, exit_r: Optional[float], min_rr: float) -> bool:
    """The trade made money and made at least the minimum reward-to-risk (measured on what it actually returned)."""
    return (pnl or 0) > 0 and exit_r is not None and exit_r + _RR_TOL >= min_rr


def on_plan(mistakes: list[str], stop0, target0, planned_rr: Optional[float], min_rr: float, exit_r: Optional[float] = None, pnl=None) -> bool:
    """Whether a closed trade went to plan and so needs no review. It needs a stop at order time and either
      - a target too, at the minimum reward-to-risk, and no mistake found in how it was sized, entered, managed or exited (win or lose: a stop-out of a
        sound plan is the plan working), or
      - no target, but it closed in profit at the minimum reward-to-risk or better: the plan was thin, the result is what the plan asks for.
    A profit below the minimum with no target is not on plan: it is reviewed and scored."""
    if stop0 is None:
        return False
    ignored = ON_PLAN_IGNORED
    if target0 is None:
        if not won_at_min_rr(pnl, exit_r, min_rr):
            return False
        ignored = ON_PLAN_IGNORED | {"unplanned_reward"}
    elif planned_rr is None or planned_rr + _RR_TOL < min_rr:
        return False
    return not [m for m in mistakes if m not in ignored]


def suggest(action: str, discipline_mistakes: list[str], entry_context: Optional[dict], override: Optional[str] = None, won_at_min: bool = False) -> dict:
    """The tags the data supports for one trade, each with its level and why, and the root cause they imply. Study first, as in the chain.
    `override` is override_verdict's answer: an override that paid off clears 'against the trend', one that was neither a clear win nor a plan
    failure is left to the person, the others are suggested with the override as the reason. `won_at_min` (the trade made money at the minimum
    reward-to-risk) clears it too, override or not: going against the system's read is fine when it pays what the plan asks."""
    found: dict[str, str] = {}
    if against_trend(action, entry_context) and override not in ("paid_off", "small_win") and not won_at_min:
        found["against_trend"] = "The market was trending the other way at entry" + (f" (ADX {entry_context['adx']:.0f})." if isinstance(entry_context.get("adx"), (int, float)) else ".")
        if override in ("lost", "weak_plan"):
            found["against_trend"] += " " + OVERRIDE_WHY[override]
    for m in discipline_mistakes:
        tag = FROM_DISCIPLINE.get(m)
        if tag and tag not in found:
            found[tag] = _WHY.get(m, "Found from the order and its stop/target history.")
    tags = clean_tags(list(found))
    return {
        "tags": [{"tag": t, "level": TAG_LEVEL[t], "label": TAXONOMY[TAG_LEVEL[t]][t], "why": found[t]} for t in tags],
        "root_cause": root_cause_for(tags),
        "had_context": bool(entry_context),
        "override": {"verdict": override, "why": OVERRIDE_WHY[override]} if override else None,
    }


def clean_context(raw) -> Optional[dict]:
    """The order-time read as the ticket sent it, cut down to the few fields the review uses (anything else is dropped)."""
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    if raw.get("regime") in ("trending_up", "trending_down", "ranging", "transitional"):
        out["regime"] = raw["regime"]
    if raw.get("trend") in ("up", "down", "range"):
        out["trend"] = raw["trend"]
    # The person's own read, when they pinned one: whether it differs from the system's clear read is what the review treats as an override.
    if raw.get("person_read") in ("trending_up", "trending_down", "ranging", "transitional"):
        out["person_read"] = raw["person_read"]
    if raw.get("overridden") is True:
        out["overridden"] = True
    adx = raw.get("adx")
    if isinstance(adx, (int, float)) and not isinstance(adx, bool) and 0 <= adx <= 100:
        out["adx"] = round(float(adx), 1)
    return out or None


def summarize(trades: list[dict]) -> dict:
    """What the reviewed trades say, each `{"exit_time", "pnl", "root_cause", "tags"}` (root_cause None = not reviewed yet). Money per level and
    per tag (a trade with several tags counts under each tag, but once under its root cause), clean against flawed, the trades still waiting
    for a review, and the run of trades since the last time each study mistake was made."""
    reviewed = [t for t in trades if t.get("root_cause")]
    pending = [t for t in trades if not t.get("root_cause")]

    def block(rows: list[dict]) -> dict:
        pnls = [r["pnl"] for r in rows if r.get("pnl") is not None]
        losses = [p for p in pnls if p < 0]
        return {"n": len(rows), "pnl": round(sum(pnls), 2), "avg_loss": round(sum(losses) / len(losses), 2) if losses else None}

    by_level = {lv: block([t for t in reviewed if t["root_cause"] == lv]) for lv in ROOT_CAUSES}
    by_tag = {}
    for tag in TAG_LEVEL:
        rows = [t for t in reviewed if tag in (t.get("tags") or [])]
        if rows:
            by_tag[tag] = {**block(rows), "level": TAG_LEVEL[tag]}
    flawed = [t for t in reviewed if t["root_cause"] != "clean"]
    clean = [t for t in reviewed if t["root_cause"] == "clean"]

    ordered = sorted(reviewed, key=lambda t: t["exit_time"])
    since_last = {}
    for tag in by_tag:
        idx = [i for i, t in enumerate(ordered) if tag in (t.get("tags") or [])]
        since_last[tag] = len(ordered) - 1 - idx[-1]
    return {
        "reviewed": len(reviewed), "pending": len(pending), "by_level": by_level, "by_tag": by_tag,
        "clean": {**block(clean), "lost": sum(1 for t in clean if (t.get("pnl") or 0) < 0)}, "flawed": block(flawed), "trades_since_last": since_last,
    }
