"""The end-of-day OI digest as a picture: four boxes, price against open interest.

    top row (bullish, green):   LONG BUILDUP (price up, OI up)       |  SHORT COVERING (price up, OI down)
    bottom row (bearish, red):  SHORT BUILDUP (price down, OI up)    |  LONG UNWINDING (price down, OI down)

Each box lists the stocks with the biggest OI change first, with the price move beside it and a bar for the size of the OI change on one shared
scale. A star marks a stock whose call AND put OI both grew a lot the same way (the older "strong two-sided build"), so that signal is not lost.

Drawn with Pillow from the same rows the text digest uses (app/domain/oi_quadrants.py), so the two always agree; the text is still sent as the
fallback and is what the delivery history keeps. Shares its fonts and drawing helpers with the other cards."""

from __future__ import annotations

import io
from datetime import date
from typing import Callable

from PIL import Image, ImageDraw

from app.domain import oi_quadrants as oiq
from app.domain.session_card import BG, DIM, DN, EDGE, INNER, PAD, PANEL, TEXT, UP, W, WARN, _fit, _text, _triangle, _width, minus, signed_pct

Block = tuple[int, Callable]
GAP = 16
BOX_W = (INNER - GAP) // 2
HEAD_H = 96
ROW_H = 76
BAR_CAP = 100.0  # percent of OI change that fills a bar; a bigger one fills it and the label carries the true number
COLOR = {"long_buildup": UP, "short_covering": UP, "short_buildup": DN, "long_unwinding": DN}


def _header(day: date) -> Block:
    def draw(d, y):
        _text(d, (PAD, y + 24), "OI buildup", 42, TEXT, True)
        _text(d, (W - PAD, y + 38), f"NSE F&O · {day.strftime('%a')} {day.day} {day.strftime('%b')} close", 22, DIM, anchor="ra")
        d.line([PAD, y + 92, W - PAD, y + 92], fill=EDGE, width=2)

    return 104, draw


def _lean(groups: dict) -> Block:
    bull = sum(groups[q]["total"] for q in oiq.BULLISH)
    bear = sum(groups[q]["total"] for q in oiq.BEARISH)
    total = max(1, bull + bear)

    def draw(d, y):
        _text(d, (PAD + 4, y), f"{bull} BULLISH", 24, UP if bull else DIM, True)
        _text(d, (W - PAD - 4, y), f"{bear} BEARISH", 24, DN if bear else DIM, True, anchor="ra")
        _text(d, (W // 2, y + 4), "stocks that cleared the noise floors", 18, DIM, anchor="ma")
        by = y + 40
        d.rounded_rectangle([PAD, by, W - PAD, by + 14], radius=7, fill=EDGE)
        if bull + bear:
            bw = int(INNER * bull / total)
            if bull:
                d.rounded_rectangle([PAD, by, PAD + max(14, bw), by + 14], radius=7, fill=UP)
            if bear:
                d.rounded_rectangle([W - PAD - max(14, INNER - bw), by, W - PAD, by + 14], radius=7, fill=DN)

    return 66, draw


def _box_height(n_rows: int) -> int:
    return HEAD_H + (ROW_H * n_rows if n_rows else 56) + 14


def _draw_box(d, x0: int, y: int, h: int, key: str, group: dict, scale: float):
    color = COLOR[key]
    d.rounded_rectangle([x0, y, x0 + BOX_W, y + h], radius=16, fill=PANEL, outline=color if group["total"] else EDGE, width=2)
    _text(d, (x0 + 22, y + 16), oiq.LABEL[key], 28, color if group["total"] else DIM, True)
    _text(d, (x0 + BOX_W - 22, y + 22), f"{group['total']} stock{'s' if group['total'] != 1 else ''}", 20, DIM, True, anchor="ra")
    _text(d, (x0 + 22, y + 56), _fit(d, oiq.MEANING[key], 18, BOX_W - 44), 18, DIM)
    yy = y + HEAD_H
    if not group["items"]:
        _text(d, (x0 + 22, yy + 12), "None today", 22, DIM, True)
        return
    for i, it in enumerate(group["items"], 1):
        d.line([x0 + 18, yy, x0 + BOX_W - 18, yy], fill=EDGE, width=1)
        _text(d, (x0 + 22, yy + 12), str(i), 18, color, True)
        sym = _fit(d, it["symbol"], 25, 190, True)
        _text(d, (x0 + 50, yy + 8), sym, 25, TEXT, True)
        if it["strong"]:
            _text(d, (x0 + 50 + _width(d, sym, 25, True) + 8, yy + 8), "★", 22, WARN, True)
        pc = it["price_change_pct"]
        pcol = UP if pc > 0 else DN
        _triangle(d, x0 + 52, yy + 47, pc > 0, 12, pcol)
        _text(d, (x0 + 72, yy + 42), f"price {signed_pct(pc)}", 18, pcol, True)
        oi = it["oi_change_pct"]
        _text(d, (x0 + BOX_W - 22, yy + 6), f"OI {'+' if oi > 0 else minus()}{abs(oi):.1f}%", 22, TEXT, True, anchor="ra")
        bx, bw = x0 + 250, BOX_W - 250 - 22
        d.rounded_rectangle([bx, yy + 48, bx + bw, yy + 58], radius=5, fill=EDGE)
        d.rounded_rectangle([bx, yy + 48, bx + max(8, int(bw * min(1.0, abs(oi) / scale))), yy + 58], radius=5, fill=color)
        yy += ROW_H


def _row_of_boxes(keys: tuple[str, str], groups: dict, scale: float) -> Block:
    h = max(_box_height(len(groups[k]["items"])) for k in keys)

    def draw(d, y):
        for i, k in enumerate(keys):
            _draw_box(d, PAD + i * (BOX_W + GAP), y, h, k, groups[k], scale)

    return h, draw


def _footer(top_n: int) -> Block:
    def draw(d, y):
        _text(d, (PAD + 4, y), "★ call and put OI both grew 10% or more the same way", 18, WARN)
        _text(d, (PAD + 4, y + 30), f"Top {top_n} per box, biggest OI change first. Moves under {oiq.MIN_PRICE_MOVE_PCT:g}% in price or {oiq.MIN_OI_CHANGE_PCT:g}% in total OI are left out.", 17, DIM)
        _text(d, (PAD + 4, y + 58), "Option-chain activity for the day, not a prediction or a recommendation.", 17, DIM)

    return 88, draw


def render_oi_card(rows: list[dict], day: date, top_n: int) -> bytes:
    """The card as PNG bytes, from every F&O stock's end-of-day row (it sorts them into the four boxes itself, as the text digest does)."""
    groups = oiq.by_quadrant(rows, top_n)
    shown = [i for g in groups.values() for i in g["items"]]
    # One shared scale so the bars compare, but capped: one stock whose OI doubled must not squash every other bar to a sliver.
    scale = min(BAR_CAP, max([oiq.MIN_OI_CHANGE_PCT * 2] + [abs(i["oi_change_pct"]) for i in shown]))
    blocks: list[Block] = [
        _header(day),
        _lean(groups),
        _row_of_boxes(("long_buildup", "short_covering"), groups, scale),
        _row_of_boxes(("short_buildup", "long_unwinding"), groups, scale),
        _footer(top_n),
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
