"""The intraday credit-spread bot (PAPER ONLY).

Each cycle, for each enabled user and each of their symbols (NIFTY / BANKNIFTY), it reads four things market-data already publishes:

  trend      GET /regime         (ADX + structure trend on 15min)
  OI         GET /options/sentiment-history   (the latest recorded put-minus-call OI read: who is writing the options)
  structure  GET /order-blocks   (BOS/CHoCH trend on 15min)
  pre-market GET /premarket      (today's overnight bias; yesterday's report counts for nothing)

Each leans bullish (+1), bearish (-1) or nowhere (0). It trades only when at least `min_votes` lean one way and NONE lean the other. Bullish sells
a put spread, bearish a call spread, with the short strike on the OI WALL: the strike with the most open interest on the safe side of the spot
(the put wall below it, the call wall above it), and the long strike `width_strikes` further out. The size is the most lots whose max loss stays
within `risk_pct` of the NSE paper balance. One spread at a time, at most `max_trades_per_day` a day, inside the entry window only.

Exits: the underlying's stop sits ON the short strike (the wall failing is the thesis failing), the spread's own stop is half its max loss, its
target 70% of the credit, and the account's square-off time closes anything left. Every cycle writes a decision row (entered, skipped or
failed, and why) with the four reads and the numbers behind the strikes: the record the rule is reviewed and tested on.

It trades on the person's own NSE paper account, tagged `spread-bot` and marked auto-traded (so it is left out of the discipline score)."""

import logging
import math
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time as dt_time
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain.pending_orders import market_is_open

logger = logging.getLogger(__name__)

BOT_TAG = "spread-bot"
EXCHANGE = "NSE"
STRUCTURE_INTERVAL = "15min"
WALL_SEARCH_STRIKES = 10  # the wall is picked among this many strikes on the safe side of the spot
MIN_CREDIT_FRACTION = 0.10  # a spread paying under this share of its width is not worth the risk
STOP_FRACTION_OF_MAX_LOSS = 0.5
TARGET_FRACTION_OF_CREDIT = 0.7
_IST = ZoneInfo("Asia/Kolkata")


# --- the reads ------------------------------------------------------------------------------------------------------------


def _lean(word: Optional[str]) -> int:
    return {"up": 1, "trending_up": 1, "bullish": 1, "down": -1, "trending_down": -1, "bearish": -1}.get(word or "", 0)


def read_votes(regime: Optional[dict], sentiment: Optional[dict], structure: Optional[dict], premarket: Optional[dict]) -> dict[str, int]:
    """+1 / -1 / 0 for each of the four reads. A read that could not be had counts as 0."""
    return {
        "trend": _lean((regime or {}).get("regime")),
        "oi": _lean((sentiment or {}).get("direction")),
        "structure": _lean((structure or {}).get("trend")),
        "premarket": _lean((premarket or {}).get("bias")),
    }


def decide_bias(votes: dict[str, int], min_votes: int) -> tuple[Optional[str], str]:
    """('BUY' | 'SELL' | None, why). BUY = bullish (sell a put spread), SELL = bearish (sell a call spread)."""
    up = [k for k, v in votes.items() if v > 0]
    down = [k for k, v in votes.items() if v < 0]
    if up and down:
        return None, f"the reads disagree ({', '.join(up)} bullish; {', '.join(down)} bearish)"
    if len(up) >= min_votes:
        return "BUY", f"{len(up)} of 4 bullish ({', '.join(up)}), none bearish"
    if len(down) >= min_votes:
        return "SELL", f"{len(down)} of 4 bearish ({', '.join(down)}), none bullish"
    return None, f"only {max(len(up), len(down))} of 4 lean one way (need {min_votes})"


# --- the spread -------------------------------------------------------------------------------------------------------------


