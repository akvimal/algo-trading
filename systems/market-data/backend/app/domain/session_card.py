"""The post-session summary as a picture: a dark card with the market's moves, whether the morning's bias held, and the person's own day.

Drawn with Pillow from the same data the text message uses (app/domain/notifications.py's session_message), so the two always agree; the text
is still sent as the fallback when a card cannot be drawn or sent, and it is what the delivery history keeps. The card says nothing the text
does not.

Fonts: DejaVu Sans (installed in the image; it has the rupee sign and the proper minus). Without it the card falls back to Pillow's built-in
font and writes "Rs " and "-" instead, so it still renders (tests and a dev machine without the font)."""

from __future__ import annotations

import io
import os
from datetime import date
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

BG, PANEL, EDGE = (15, 18, 22), (23, 28, 34), (44, 52, 62)
TEXT, DIM = (230, 233, 238), (147, 161, 177)
UP, DN, WARN = (61, 220, 151), (255, 107, 107), (245, 183, 74)
W, PAD = 1080, 40

_FONT_DIRS = ("/usr/share/fonts/truetype/dejavu", "C:/Windows/Fonts")
_REGULAR, _BOLD = ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf"), ("DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf")


def _font_path(bold: bool) -> Optional[str]:
    for d in _FONT_DIRS:
        p = os.path.join(d, (_BOLD if bold else _REGULAR)[0])
        if os.path.exists(p):
            return p
    return None


_cache: dict[tuple[int, bool], ImageFont.ImageFont] = {}


def font(size: int, bold: bool = False):
    key = (size, bold)
    if key not in _cache:
        path = _font_path(bold)
        _cache[key] = ImageFont.truetype(path, size) if path else ImageFont.load_default(size)
    return _cache[key]


def has_real_font() -> bool:
    return _font_path(False) is not None


def rupee() -> str:
    return "₹" if has_real_font() else "Rs "


def minus() -> str:
    return "−" if has_real_font() else "-"


def money(v: float, segment: str) -> str:
    sign = "+" if v > 0 else minus() if v < 0 else ""
    return f"{sign}{'$' if segment == 'CRYPTO' else rupee()}{abs(v):,.0f}"


def signed_pct(v: Optional[float]) -> str:
    if v is None:
        return "-"
    return f"{'+' if v > 0 else minus() if v < 0 else ''}{abs(v):.2f}%"


def level(v: float) -> str:
    return f"{v:,.0f}" if v >= 1000 else f"{v:,.2f}"


def tone(v: Optional[float]):
    return DIM if v is None or v == 0 else UP if v > 0 else DN


# ---- the drawing helpers -----------------------------------------------------------------------------------------------------------


def _text(d: ImageDraw.ImageDraw, xy, s: str, size: int, color=TEXT, bold=False, anchor="la"):
    d.text(xy, s, font=font(size, bold), fill=color, anchor=anchor)


def _width(d: ImageDraw.ImageDraw, s: str, size: int, bold=False) -> float:
    return d.textlength(s, font=font(size, bold))


def _triangle(d: ImageDraw.ImageDraw, x: float, y: float, up: bool, size: int, color):
    h = size
    pts = [(x, y + h), (x + h, y + h), (x + h / 2, y)] if up else [(x, y), (x + h, y), (x + h / 2, y + h)]
    d.polygon(pts, fill=color)


def _pill(d: ImageDraw.ImageDraw, xy, s: str, size: int, color):
    x, y = xy
    w = _width(d, s, size, True) + 28
    h = size + 16
    d.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, outline=color, width=2)
    _text(d, (x + 14, y + 7), s, size, color, True)
    return w


def _range_bar(d: ImageDraw.ImageDraw, x: int, y: int, w: int, position: float, color):
    """Low at the left end, high at the right, a dot where it closed."""
    d.rounded_rectangle([x, y, x + w, y + 8], radius=4, fill=EDGE)
    cx = x + int(max(0.0, min(1.0, position)) * w)
    d.ellipse([cx - 10, y - 6, cx + 10, y + 14], fill=color, outline=BG, width=3)


# ---- the card ---------------------------------------------------------------------------------------------------------------------


def _market_height(rows: list[dict]) -> int:
    return len(rows) * 132


def _draw_market(d: ImageDraw.ImageDraw, y: int, rows: list[dict]) -> int:
    for r in rows:
        d.rounded_rectangle([PAD, y, W - PAD, y + 118], radius=16, fill=PANEL)
        c = tone(r["change_pct"])
        _text(d, (PAD + 24, y + 18), r["label"], 26, DIM, True)
        _text(d, (PAD + 24, y + 52), level(r["close"]), 44, TEXT, True)
        pct = signed_pct(r["change_pct"])
        px = W - PAD - 24 - _width(d, pct, 36, True)
        _text(d, (px, y + 30), pct, 36, c, True)
        if r["change_pct"]:
            _triangle(d, px - 34, y + 40, r["change_pct"] > 0, 22, c)
        if r["label"] != "India VIX":
            bx, bw = PAD + 380, 330
            _text(d, (bx, y + 22), level(r["low"]), 20, DIM)
            _text(d, (bx + bw, y + 22), level(r["high"]), 20, DIM, anchor="ra")
            _range_bar(d, bx, y + 72, bw, r["position"], c if r["change_pct"] else TEXT)
            near = "near the high" if r["position"] >= 0.8 else "near the low" if r["position"] <= 0.2 else "mid-range"
            _text(d, (bx, y + 90), f"closed {near}", 18, DIM)
        y += 132
    return y


