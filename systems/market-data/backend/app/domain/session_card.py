"""The post-session summary as a picture, your own trading first: the account (today's change, balance, the equity curve), how the last 30
days have gone, which trades were good and which were not (judged by the PLAN, not the result), each trade with its verdict, and only then
a thin strip for the market.

Drawn with Pillow from the same data the text message uses (app/domain/notifications.py's session_message), so the two agree; the text is
still sent as the fallback when a card cannot be drawn or sent, and it is what the delivery history keeps.

Fonts: DejaVu Sans (installed in the image; it has the rupee sign and the proper minus). Without it the card falls back to Pillow's built-in
font and writes "Rs " and "-" instead, so it still renders (tests and a dev machine without the font)."""

from __future__ import annotations

import io
import os
from datetime import date
from typing import Callable, Optional

from PIL import Image, ImageDraw, ImageFont

from app.domain import notifications as n

BG, PANEL, EDGE = (15, 18, 22), (23, 28, 34), (44, 52, 62)
TEXT, DIM = (230, 233, 238), (147, 161, 177)
UP, DN, WARN = (61, 220, 151), (255, 107, 107), (245, 183, 74)
W, PAD = 1080, 40
INNER = W - 2 * PAD

_FONT_DIRS = ("/usr/share/fonts/truetype/dejavu", "C:/Windows/Fonts")
_cache: dict[tuple[int, bool], ImageFont.ImageFont] = {}


def _font_path(bold: bool) -> Optional[str]:
    for d in _FONT_DIRS:
        p = os.path.join(d, "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
        if os.path.exists(p):
            return p
    return None


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


def money(v: float, segment: str, plain: bool = False) -> str:
    sign = "" if plain else ("+" if v > 0 else minus() if v < 0 else "")
    return f"{sign}{'$' if segment == 'CRYPTO' else rupee()}{abs(v):,.0f}"


def signed_pct(v: Optional[float], digits: int = 2) -> str:
    if v is None:
        return "-"
    return f"{'+' if v > 0 else minus() if v < 0 else ''}{abs(v):.{digits}f}%"


def level(v: float) -> str:
    return f"{v:,.0f}" if v >= 1000 else f"{v:,.2f}"


def tone(v: Optional[float]):
    return DIM if v is None or v == 0 else UP if v > 0 else DN


# ---- drawing helpers -------------------------------------------------------------------------------------------------------------


def _text(d, xy, s: str, size: int, color=TEXT, bold=False, anchor="la"):
    d.text(xy, s, font=font(size, bold), fill=color, anchor=anchor)


def _width(d, s: str, size: int, bold=False) -> float:
    return d.textlength(s, font=font(size, bold))


def _fit(d, s: str, size: int, max_w: float, bold=False) -> str:
    """The text, shortened with an ellipsis if it would run wider than `max_w`."""
    if _width(d, s, size, bold) <= max_w:
        return s
    while len(s) > 1 and _width(d, s + "…", size, bold) > max_w:
        s = s[:-1]
    return s + "…"


def _triangle(d, x: float, y: float, up: bool, size: int, color):
    pts = [(x, y + size), (x + size, y + size), (x + size / 2, y)] if up else [(x, y), (x + size, y), (x + size / 2, y + size)]
    d.polygon(pts, fill=color)


def _panel(d, y: int, h: int, outline=None):
    d.rounded_rectangle([PAD, y, W - PAD, y + h], radius=16, fill=PANEL, outline=outline, width=2 if outline else 0)


def _pill(d, xy, s: str, size: int, color):
    x, y = xy
    w = _width(d, s, size, True) + 28
    h = size + 16
    d.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, outline=color, width=2)
    _text(d, (x + 14, y + 7), s, size, color, True)
    return w


def _mark(d, cx: int, cy: int, verdict: str):
    """A round badge: a tick for a good trade, an exclamation for a win off the plan, a cross for an avoidable loss."""
    color = UP if verdict in ("good_win", "good_loss") else WARN if verdict == "lucky_win" else DN if verdict == "avoidable_loss" else DIM
    d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], outline=color, width=3)
    if verdict in ("good_win", "good_loss"):
        d.line([(cx - 10, cy), (cx - 3, cy + 8), (cx + 11, cy - 8)], fill=color, width=4, joint="curve")
    elif verdict == "lucky_win":
        d.line([(cx, cy - 11), (cx, cy + 2)], fill=color, width=4)
        d.ellipse([cx - 2.5, cy + 8, cx + 2.5, cy + 13], fill=color)
    elif verdict == "avoidable_loss":
        d.line([(cx - 9, cy - 9), (cx + 9, cy + 9)], fill=color, width=4)
        d.line([(cx - 9, cy + 9), (cx + 9, cy - 9)], fill=color, width=4)
    else:
        d.line([(cx - 9, cy), (cx + 9, cy)], fill=color, width=4)