def pick_spread(chain: dict, bias: str, width_strikes: int) -> dict | str:
    """The spread to sell, or a sentence saying why there is none. BUY sells the put wall below the spot, SELL the call wall above it."""
    spot = float(chain["underlying_last_price"])
    side = "pe" if bias == "BUY" else "ce"
    rows = sorted((s for s in chain["strikes"] if s.get(side)), key=lambda s: s["strike"])
    if bias == "BUY":
        near = [s for s in rows if s["strike"] < spot][-WALL_SEARCH_STRIKES:]
    else:
        near = [s for s in rows if s["strike"] > spot][:WALL_SEARCH_STRIKES]
    near = [s for s in near if (s[side].get("oi") or 0) > 0]
    if not near:
        return "no strike with open interest on the safe side of the price"
    wall = max(near, key=lambda s: s[side]["oi"])
    i = rows.index(wall)
    j = i - width_strikes if bias == "BUY" else i + width_strikes
    if j < 0 or j >= len(rows):
        return "the chain has no strike far enough out for the long leg"
    far = rows[j]
    short_ltp, long_ltp = float(wall[side]["last_price"]), float(far[side]["last_price"])
    width = abs(wall["strike"] - far["strike"])
    credit = short_ltp - long_ltp
    if short_ltp <= 0 or long_ltp <= 0:
        return "a leg has no price"
    if credit <= 0 or credit >= width:
        return f"the spread does not pay a credit inside its width (credit {credit:.2f}, width {width:.0f})"
    if credit < MIN_CREDIT_FRACTION * width:
        return f"the credit {credit:.2f} is under {MIN_CREDIT_FRACTION:.0%} of the {width:.0f}-point width"
    return {
        "side": side, "short_strike": wall["strike"], "long_strike": far["strike"], "wall_oi": wall[side]["oi"], "spot": spot,
        "short_ltp": short_ltp, "long_ltp": long_ltp, "width": width, "credit": credit, "max_loss_per_unit": width - credit,
    }


def lots_for(balance: float, risk_pct: float, max_loss_per_unit: float, lot_size: float) -> int:
    """The most lots whose max loss stays within risk_pct of the balance (0 = not even one fits)."""
    per_lot = max_loss_per_unit * lot_size
    return int(math.floor((balance * risk_pct / 100.0) / per_lot)) if per_lot > 0 else 0


def combined_levels(spread: dict) -> tuple[float, float]:
    """The spread's own stop and target, as the combined premium (long leg minus short leg, negative for a credit): the same arithmetic the Scan
    ticket uses for its % of max loss / % of max profit."""
    net = spread["long_ltp"] - spread["short_ltp"]
    return net - STOP_FRACTION_OF_MAX_LOSS * spread["max_loss_per_unit"], net + TARGET_FRACTION_OF_CREDIT * spread["credit"]


# --- one cycle -----------------------------------------------------------------------------------------------------------


@dataclass
class BotDeps:
    """Injectable so the rule is testable without market-data or a broker."""

    get_json: Callable  # (path, params) -> dict | None (None = not found); raises on a failure
    get_expiry_list: Callable  # (exchange, symbol) -> list[str] | None
    get_option_chain: Callable  # (exchange, symbol, expiry) -> dict | None
    get_lot_size: Callable  # (exchange, symbol) -> float | None
    open_group: Callable  # (db, user_id, symbol, action, short_strike, long_strike, expiry, lots, notes) -> OptionPositionGroup
    set_spot_stop: Callable  # (db, user_id, group_id, price)
    set_combined_stop: Callable
    set_combined_target: Callable


def default_deps() -> BotDeps:
    from app.adapters.quotes.client import (
        get_expiry_list, get_json, get_lot_size, get_option_chain, get_ltp_batch, resolve_symbol_by_security_id, resolve_underlying,
    )
    from app.domain.option_position_manager import (
        open_manual_option_group, update_group_spot_stop_loss, update_group_stop_loss, update_group_target,
    )
    from app.domain.position_manager import load_settings

    def open_group(db, user_id, symbol, action, short_strike, long_strike, expiry, lots, notes):
        return open_manual_option_group(
            user_id, EXCHANGE, symbol, action, "credit_spread", "ATM", expiry, "combined", float(lots), load_settings(db, user_id), db, resolve_underlying,
            get_expiry_list, get_option_chain, get_ltp_batch, resolve_symbol_by_security_id, get_lot_size,
            primary_strike=short_strike, second_strike=long_strike, plan_checklist=[], order_type="market", setup_tag=BOT_TAG, notes=notes,
            trend_followed=False, risk_managed=True, auto_traded=True,
        )

    return BotDeps(get_json, get_expiry_list, get_option_chain, get_lot_size, open_group, update_group_spot_stop_loss, update_group_stop_loss, update_group_target)