def _draw_bias(d: ImageDraw.ImageDraw, y: int, bias: str, held: bool) -> int:
    color = UP if held else DN
    d.rounded_rectangle([PAD, y, W - PAD, y + 74], radius=16, fill=PANEL, outline=color, width=2)
    _text(d, (PAD + 24, y + 22), f"Morning bias: {bias.capitalize()}", 28, TEXT, True)
    verdict = "held" if held else "did not hold"
    _text(d, (W - PAD - 24, y + 22), verdict, 28, color, True, anchor="ra")
    return y + 90


def _mode_height(m: dict) -> int:
    return 300 if m.get("best") and m.get("worst") and m["trades"] > 1 else 214


def _draw_mode(d: ImageDraw.ImageDraw, y: int, name: str, m: dict, segment: str) -> int:
    h = _mode_height(m)
    d.rounded_rectangle([PAD, y, W - PAD, y + h - 14], radius=16, fill=PANEL)
    _pill(d, (PAD + 24, y + 20), name.upper(), 20, DIM)
    net = money(m["net_pnl"], segment)
    _text(d, (W - PAD - 24, y + 14), net, 52, tone(m["net_pnl"]), True, anchor="ra")
    _text(d, (W - PAD - 24, y + 76), "net after charges", 18, DIM, anchor="ra")
    won = f"{m['wins']} won" + (f"  ·  {m['losses']} lost" if m["losses"] else "")
    _text(d, (PAD + 24, y + 74), f"{m['trades']} closed  ·  {won}", 26, TEXT, True)
    # a bar of wins against losses
    total = max(1, m["trades"])
    bx, bw, by = PAD + 24, W - 2 * PAD - 48, y + 124
    d.rounded_rectangle([bx, by, bx + bw, by + 12], radius=6, fill=EDGE)
    if m["wins"]:
        d.rounded_rectangle([bx, by, bx + max(12, int(bw * m["wins"] / total)), by + 12], radius=6, fill=UP)
    if m["losses"]:
        lw = max(12, int(bw * m["losses"] / total))
        d.rounded_rectangle([bx + bw - lw, by, bx + bw, by + 12], radius=6, fill=DN)
    _text(d, (PAD + 24, y + 150), f"With a limit entry and a stop: {m['with_plan']} of {m['trades']}", 20, DIM)
    if m["trades"] > 1 and m.get("best") and m.get("worst"):
        scale = max(abs(m["best"]["pnl"]), abs(m["worst"]["pnl"]), 1)
        mid, half = 470, 190  # the bars stay clear of the label on the left and the amount on the right
        for i, (word, t) in enumerate((("Best", m["best"]), ("Worst", m["worst"]))):
            yy = y + 190 + i * 44
            _text(d, (PAD + 24, yy), f"{word} {t['symbol']}", 20, DIM)
            length = int(half * abs(t["pnl"]) / scale)
            col = UP if t["pnl"] > 0 else DN
            x0, x1 = (mid, mid + length) if t["pnl"] >= 0 else (mid - length, mid)
            d.rectangle([x0, yy + 4, max(x1, x0 + 3), yy + 22], fill=col)
            r = f" ({t['r']:+.1f}R)".replace("-", minus()) if t.get("r") is not None else ""
            _text(d, (W - PAD - 24, yy), f"{money(t['pnl'], segment)}{r}", 20, col, True, anchor="ra")
    return y + h


def _draw_footer_line(d: ImageDraw.ImageDraw, y: int, trader: dict) -> int:
    parts = []
    if trader.get("open_now"):
        parts.append(f"Still open: {trader['open_now']}")
    if trader.get("discipline_score") is not None:
        parts.append(f"Discipline (30 days): {trader['discipline_score']}/100")
    if parts:
        _text(d, (PAD + 4, y), "   ·   ".join(parts), 22, TEXT)
        y += 36
    return y


TITLES = {"NSE": "Post-session · NSE", "MCX": "Post-session · MCX", "CRYPTO": "Daily summary · crypto"}


def render_session_card(segment: str, day: date, market: dict, trader: Optional[dict], bias_held: Optional[tuple[str, bool]] = None, trader_known: bool = True) -> bytes:
    """The card as PNG bytes. `bias_held` is (the morning's bias, whether it held) for NSE, else None."""
    rows = market["rows"]
    modes = [(n_, trader[k]) for n_, k in (("Paper", "paper"), ("Live", "live")) if trader and trader.get(k)]
    height = 130 + _market_height(rows) + (90 if bias_held else 0) + 20
    height += sum(_mode_height(m) for _, m in modes) if modes else 70
    height += 40 + 70
    img = Image.new("RGB", (W, height), BG)
    d = ImageDraw.Draw(img)
    _text(d, (PAD, 34), TITLES[segment], 40, TEXT, True)
    _text(d, (W - PAD, 46), f"{day.strftime('%a')} {day.day} {day.strftime('%b %Y')}", 24, DIM, anchor="ra")
    d.line([PAD, 96, W - PAD, 96], fill=EDGE, width=2)
    y = _draw_market(d, 116, rows) + 4
    if bias_held:
        y = _draw_bias(d, y, bias_held[0], bias_held[1])
    y += 16
    if not trader_known:
        _text(d, (PAD + 4, y + 10), "Your trades could not be loaded just now.", 26, WARN, True)
        y += 70
    elif not modes:
        _text(d, (PAD + 4, y + 10), "You had no closed trades today.", 26, DIM, True)
        y += 70
    for name, m in modes:
        y = _draw_mode(d, y, name, m, segment)
    if trader_known and trader:
        y = _draw_footer_line(d, y + 4, trader)
    _text(d, (PAD + 4, height - 50), "Market data and your own record, not a recommendation.", 18, DIM)
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()
