"""The strong OI buildup digest as a picture: how many F&O stocks showed a strong two-sided build today, split bullish and bearish, then the top
few of each with their price move and how much their call and put open interest grew (a bar each, on one shared scale so they compare).

Drawn with Pillow from the same rows the text digest uses (app/domain/notifications.py's oi_digest_message / strong_oi), so the two always agree;
the text is still sent as the fallback and is what the delivery history keeps. Shares its fonts and drawing helpers with the other cards."""

from __future__ import annotations

import io
from datetime import date
from typing import Callable

from PIL import Image, ImageDraw

from app.domain import notifications as n
from app.domain.session_card import BG, DIM, DN, EDGE, INNER, PAD, PANEL, TEXT, UP, W, _fit, _panel, _text, _triangle, _width, minus, signed_pct

Block = tuple[int, Callable]
ROW_H = 90
BAR_X, BAR_MAX = 520, 330
BAR_CAP = 120.0  # percent growth that fills a bar


def _header(day: date) -> Block:
    def draw(d, y):
        _text(d, (PAD, y + 24), "Strong OI buildup", 42, TEXT, True)
        _text(d, (W - PAD, y + 38), f"NSE F&O · {day.strftime('%a')} {day.day} {day.strftime('%b')} close", 22, DIM, anchor="ra")
        d.line([PAD, y + 92, W - PAD, y + 92], fill=EDGE, width=2)
        _text(d, (PAD, y + 106), f"Stocks whose call AND put open interest both grew at least {n.STRONG_MIN_SHIFT:.0f}% the same way", 20, DIM)

    return 144, draw


def _tally(n_bull: int, n_bear: int, scanned: int) -> Block:
    total = max(1, n_bull + n_bear)

    def draw(d, y):
        half = (INNER - 16) / 2
        for i, (title, count, color, note) in enumerate((("BULLISH", n_bull, UP, "price up, call and put OI both building"), ("BEARISH", n_bear, DN, "price down, call and put OI both building"))):
            x0 = PAD + i * (half + 16)
            d.rounded_rectangle([x0, y, x0 + half, y + 132], radius=16, fill=PANEL, outline=color if count else EDGE, width=2)
            _text(d, (x0 + 24, y + 18), title, 20, DIM, True)
            _text(d, (x0 + 24, y + 42), str(count), 62, color if count else DIM, True)
            _text(d, (x0 + 24 + _width(d, str(count), 62, True) + 14, y + 80), f"of {scanned} stocks" if scanned else "stocks", 20, DIM)
            _text(d, (x0 + 24, y + 104), note, 17, DIM)
        # who is leading: one bar split in two
        by = y + 148
        d.rounded_rectangle([PAD, by, W - PAD, by + 14], radius=7, fill=EDGE)
        if n_bull + n_bear:
            bull_w = int(INNER * n_bull / total)
            if n_bull:
                d.rounded_rectangle([PAD, by, PAD + max(14, bull_w), by + 14], radius=7, fill=UP)
            if n_bear:
                d.rounded_rectangle([W - PAD - max(14, INNER - bull_w), by, W - PAD, by + 14], radius=7, fill=DN)

    return 176, draw


def _section(title: str, hint: str, rows: list[dict], total: int, color, scale: float) -> Block:
    def draw(d, y):
        _text(d, (PAD + 4, y), title, 22, color, True)
        _text(d, (W - PAD - 4, y + 4), hint, 17, DIM, anchor="ra")
        yy = y + 38
        if not rows:
            _panel(d, yy, 70)
            _text(d, (PAD + 24, yy + 20), "None today", 24, DIM, True)
            return
        for i, r in enumerate(rows, 1):
            _panel(d, yy, ROW_H - 8)
            d.ellipse([PAD + 18, yy + 20, PAD + 18 + 42, yy + 20 + 42], outline=color, width=3)
            _text(d, (PAD + 39, yy + 41), str(i), 22, color, True, anchor="mm")
            _text(d, (PAD + 78, yy + 8), _fit(d, r["symbol"], 30, 230, True), 30, TEXT, True)
            pc = r.get("price_change_pct")
            if pc is not None:
                pcol = UP if pc > 0 else DN if pc < 0 else DIM
                if pc:
                    _triangle(d, PAD + 80, yy + 52, pc > 0, 14, pcol)
                _text(d, (PAD + 102, yy + 46), f"price {signed_pct(pc)}", 20, pcol, True)
            for j, (label, key) in enumerate((("Call OI", "call_oi_change_pct"), ("Put OI", "put_oi_change_pct"))):
                by = yy + 12 + j * 32
                v = r[key]
                _text(d, (BAR_X - 16, by - 2), label, 17, DIM, anchor="ra")
                d.rounded_rectangle([BAR_X, by + 4, BAR_X + BAR_MAX, by + 18], radius=7, fill=EDGE)
                d.rounded_rectangle([BAR_X, by + 4, BAR_X + max(10, int(BAR_MAX * min(1.0, v / scale))), by + 18], radius=7, fill=color)
                _text(d, (W - PAD - 22, by - 3), f"+{v:.0f}%", 22, TEXT, True, anchor="ra")
            yy += ROW_H

    return 38 + (ROW_H * len(rows) if rows else 70) + 6, draw


def _footer() -> Block:
    def draw(d, y):
        _text(d, (PAD + 4, y + 8), "Option-chain activity for the day, not a prediction or a recommendation.", 17, DIM)

    return 40, draw


def render_oi_card(rows: list[dict], day: date, top_n: int) -> bytes:
    """The card as PNG bytes, from every F&O stock's end-of-day row (it finds the strong ones itself, as the text digest does)."""
    bull, bear, n_bull, n_bear = n.strong_oi(rows, top_n)
    shown = bull + bear
    # One shared scale so the bars compare, but capped: a single outlier (a stock whose OI tripled) must not squash everyone else to a sliver.
    # A value past the cap fills its bar; the label always carries the true number.
    scale = min(BAR_CAP, max([10.0] + [max(r["call_oi_change_pct"], r["put_oi_change_pct"]) for r in shown]))
    blocks: list[Block] = [
        _header(day),
        _tally(n_bull, n_bear, len(rows)),
        _section(f"STRONG BULLISH · TOP {len(bull)} OF {n_bull}" if bull else "STRONG BULLISH", "ranked by the size of the shift", bull, n_bull, UP, scale),
        _section(f"STRONG BEARISH · TOP {len(bear)} OF {n_bear}" if bear else "STRONG BEARISH", "ranked by the size of the shift", bear, n_bear, DN, scale),
        _footer(),
    ]
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
