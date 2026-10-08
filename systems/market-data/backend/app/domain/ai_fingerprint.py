"""Decides whether an AI read made earlier is still good for the numbers in front of us, so the same data is never sent to
the model twice.

Every brief build re-fetches its inputs (free and fast) and scores them, but only asks the model again when they have
moved meaningfully from the inputs the previous read was MADE on (its "basis"). Comparing against a tolerance, not a
rounded hash, avoids the edge case where a figure sitting on a rounding boundary flips the answer on a tiny move; and
the basis is carried through every reuse, so slow drift cannot accumulate unnoticed - once the numbers are a full
tolerance away from what the model saw, it is asked again. The model name and a prompt version are part of the basis, so
a different model or a reworded prompt is never answered from an old read. A failed call stores no basis, so it is retried.
"""

from __future__ import annotations

from typing import Optional

PROMPT_VERSION = 1

# How far an input's move may differ from the one the read was made on and still count as "the same data":
# 0.15 percentage points for prices, 2 bp for yields, 2 points for the Fear & Greed index.
TOLERANCE = {"pct": 0.15, "bp": 2.0, "pt": 2.0}
# The rule-based score is -1..+1; a shift of this much is a different read even if each input is within tolerance.
SCORE_TOLERANCE = 0.1


def basis(inputs: list[dict], rules: dict, model: Optional[str], macro: Optional[dict] = None, extra: str = "") -> dict:
    """What an AI read is based on. Plain data (JSON-safe), so it can sit in a cached brief or be rebuilt from a stored row."""
    out = {
        "meta": f"{PROMPT_VERSION}|{model}|{extra}",
        "bias": rules.get("bias"),
        "score": rules.get("score", 0.0),
        "inputs": {i["key"]: [bool(i["ok"]), i["change"], i.get("unit", "pct")] for i in inputs},
        "macro": None,
    }
    if macro:
        out["macro"] = [
            sorted((i["key"], i.get("value")) for i in macro.get("indicators", []) if i.get("ok")),
            sorted(r.get("title", "") for r in macro.get("rbi", [])),
        ]
    return out


def same_basis(a: Optional[dict], b: Optional[dict]) -> bool:
    """Whether a read made on basis `a` still holds for `b`."""
    if not a or not b or a["meta"] != b["meta"] or a["bias"] != b["bias"] or a["macro"] != b["macro"]:
        return False
    if abs(a["score"] - b["score"]) > SCORE_TOLERANCE or a["inputs"].keys() != b["inputs"].keys():
        return False
    for key, (ok_a, change_a, unit) in a["inputs"].items():
        ok_b, change_b, _ = b["inputs"][key]
        if ok_a != ok_b:
            return False
        if change_a is None or change_b is None:
            if change_a != change_b:
                return False
        elif abs(change_a - change_b) > TOLERANCE.get(unit, 0.15):
            return False
    return True