def _record(db: Session, user_id, symbol, outcome, reason, votes=None, detail=None, group_id=None, now=None) -> None:
    db.add(db_models.SpreadBotDecision(
        user_id=user_id, symbol=symbol, outcome=outcome, reason=reason[:500], votes=votes, detail=detail, group_id=group_id, decided_at=now,
    ))
    db.commit()


def _symbols(cfg) -> list[str]:
    return [s.strip().upper() for s in (cfg.symbols or "").split(",") if s.strip()]


def _in_window(now_ist: datetime, start: dt_time, end: dt_time) -> bool:
    return start <= now_ist.time() < end


SENTIMENT_MAX_AGE_MINUTES = 20  # the recorder writes every five minutes; an older read is a stalled recorder, not a view


def _fresh_sentiment(history: Optional[dict], now: datetime) -> Optional[dict]:
    """The latest recorded OI read, if it is recent and was not an error."""
    for point in reversed((history or {}).get("points") or []):
        if point.get("error"):
            continue
        at = datetime.fromisoformat(str(point["recorded_at"]).replace("Z", "+00:00"))
        return point if (now - at).total_seconds() <= SENTIMENT_MAX_AGE_MINUTES * 60 else None
    return None


def _todays(report: Optional[dict], now_ist: datetime) -> Optional[dict]:
    """The pre-market report only if it is today's: with none yet, market-data serves the latest one, which is yesterday's view."""
    return report if report and str(report.get("day")) == now_ist.date().isoformat() else None


def _gather(deps: BotDeps, symbol: str, premarket_cache: dict, now: datetime) -> tuple[dict, dict]:
    """The four raw reads, and any that failed (a failed read counts as no lean, and is recorded)."""
    errors: dict[str, str] = {}

    def read(name, path, params):
        try:
            return deps.get_json(path, params)
        except Exception as exc:  # noqa: BLE001 - one read failing must not stop the others
            errors[name] = f"{type(exc).__name__}: {exc}"[:120]
            return None

    regime = read("regime", "/regime", {"exchange": EXCHANGE, "symbol": symbol, "interval": STRUCTURE_INTERVAL})
    structure = read("structure", "/order-blocks", {"exchange": EXCHANGE, "symbol": symbol, "interval": STRUCTURE_INTERVAL})
    sentiment = _fresh_sentiment(read("oi", "/options/sentiment-history", {"symbol": symbol}), now)
    if "premarket" not in premarket_cache:
        premarket_cache["premarket"] = _todays(read("premarket", "/premarket", {}), now.astimezone(_IST))
    return {"regime": regime, "structure": structure, "sentiment": sentiment, "premarket": premarket_cache["premarket"]}, errors


def run_bot_for_user(db: Session, cfg, deps: BotDeps, now: datetime, premarket_cache: Optional[dict] = None) -> dict:
    """One cycle for one user. Returns counts: entered / skipped / failed."""
    from app.domain.position_manager import load_account

    counts = {"entered": 0, "skipped": 0, "failed": 0}
    premarket_cache = premarket_cache if premarket_cache is not None else {}
    now_ist = now.astimezone(_IST)
    if not market_is_open(EXCHANGE, now) or not _in_window(now_ist, cfg.entry_from, cfg.entry_to):
        return counts
    user_id = cfg.user_id
    account = load_account(db, user_id, EXCHANGE)
    if account is None or account.live_trading_enabled:
        return counts  # paper only; a live account is never touched, and nothing is logged every five minutes for it

    G = db_models.OptionPositionGroup
    if db.query(G).filter(G.user_id == user_id, G.status == "OPEN", G.setup_tag == BOT_TAG).count():
        return counts  # one spread at a time
    D = db_models.SpreadBotDecision
    day_start = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    if db.query(D).filter(D.user_id == user_id, D.outcome == "entered", D.decided_at >= day_start).count() >= cfg.max_trades_per_day:
        return counts

    for symbol in _symbols(cfg):
        reads, errors = _gather(deps, symbol, premarket_cache, now)
        votes = read_votes(reads["regime"], reads["sentiment"], reads["structure"], reads["premarket"])
        detail = {"errors": errors} if errors else {}
        bias, why = decide_bias(votes, cfg.min_votes)
        if bias is None:
            _record(db, user_id, symbol, "skipped", why, votes, detail, now=now)
            counts["skipped"] += 1
            continue
        try:
            outcome = _enter(db, cfg, deps, account, symbol, bias, why, votes, detail, now_ist, now)
        except Exception as exc:  # noqa: BLE001 - recorded, and the next symbol still gets its turn
            logger.exception("spread bot: %s failed for %s", symbol, user_id)
            db.rollback()
            _record(db, user_id, symbol, "failed", f"{type(exc).__name__}: {exc}", votes, detail, now=now)
            outcome = "failed"
        counts[outcome] += 1
        if outcome == "entered":
            break  # one at a time
    return counts