def _sparkline(d, x: int, y: int, w: int, h: int, values: list[float], color):
    """The equity curve as a line with a soft fill under it and a dot on the latest value."""
    if len(values) < 2:
        d.line([(x, y + h // 2), (x + w, y + h // 2)], fill=EDGE, width=2)
        return
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1.0
    pts = [(x + i * w / (len(values) - 1), y + h - (v - lo) / span * h) for i, v in enumerate(values)]
    d.polygon(pts + [(x + w, y + h), (x, y + h)], fill=(color[0] // 6 + 20, color[1] // 6 + 22, color[2] // 6 + 24))
    d.line(pts, fill=color, width=4, joint="curve")
    px, py = pts[-1]
    d.ellipse([px - 7, py - 7, px + 7, py + 7], fill=color, outline=BG, width=3)


# ---- the blocks, each (height, draw) ------------------------------------------------------------------------------------------------

Block = tuple[int, Callable]


def _header(segment: str, day: date) -> Block:
    title = {"NSE": "NSE", "MCX": "MCX", "CRYPTO": "crypto"}[segment]

    def draw(d, y):
        _text(d, (PAD, y + 24), "Your trading day", 42, TEXT, True)
        _text(d, (W - PAD, y + 38), f"{title} · {day.strftime('%a')} {day.day} {day.strftime('%b %Y')}", 24, DIM, anchor="ra")
        d.line([PAD, y + 92, W - PAD, y + 92], fill=EDGE, width=2)

    return 112, draw


def _hero(segment: str, trader: dict) -> Block:
    acct = trader.get("account")
    paper = trader.get("paper")
    day_change = acct["day_change"] if acct else (paper["net_pnl"] if paper else 0.0)

    def draw(d, y):
        _panel(d, y, 214)
        _text(d, (PAD + 26, y + 20), "PAPER ACCOUNT · TODAY", 20, DIM, True)
        _text(d, (PAD + 26, y + 50), money(day_change, segment), 70, tone(day_change) if (paper or acct) else DIM, True)
        if acct and acct.get("day_change_pct") is not None:
            _text(d, (PAD + 26, y + 138), f"{signed_pct(acct['day_change_pct'])} of the account", 26, tone(day_change), True)
        elif not paper:
            _text(d, (PAD + 26, y + 138), "No closed paper trades today", 24, DIM, True)
        if acct:
            _text(d, (PAD + 26, y + 176), f"Balance {money(acct['balance'], segment, plain=True)}", 22, TEXT, True)
            sx = PAD + 26 + _width(d, f"Balance {money(acct['balance'], segment, plain=True)}", 22, True) + 30
            if acct.get("since_start_pct") is not None:
                t = f"{signed_pct(acct['since_start_pct'])} since the start"
                _text(d, (sx, y + 177), t, 20, tone(acct["since_start_pct"]))
                sx += _width(d, t, 20) + 26
            _text(d, (sx, y + 177), f"{money(acct['month_pnl'], segment)} this month", 20, tone(acct["month_pnl"]))
            curve = acct.get("curve") or []
            cx, cw = 640, W - PAD - 26 - 640
            _text(d, (cx, y + 20), f"EQUITY · LAST {max(len(curve) - 1, 1)} DAYS", 18, DIM, True)
            _sparkline(d, cx, y + 56, cw, 96, curve, UP if (curve and curve[-1] >= curve[0]) else DN)
            if acct.get("max_drawdown_pct") is not None:
                _text(d, (W - PAD - 26, y + 168), f"max drawdown {signed_pct(-abs(acct['max_drawdown_pct']), 1)}", 18, DIM, anchor="ra")

    return 230, draw


def _live_strip(segment: str, live: dict) -> Block:
    def draw(d, y):
        _panel(d, y, 80)
        _pill(d, (PAD + 24, y + 18), "LIVE", 20, WARN)
        _text(d, (PAD + 130, y + 22), f"{live['trades']} closed · {live['wins']} won" + (f" · {live['losses']} lost" if live["losses"] else ""), 24, TEXT, True)
        _text(d, (W - PAD - 24, y + 14), money(live["net_pnl"], segment), 44, tone(live["net_pnl"]), True, anchor="ra")

    return 96, draw


def _scorecard(segment: str, st: dict) -> Block:
    tiles = [("WIN RATE", f"{st['win_rate_pct']:.0f}%", UP if st["win_rate_pct"] >= 50 else DN, f"{st['trades']} trades")]
    if st.get("profit_factor") is not None:
        tiles.append(("PROFIT FACTOR", f"{st['profit_factor']:.1f}", UP if st["profit_factor"] >= 1 else DN, "wins ÷ losses"))
    else:
        tiles.append(("PROFIT FACTOR", "∞" if has_real_font() else "n/a", UP, "no losing trade"))
    if st.get("avg_win") is not None and st.get("avg_loss"):
        ratio = abs(st["avg_win"] / st["avg_loss"])
        tiles.append(("AVG WIN / LOSS", f"{ratio:.1f}x", UP if ratio >= 1 else DN, f"{money(st['avg_win'], segment, True)} / {money(abs(st['avg_loss']), segment, True)}"))
    else:
        tiles.append(("AVG WIN / LOSS", "-", DIM, "needs a win and a loss"))
    if st.get("expectancy") is not None:
        tiles.append(("EXPECTANCY", money(st["expectancy"], segment), tone(st["expectancy"]), "per trade"))

    def draw(d, y):
        _text(d, (PAD + 4, y), f"LAST {st['days']} DAYS", 20, DIM, True)
        gap = 16
        tw = (INNER - gap * (len(tiles) - 1)) / len(tiles)
        for i, (label, value, color, sub) in enumerate(tiles):
            x0 = PAD + i * (tw + gap)
            d.rounded_rectangle([x0, y + 34, x0 + tw, y + 164], radius=14, fill=PANEL)
            _text(d, (x0 + 18, y + 48), label, 16, DIM, True)
            _text(d, (x0 + 18, y + 78), value, 38, color, True)
            _text(d, (x0 + 18, y + 132), _fit(d, sub, 17, tw - 30), 17, DIM)

    return 184, draw


def _plan_block(segment: str, mode: dict) -> Block:
    insight = n.plan_insight(mode, segment)

    def draw(d, y):
        _text(d, (PAD + 4, y), "GOOD VS BAD · JUDGED BY THE PLAN, NOT THE RESULT", 20, DIM, True)
        half = (INNER - 16) / 2
        for i, (title, count, pnl, color) in enumerate((
            ("Followed the plan", mode["followed_count"], mode["followed_pnl"], UP),
            ("Broke the plan", mode["broke_count"], mode["broke_pnl"], DN if mode["broke_count"] else DIM),
        )):
            x0 = PAD + i * (half + 16)
            d.rounded_rectangle([x0, y + 34, x0 + half, y + 164], radius=14, fill=PANEL, outline=color if count else EDGE, width=2)
            _text(d, (x0 + 22, y + 48), title, 24, color if count else DIM, True)
            _text(d, (x0 + 22, y + 88), f"{count} trade{'s' if count != 1 else ''}", 22, DIM)
            _text(d, (x0 + half - 22, y + 76), money(pnl, segment) if count else "-", 44, tone(pnl) if count else DIM, True, anchor="ra")
        if insight:
            _text(d, (PAD + 4, y + 182), _fit(d, insight, 22, INNER - 8), 22, TEXT)

    return 226 if insight else 184, draw


def _trade_rows(segment: str, mode: dict, name: str) -> Block:
    items = mode.get("items") or []
    more = mode.get("more", 0)

    def draw(d, y):
        _text(d, (PAD + 4, y), f"{name.upper()} TRADES", 20, DIM, True)
        yy = y + 34
        for it in items:
            _panel(d, yy, 92)
            _mark(d, PAD + 44, yy + 46, it["verdict"])
            side = {"long": "Long", "short": "Short"}.get(it.get("side") or "", "")
            head = f"{it['symbol']}" + (f"  {it['label']}" if it.get("label") else "") + (f"  ·  {side}" if side else "")
            _text(d, (PAD + 86, yy + 14), _fit(d, head, 26, 520, True), 26, TEXT, True)
            note = n.trade_note(it)
            _text(d, (PAD + 86, yy + 52), _fit(d, note, 19, 560), 19, DIM if it["verdict"] in ("good_win", "good_loss", "flat") else (WARN if it["verdict"] == "lucky_win" else DN))
            r = f"  {it['r']:+.1f}R".replace("-", minus()) if it.get("r") is not None else ""
            _text(d, (W - PAD - 24, yy + 12), money(it["pnl"], segment), 34, tone(it["pnl"]), True, anchor="ra")
            sub = f"{n._price(it.get('entry'))} → {n._price(it.get('exit'))}" if it.get("entry") and it.get("exit") else ""
            held = f" · {n._held(it.get('held_minutes'))}" if it.get("held_minutes") is not None else ""
            _text(d, (W - PAD - 24, yy + 58), f"{sub}{held}{r}".strip(), 18, DIM, anchor="ra")
            yy += 100
        if more:
            _text(d, (PAD + 4, yy + 2), f"…and {more} more in the app", 20, DIM)

    return 34 + 100 * len(items) + (34 if more else 0) + 10, draw


def _no_trades() -> Block:
    def draw(d, y):
        _panel(d, y, 84)
        _text(d, (PAD + 26, y + 26), "You had no closed trades today.", 28, DIM, True)

    return 100, draw


def _unknown() -> Block:
    def draw(d, y):
        _panel(d, y, 84, WARN)
        _text(d, (PAD + 26, y + 26), "Your trades could not be loaded just now.", 28, WARN, True)

    return 100, draw


def _market_strip(market: dict, bias_held: Optional[tuple[str, bool]]) -> Block:
    def draw(d, y):
        _text(d, (PAD + 4, y), "THE MARKET", 20, DIM, True)
        x = PAD
        yy = y + 34
        for r in market["rows"]:
            label = f"{r['label']}  {signed_pct(r['change_pct'])}"
            w = _width(d, label, 22, True) + 54
            d.rounded_rectangle([x, yy, x + w, yy + 48], radius=24, fill=PANEL)
            if r["change_pct"]:
                _triangle(d, x + 16, yy + 16, r["change_pct"] > 0, 15, tone(r["change_pct"]))
            _text(d, (x + 40, yy + 11), label, 22, tone(r["change_pct"]), True)
            x += w + 12
        if bias_held:
            held = bias_held[1]
            label = f"Bias {bias_held[0]} · {'held' if held else 'did not hold'}"
            w = _width(d, label, 22, True) + 32
            if x + w > W - PAD:
                x, yy = PAD, yy + 60
            d.rounded_rectangle([x, yy, x + w, yy + 48], radius=24, outline=UP if held else DN, width=2)
            _text(d, (x + 16, yy + 11), label, 22, UP if held else DN, True)

    wraps = 1  # one row of chips; the bias chip wraps to a second only when it does not fit
    return 34 + 48 + 14 + (60 if len(market["rows"]) >= 3 and bias_held else 0), draw


def _footer(trader: Optional[dict]) -> Block:
    def draw(d, y):
        score = trader.get("discipline_score") if trader else None
        if score is not None:
            _text(d, (PAD + 4, y), "DISCIPLINE · 30 DAYS", 18, DIM, True)
            d.rounded_rectangle([PAD + 4, y + 30, PAD + 4 + 420, y + 42], radius=6, fill=EDGE)
            d.rounded_rectangle([PAD + 4, y + 30, PAD + 4 + max(12, int(420 * score / 100)), y + 42], radius=6, fill=UP if score >= 60 else WARN if score >= 40 else DN)
            _text(d, (PAD + 450, y + 22), f"{score}/100", 26, TEXT, True)
        if trader and trader.get("open_now"):
            _text(d, (W - PAD - 4, y + 18), f"Still open: {trader['open_now']}", 24, TEXT, True, anchor="ra")
        _text(d, (PAD + 4, y + 72), "Your own record and public market data, not a recommendation.", 17, DIM)

    return 104, draw


def render_session_card(segment: str, day: date, market: dict, trader: Optional[dict], bias_held: Optional[tuple[str, bool]] = None, trader_known: bool = True) -> bytes:
    """The card as PNG bytes. `bias_held` is (the morning's bias, whether it held) for NSE, else None."""
    blocks: list[Block] = [_header(segment, day)]
    if not trader_known or trader is None:
        blocks.append(_unknown())
    else:
        paper, live = trader.get("paper"), trader.get("live")
        stats = (trader.get("stats") or {}).get("paper") or (trader.get("stats") or {}).get("live")
        if trader.get("account") or paper:
            blocks.append(_hero(segment, trader))
        if live:
            blocks.append(_live_strip(segment, live))
        if not paper and not live:
            blocks.append(_no_trades())
        if stats:
            blocks.append(_scorecard(segment, stats))
        for name, m in (("Paper", paper), ("Live", live)):
            if m:
                blocks.append(_plan_block(segment, m))
                blocks.append(_trade_rows(segment, m, name))
    blocks.append(_market_strip(market, bias_held))
    blocks.append(_footer(trader if trader_known else None))
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
