"""The morning pre-market read as a picture: where the day is leaning (a bias meter), how big the opening gap is, what is pushing the market
up or down (a bar per factor), the global moves behind it, and what to watch at the open.

Drawn with Pillow from the same report the text message uses (app/domain/notifications.py's premarket_message), so the two agree; the text
is still sent as the fallback and is what the delivery history keeps. Shares its fonts and drawing helpers with the post-session card."""

from __future__ import annotations

import io
from datetime import date
from typing import Callable, Optional

from PIL import Image, ImageDraw

from app.domain import notifications as n
from app.domain.premarket_bias import BEARISH_AT, BULLISH_AT
from app.domain.session_card import BG, DIM, DN, EDGE, INNER, PAD, PANEL, TEXT, UP, W, WARN, _fit, _panel, _text, _triangle, _width, font, level, minus, signed_pct, tone

Block = tuple[int, Callable]
BIAS_COLOR = {"bullish": UP, "bearish": DN, "neutral": WARN}


def _wrap(d, text: str, size: int, max_w: float, max_lines: int, bold: bool = False) -> list[str]:
    """The text broken into at most `max_lines` lines no wider than `max_w`; the last line ends in an ellipsis if there was more."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if _width(d, trial, size, bold) <= max_w:
            cur = trial
            continue
        lines.append(cur)
        cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = _fit(d, lines[-1] + " …", size, max_w, bold)
    return lines


def _by_key(inputs: list[dict]) -> dict:
    return {i["key"]: i for i in inputs if i.get("ok")}


def _move_text(r: dict) -> str:
    v = r.get("change")
    if v is None:
        return "-"
    if r.get("unit") == "bp":
        return f"{'+' if v > 0 else minus() if v < 0 else ''}{abs(v):.1f} bp"
    return signed_pct(v)


# ---- blocks ----------------------------------------------------------------------------------------------------------------------


def _header(day: date) -> Block:
    def draw(d, y):
        _text(d, (PAD, y + 24), "Pre-market read", 42, TEXT, True)
        _text(d, (W - PAD, y + 38), f"{day.strftime('%a')} {day.day} {day.strftime('%b %Y')} · before the 9:15 open", 22, DIM, anchor="ra")
        d.line([PAD, y + 92, W - PAD, y + 92], fill=EDGE, width=2)

    return 112, draw


def _bias_hero(report: dict) -> Block:
    rules, ai = report["rules"], report.get("ai")
    bias = ai["bias"] if ai else rules["bias"]
    color = BIAS_COLOR.get(bias, WARN)
    score = rules.get("score") or 0.0
    one_liner = n.shorten(ai["one_liner"], n.ONE_LINER_MAX) if ai and ai.get("one_liner") else None

    def draw(d, y):
        _panel(d, y, 352 if one_liner else 250, color)
        _text(d, (PAD + 26, y + 20), "WHERE THE DAY IS LEANING", 19, DIM, True)
        _text(d, (PAD + 26, y + 46), bias.upper(), 66, color, True)
        who = f"AI {ai['confidence']}% confident" if ai and ai.get("confidence") else ("AI read" if ai else "Fixed rules only")
        _text(d, (W - PAD - 26, y + 30), who, 24, TEXT, True, anchor="ra")
        if ai and ai["bias"] != rules["bias"]:
            _text(d, (W - PAD - 26, y + 66), f"fixed rules say {rules['bias']}", 20, WARN, anchor="ra")
        # the meter: bearish | neutral | bullish, the score as a marker
        mx, mw, my = PAD + 26, INNER - 52, y + 138
        z1, z2 = (BEARISH_AT + 1) / 2, (BULLISH_AT + 1) / 2
        d.rounded_rectangle([mx, my, mx + mw, my + 22], radius=11, fill=EDGE)
        d.rounded_rectangle([mx, my, mx + int(mw * z1), my + 22], radius=11, fill=(120, 52, 56))
        d.rectangle([mx + int(mw * z1) - 10, my, mx + int(mw * z1) + 4, my + 22], fill=(120, 52, 56))
        d.rounded_rectangle([mx + int(mw * z2), my, mx + mw, my + 22], radius=11, fill=(26, 112, 80))
        d.rectangle([mx + int(mw * z2) - 4, my, mx + int(mw * z2) + 12, my + 22], fill=(26, 112, 80))
        d.rectangle([mx + int(mw * z1) + 4, my, mx + int(mw * z2) - 4, my + 22], fill=(70, 62, 40))
        px = mx + int(mw * (max(-1.0, min(1.0, score)) + 1) / 2)
        d.polygon([(px - 12, my - 16), (px + 12, my - 16), (px, my - 2)], fill=TEXT)
        d.ellipse([px - 11, my + 0, px + 11, my + 22], fill=color, outline=BG, width=4)
        for label, x, anchor in (("Bearish", mx, "la"), ("Neutral", mx + mw // 2, "ma"), ("Bullish", mx + mw, "ra")):
            _text(d, (x, my + 34), label, 19, DIM, anchor=anchor)
        _text(d, (px, my + 62), f"score {score:+.2f}".replace("-", minus()), 20, TEXT, True, anchor="ma")
        if one_liner:
            for i, line in enumerate(_wrap(d, one_liner, 24, INNER - 52, 3)):
                _text(d, (PAD + 26, y + 236 + i * 32), line, 24, TEXT)

    return (370 if one_liner else 268), draw


def _gap_block(report: dict) -> Optional[Block]:
    by = _by_key(report["inputs"])
    gift, last = by.get("gift_nifty"), by.get("nifty_close")
    if not gift or gift.get("change") is None:
        return None
    gift_v = gift["value"]
    last_v = last["value"] if last else gift_v / (1 + gift["change"] / 100)
    gap = gift["change"]
    color = tone(gap)

    def draw(d, y):
        _panel(d, y, 150)
        _text(d, (PAD + 26, y + 18), "THE OPENING GAP · GIFT NIFTY", 19, DIM, True)
        _text(d, (PAD + 26, y + 50), level(gift_v), 52, TEXT, True)
        _text(d, (PAD + 26, y + 112), f"vs Nifty's last close {level(last_v)}", 20, DIM)
        pct = signed_pct(gap)
        px = W - PAD - 26 - _width(d, pct, 56, True)
        _text(d, (px, y + 44), pct, 56, color, True)
        if gap:
            _triangle(d, px - 44, y + 62, gap > 0, 30, color)
        pts = gift_v - last_v
        _text(d, (W - PAD - 26, y + 112), f"{'+' if pts > 0 else minus() if pts < 0 else ''}{abs(pts):,.0f} points".replace("+-", "-"), 22, color, True, anchor="ra")

    return 166, draw


def _drivers(report: dict) -> Optional[Block]:
    factors = [f for f in report["rules"].get("factors", []) if f.get("score") is not None]
    if not factors:
        return None
    factors.sort(key=lambda f: -abs(f["score"] * f["weight"]))
    rows = factors[:7]

    def draw(d, y):
        _text(d, (PAD + 4, y), "WHAT IS PUSHING THE MARKET · RIGHT = SUPPORTS A RISE, LEFT = A FALL", 19, DIM, True)
        mid, half = 600, 250
        yy = y + 34
        for f in rows:
            _panel(d, yy, 52)
            _text(d, (PAD + 22, yy + 13), f["label"], 22, TEXT, True)
            col = UP if f["score"] > 0 else DN if f["score"] < 0 else DIM
            length = int(half * min(1.0, abs(f["score"])))
            d.line([mid, yy + 8, mid, yy + 44], fill=EDGE, width=2)
            if length:
                x0, x1 = (mid, mid + length) if f["score"] > 0 else (mid - length, mid)
                d.rounded_rectangle([x0, yy + 16, x1, yy + 36], radius=6, fill=col)
            move = f.get("move")
            unit = " bp" if f["key"] in ("us10y", "in10y") else "%"
            txt = "-" if move is None else f"{'+' if move > 0 else minus() if move < 0 else ''}{abs(move):.2f}{unit}"
            _text(d, (W - PAD - 22, yy + 13), txt, 22, DIM, anchor="ra")
            yy += 58

    return 34 + 58 * len(rows) + 6, draw


def _global_chips(report: dict) -> Optional[Block]:
    by = _by_key(report["inputs"])
    want = [("sp500", "S&P"), ("nasdaq", "Nasdaq"), ("dow", "Dow"), ("brent", "Brent"), ("usdinr", "USD/INR"), ("us10y", "US 10Y"), ("in10y", "India 10Y")]
    chips = [(label, by[k]) for k, label in want if k in by and by[k].get("change") is not None]
    if not chips:
        return None

    def layout(d):
        rows, x, row = [[]], 0, 0
        for label, r in chips:
            text = f"{label} {_move_text(r)}"
            w = _width(d, text, 21, True) + 52
            if x and x + w > INNER:
                rows.append([])
                x = 0
            rows[-1].append((label, r, text, w))
            x += w + 12
        return rows

    probe = ImageDraw.Draw(Image.new("RGB", (4, 4)))
    rows = layout(probe)

    def draw(d, y):
        _text(d, (PAD + 4, y), "THE GLOBAL BACKDROP", 19, DIM, True)
        yy = y + 34
        for row in rows:
            x = PAD
            for _label, r, text, w in row:
                d.rounded_rectangle([x, yy, x + w, yy + 46], radius=23, fill=PANEL)
                v = r["change"]
                # Direction only, in a neutral colour: a rise in crude, the dollar or yields is not good news for India, and the factor bars
                # above are what say whether each move helps or hurts.
                if v:
                    _triangle(d, x + 16, yy + 15, v > 0, 14, DIM)
                _text(d, (x + 38, yy + 10), text, 21, TEXT, True)
                x += w + 12
            yy += 56

    return 34 + 56 * len(rows) + 4, draw


def _watch(report: dict) -> Optional[Block]:
    ai = report.get("ai") or {}
    watch, risk = ai.get("watch"), (ai.get("risks") or [None])[0]
    if not watch and not risk:
        return None
    probe = ImageDraw.Draw(Image.new("RGB", (4, 4)))
    wlines = _wrap(probe, n.shorten(watch, n.WATCH_MAX * 2), 23, INNER - 52, 4) if watch else []
    rlines = _wrap(probe, n.shorten(risk, 260), 20, INNER - 52, 3) if risk else []
    h = 26 + (36 + len(wlines) * 31 if wlines else 0) + (34 + len(rlines) * 27 if rlines else 0) + 20

    def draw(d, y):
        _panel(d, y, h, WARN if wlines else None)
        yy = y + 20
        if wlines:
            _text(d, (PAD + 26, yy), "WATCH AT THE OPEN", 19, WARN, True)
            yy += 36
            for line in wlines:
                _text(d, (PAD + 26, yy), line, 23, TEXT)
                yy += 31
        if rlines:
            yy += 8
            _text(d, (PAD + 26, yy), "THE RISK", 17, DIM, True)
            yy += 28
            for line in rlines:
                _text(d, (PAD + 26, yy), line, 20, DIM)
                yy += 27

    return h, draw


def _footer() -> Block:
    def draw(d, y):
        _text(d, (PAD + 4, y + 8), "Market context from public data, not a recommendation.", 17, DIM)

    return 40, draw


def render_premarket_card(report: dict, day: date) -> bytes:
    """The card as PNG bytes. `report` is the stored report's inputs / rules / ai."""
    blocks: list[Block] = [_header(day), _bias_hero(report)]
    for make in (_gap_block, _drivers, _global_chips, _watch):
        b = make(report)
        if b:
            blocks.append(b)
    blocks.append(_footer())
    gap = 18
    height = sum(h for h, _ in blocks) + gap * (len(blocks) - 1) + 24
    img = Image.new("RGB", (W, height), BG)
    d = ImageDraw.Draw(img)
    y = 0
    for h, draw in blocks:
        draw(d, y)
        y += h + gap
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()