def _enter(db, cfg, deps: BotDeps, account, symbol, bias, why, votes, detail, now_ist: datetime, now: datetime) -> str:
    user_id = cfg.user_id
    today: date = now_ist.date()
    expiries = sorted(e for e in (deps.get_expiry_list(EXCHANGE, symbol) or []) if e > today.isoformat())  # never the day it expires
    if not expiries:
        _record(db, user_id, symbol, "skipped", f"{why}; but there is no expiry after today to sell", votes, detail, now=now)
        return "skipped"
    expiry = expiries[0]
    chain = deps.get_option_chain(EXCHANGE, symbol, expiry)
    if not chain:
        _record(db, user_id, symbol, "skipped", f"{why}; but the option chain could not be read", votes, detail, now=now)
        return "skipped"
    spread = pick_spread(chain, bias, cfg.width_strikes)
    if isinstance(spread, str):
        _record(db, user_id, symbol, "skipped", f"{why}; but {spread}", votes, detail, now=now)
        return "skipped"
    lot_size = deps.get_lot_size(EXCHANGE, symbol) or 0
    lots = lots_for(float(account.current_balance), float(cfg.risk_pct), spread["max_loss_per_unit"], lot_size)
    detail = {**detail, "expiry": expiry, "lot_size": lot_size, "lots": lots, **spread}
    if lots < 1:
        need = spread["max_loss_per_unit"] * lot_size
        _record(db, user_id, symbol, "skipped", f"{why}; but one lot risks {need:,.0f}, more than {cfg.risk_pct}% of the balance", votes, detail, now=now)
        return "skipped"

    action = "BUY" if bias == "BUY" else "SELL"
    notes = f"Spread bot: {why}. Short {spread['short_strike']:g} (the OI wall, {spread['wall_oi']:,} open interest), long {spread['long_strike']:g}."
    group = deps.open_group(db, user_id, symbol, action, spread["short_strike"], spread["long_strike"], expiry, lots, notes)
    if group.status == "REJECTED":
        _record(db, user_id, symbol, "failed", f"{why}; rejected: {group.rejection_reason}", votes, detail, group_id=group.id, now=now)
        return "failed"

    problems = []
    stop, target = combined_levels(spread)
    for label, setter, price in (
        ("underlying stop", deps.set_spot_stop, spread["short_strike"]),
        ("spread stop", deps.set_combined_stop, stop),
        ("spread target", deps.set_combined_target, target),
    ):
        try:
            setter(db, user_id, group.id, float(price))
        except Exception as exc:  # noqa: BLE001 - the spread is open; say which protection did not attach
            logger.exception("spread bot: the %s did not attach to %s", label, group.id)
            problems.append(f"{label}: {exc}"[:100])
    reason = f"{why}. Sold {spread['short_strike']:g}/{spread['long_strike']:g} for {spread['credit']:.2f}, {lots} lot(s)."
    if problems:
        reason += " NOT ATTACHED: " + "; ".join(problems)
        detail = {**detail, "not_attached": problems}
    _record(db, user_id, symbol, "entered", reason, votes, detail, group_id=group.id, now=now)
    return "entered"


def run_spread_bot(db: Session, deps: BotDeps, now: Optional[datetime] = None) -> dict:
    """The scheduler's pass: one cycle for every user who has switched the bot on."""
    now = now or datetime.now(ZoneInfo("UTC"))
    total = {"entered": 0, "skipped": 0, "failed": 0}
    premarket_cache: dict = {}
    for cfg in db.query(db_models.SpreadBotSettings).filter(db_models.SpreadBotSettings.enabled.is_(True)).all():
        try:
            counts = run_bot_for_user(db, cfg, deps, now, premarket_cache)
        except Exception:  # noqa: BLE001 - one user must not stop the others
            logger.exception("spread bot: cycle failed for %s", cfg.user_id)
            db.rollback()
            continue
        for k, v in counts.items():
            total[k] += v
    return total
