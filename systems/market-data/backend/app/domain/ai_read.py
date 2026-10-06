"""AI read for the OI strip - bundles the data market-data already has for one
underlying (OI summary, IV skew, volume PCR, session VWAP/day levels, ADX regime,
SMC structure) into one prompt and asks an OpenRouter model for a short
bias + reasoning. On demand only (GET /ai-read), never on a timer - each call
costs the caller's own OpenRouter credit.

The model is told exactly what it was NOT given (see `not_provided` in
build_context) so it doesn't invent it."""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

from app.config import settings
from app.domain import ai_models
from app.domain.models import Candle, ChartStructure, EconomicEvent, MarketRegime, NewsDigest, OptionOiSummary
from app.providers.news import OPENROUTER_URL, _parse_ai_json

logger = logging.getLogger(__name__)

# What is never available, per market. India VIX / news / events are added to `not_provided` per call only
# when they apply to the market and their own fetch failed - see build_context.
DATA_GAPS = {
    "NSE": ["futures OI/volume", "market breadth"],
    "MCX": ["futures OI/volume", "USD/INR and the global benchmark price (COMEX gold, Brent/WTI)", "inventory and positioning data"],
    "CRYPTO": ["perpetual funding rate and basis", "spot-vs-perpetual premium", "exchange flows and liquidations"],
}

# One short paragraph per market, appended to the system prompt, so the read uses the vocabulary and the drivers
# that matter for that instrument instead of treating everything as an Indian index.
SEGMENT_NOTES = {
    "NSE": (
        "Market: NSE index/stock options. India VIX is the volatility gauge. Weekly expiry makes put/call positioning "
        "and gamma around round strikes matter more close to expiry. Hours 09:15-15:30 IST."
    ),
    "MCX": (
        "Market: MCX commodity options, which are options on the commodity FUTURES contract (the price given is that "
        "contract's price, not a spot index). There is no India VIX here - judge volatility from the option IV and the "
        "ATR percentile. Prices are driven by global benchmarks (gold: dollar and US yields; crude: inventories, OPEC "
        "and geopolitics) that were NOT provided, plus the USD/INR rate - say so rather than guess. Hours are long "
        "(to 23:30 IST), so US data releases fall inside the session."
    ),
    "CRYPTO": (
        "Market: crypto options on a 24/7 market with no sessions, no VIX and no daily close; 'session' levels here "
        "mean since 00:00 IST. Volatility is much higher than the other markets, so judge moves against the ATR "
        "percentile and the option IV (already in percent). Funding rate/perpetual basis were NOT provided, so don't "
        "infer leverage positioning from them. Liquidity thins at weekends. OI is a plain contract count."
    ),
}
_TOP_STRIKES = 5
_RECENT_CANDLES = 8
_FLOW_STRIKES_EACH_SIDE = 6  # strikes either side of spot counted in the writing/buying tally
_NEWS_ARTICLES = 3
_EVENTS_MAX = 5
_EVENT_WINDOW = (timedelta(hours=-6), timedelta(hours=48))

# What each per-leg buildup (OI direction x premium direction) means for the leg's side.
# Inferred, not observed - exchange data never says who initiated a trade.
_MEANING = {
    ("CE", "short_buildup"): "call writing (resistance building)",
    ("CE", "long_buildup"): "call buying (bullish bet or hedge)",
    ("CE", "short_covering"): "call writers exiting (resistance weakening)",
    ("CE", "long_unwinding"): "call longs exiting",
    ("PE", "short_buildup"): "put writing (support building)",
    ("PE", "long_buildup"): "put buying (bearish bet or hedge)",
    ("PE", "short_covering"): "put writers exiting (support weakening)",
    ("PE", "long_unwinding"): "put longs exiting",
}

READ_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["bias", "confidence", "one_liner", "reasoning", "support", "resistance", "risks", "wait_for"],
    "properties": {
        "bias": {"type": "string", "enum": ["bullish", "bearish", "neutral"]},
        "confidence": {"type": "integer"},
        "one_liner": {"type": "string"},
        "reasoning": {"type": "array", "items": {"type": "string"}},
        "support": {"type": "array", "items": {"type": "number"}},
        "resistance": {"type": "array", "items": {"type": "number"}},
        "risks": {"type": "array", "items": {"type": "string"}},
        "wait_for": {"type": "string"},
    },
}

_SYSTEM_PROMPT = (
    "You are an options-market analyst for an Indian intraday trader. You are given a JSON snapshot for one "
    "underlying: OI/PCR flow, IV, session price levels, ADX regime and SMC structure. Give a short, decisive read. "
    "Rules: use ONLY the numbers given - never invent prices, news, futures OI or VIX. The fields listed under "
    "`not_provided` are unknown, so say when a conclusion would depend on them. `vix` is India VIX (rising VIX "
    "with put buying = hedging demand; falling VIX with put writing = complacency/support). `news` and `events` "
    "are context only - weigh a high-impact event due soon as a reason for caution, and don't let a headline "
    "override the flow data. PCR convention: higher put OI/volume "
    "than call is read as bullish (put writing = support), lower as bearish. A change of null means 'not warmed up "
    "yet', not zero. Each strike's `meaning` and `flow_15m` are INFERRED from OI direction x premium direction "
    "(OI up + premium down = writing; OI up + premium up = buying) - treat them as likely, not certain. Flag conflicts between signals instead of forcing a direction; `neutral` with low confidence is a valid "
    "answer. `confidence` is 0-100. `one_liner` is one sentence. `reasoning` is 3-5 short bullets. `wait_for` is the "
    "single confirmation that would change or firm up the read. This is analysis, not financial advice."
)


def system_prompt(segment: str) -> str:
    return f"{_SYSTEM_PROMPT} {SEGMENT_NOTES.get(segment, '')}".strip()


def _leg_view(strike: float, leg, side: str, iv_scale: float = 1.0) -> dict:
    return {
        "strike": strike,
        "oi": leg.oi,
        "oi_change_5m": leg.oi_change_5m,
        "oi_change_15m": leg.oi_change_15m,
        "iv": round(leg.implied_volatility * iv_scale, 2),
        "buildup": leg.buildup,
        "meaning": _MEANING.get((side, leg.buildup)),
        "moneyness": leg.moneyness,
    }


def _writing_flow(summary: OptionOiSummary) -> dict:
    """15m OI change near spot, bucketed by what the leg's buildup implies - so the model sees
    "put writing +X contracts vs put buying +Y" instead of one net number. Only strikes within
    _FLOW_STRIKES_EACH_SIDE of spot count (far-OTM lottery strikes would dominate otherwise);
    legs without a buildup yet (warm-up) are skipped and counted in `legs_without_reading`."""
    near = sorted(summary.strikes, key=lambda s: abs(s.strike - summary.underlying_last_price))[: _FLOW_STRIKES_EACH_SIDE * 2 + 1]
    totals: dict[str, int] = {}
    skipped = 0
    for strike in near:
        for side, leg in (("CE", strike.call), ("PE", strike.put)):
            if leg is None:
                continue
            meaning = _MEANING.get((side, leg.buildup))
            if meaning is None or leg.oi_change_15m is None:
                skipped += 1
                continue
            totals[meaning] = totals.get(meaning, 0) + abs(leg.oi_change_15m)
    return {"basis": f"{len(near)} strikes nearest spot, contracts of OI change over 15m", "legs_without_reading": skipped, **totals}


def _oi_context(summary: OptionOiSummary, iv_scale: float = 1.0) -> dict:
    call_vol = sum(s.call.volume for s in summary.strikes if s.call)
    put_vol = sum(s.put.volume for s in summary.strikes if s.put)
    calls = sorted(((s.strike, s.call) for s in summary.strikes if s.call), key=lambda t: t[1].oi, reverse=True)
    puts = sorted(((s.strike, s.put) for s in summary.strikes if s.put), key=lambda t: t[1].oi, reverse=True)
    atm_call_iv = round(summary.atm_call_iv * iv_scale, 2) if summary.atm_call_iv is not None else None
    atm_put_iv = round(summary.atm_put_iv * iv_scale, 2) if summary.atm_put_iv is not None else None
    iv_skew = round(atm_put_iv - atm_call_iv, 2) if atm_call_iv is not None and atm_put_iv is not None else None
    return {
        "expiry": summary.expiry,
        "oi_pcr": summary.pcr,
        "volume_pcr": round(put_vol / call_vol, 2) if call_vol else None,
        "total_call_oi": summary.total_call_oi,
        "total_put_oi": summary.total_put_oi,
        "call_oi_change_5m": summary.total_call_oi_change_5m,
        "put_oi_change_5m": summary.total_put_oi_change_5m,
        "call_oi_change_15m": summary.total_call_oi_change_15m,
        "put_oi_change_15m": summary.total_put_oi_change_15m,
        "call_buildup_vs_spot": summary.total_call_buildup,
        "put_buildup_vs_spot": summary.total_put_buildup,
        "iv_unit": "percent",
        "atm_call_iv": atm_call_iv,
        "atm_put_iv": atm_put_iv,
        "atm_put_minus_call_iv": iv_skew,
        "flow_15m": _writing_flow(summary),
        "top_call_oi_strikes": [_leg_view(k, v, "CE", iv_scale) for k, v in calls[:_TOP_STRIKES]],
        "top_put_oi_strikes": [_leg_view(k, v, "PE", iv_scale) for k, v in puts[:_TOP_STRIKES]],
    }


def _price_context(candles: list[Candle], spot: float) -> dict:
    if not candles:
        return {"spot": spot}
    last_day = candles[-1].timestamp[:10]
    today = [c for c in candles if c.timestamp[:10] == last_day]
    prior = [c for c in candles if c.timestamp[:10] < last_day]
    prior_day = [c for c in prior if c.timestamp[:10] == prior[-1].timestamp[:10]] if prior else []
    vol = sum(c.volume for c in today)
    vwap = sum(((c.high + c.low + c.close) / 3) * c.volume for c in today) / vol if vol else None
    avg_vol = sum(c.volume for c in candles) / len(candles)
    return {
        "spot": spot,
        "interval": candles[-1].interval,
        "session_open": today[0].open,
        "session_high": max(c.high for c in today),
        "session_low": min(c.low for c in today),
        "session_vwap": round(vwap, 2) if vwap else None,
        "prior_day_high": max(c.high for c in prior_day) if prior_day else None,
        "prior_day_low": min(c.low for c in prior_day) if prior_day else None,
        "last_candle_volume_vs_avg": round(candles[-1].volume / avg_vol, 2) if avg_vol else None,
        "recent_candles": [
            {"t": c.timestamp, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume}
            for c in candles[-_RECENT_CANDLES:]
        ],
    }


def vix_context(candles: list[Candle]) -> Optional[dict]:
    """India VIX level plus its move vs the prior session's close and over the last ~30 minutes."""
    if not candles:
        return None
    last = candles[-1]
    day = last.timestamp[:10]
    prior = [c for c in candles if c.timestamp[:10] < day]
    prior_close = prior[-1].close if prior else None
    bars_30m = 6 if last.interval == "5min" else 2
    earlier = candles[-1 - bars_30m] if len(candles) > bars_30m else None
    return {
        "value": last.close,
        "prior_close": prior_close,
        "change_vs_prior_close": round(last.close - prior_close, 2) if prior_close is not None else None,
        "change_last_30m": round(last.close - earlier.close, 2) if earlier is not None else None,
    }


def news_context(digest: Optional[NewsDigest]) -> Optional[dict]:
    if digest is None:
        return None
    if not digest.articles:
        # The digest's own text is filler when nothing relevant was found ("this article is about equity IPOs..."):
        # tell the model there was no relevant news instead of handing it a neutral-sounding paragraph.
        return {"relevant_headlines": 0}
    return {
        "ai_bias": digest.bias,
        "reason": digest.bias_reason,
        "digest": digest.digest,
        "top_articles": [
            {"title": a.title, "published_at": a.published_at, "relevance": a.relevance_score, "why": a.why}
            for a in sorted(digest.articles, key=lambda a: a.relevance_score or 0, reverse=True)[:_NEWS_ARTICLES]
        ],
    }


def events_context(events: list[EconomicEvent], now: Optional[datetime] = None) -> list[dict]:
    """Macro events from 6h ago to 48h ahead (the feed's own timestamps carry a UTC offset)."""
    now = now or datetime.now(timezone.utc)
    lo, hi = now + _EVENT_WINDOW[0], now + _EVENT_WINDOW[1]
    out = []
    for e in events:
        try:
            when = datetime.fromisoformat(e.timestamp)
        except ValueError:
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        if lo <= when <= hi:
            out.append({"title": e.title, "impact": e.impact, "time": e.timestamp, "forecast": e.forecast, "previous": e.previous, "actual": e.actual})
    return out[:_EVENTS_MAX]


def _structure_context(structure: ChartStructure, regime: MarketRegime) -> dict:
    live_zones = [ob for ob in structure.order_blocks if not getattr(ob, "mitigated", False)][:4]
    return {
        "regime": regime.model_dump(mode="json"),
        "structure_trend": structure.trend,
        "recent_structure_events": [e.model_dump(mode="json") for e in structure.events[-3:]],
        "nearby_order_blocks": [
            {"kind": ob.kind, "role": ob.role, "proximal": ob.proximal, "distal": ob.distal} for ob in live_zones
        ],
    }


def build_context(
    underlying: str,
    summary: OptionOiSummary,
    candles: list[Candle],
    regime: MarketRegime,
    structure: ChartStructure,
    vix: Optional[dict] = None,
    news: Optional[dict] = None,
    events: Optional[list[dict]] = None,
    segment: str = "NSE",
    contract: Optional[str] = None,
    events_apply: bool = True,
) -> dict:
    """`vix` is India VIX, a gauge for NSE only - for MCX and crypto it is neither fetched nor listed as missing.
    `events_apply`: False when the macro calendar has no mapping for this instrument (an NSE stock), so its
    absence is not reported as a gap. `contract` is the traded contract when it differs from `underlying`."""
    not_provided = list(DATA_GAPS.get(segment, DATA_GAPS["NSE"]))
    if segment == "NSE" and vix is None:
        not_provided.append("India VIX")
    if news is None:
        not_provided.append("news")
    if events is None and events_apply:
        not_provided.append("economic calendar")
    iv_scale = 100.0 if segment == "CRYPTO" else 1.0  # Delta reports IV as a fraction, Dhan as a percent
    context = {
        "segment": segment,
        "underlying": underlying,
        **({"contract": contract} if contract and contract != underlying else {}),
        "oi": _oi_context(summary, iv_scale),
        "price": _price_context(candles, summary.underlying_last_price),
        "structure": _structure_context(structure, regime),
        "not_provided": not_provided,
    }
    if vix is not None:
        context["vix"] = vix
    if news is not None:
        context["news"] = news
    if events is not None:
        context["events"] = events
    return context


def run_ai_read(context: dict, api_key: str, model: Optional[str] = None) -> dict:
    """One OpenRouter call. Raises RuntimeError with a user-presentable message
    on any failure - unlike the news digest there is no raw fallback to show. `model` is the one the caller resolved (so
    what it reports back is what actually ran); by default it is resolved here."""
    model = model or ai_models.model_for("ai_read")
    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt(context.get("segment", ""))},
                    {"role": "user", "content": json.dumps(context)},
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "ai_read", "strict": True, "schema": READ_SCHEMA}},
                # Same reasoning as news.py: without a cap OpenRouter reserves the
                # model's full max output and 402s accounts with a small balance.
                "max_tokens": 1500,
            },
            timeout=60,
        )
        resp.raise_for_status()
        parsed = _parse_ai_json(resp.json()["choices"][0]["message"]["content"])
        if parsed.get("bias") not in ("bullish", "bearish", "neutral"):
            raise ValueError("model reply had no valid bias")
        return parsed
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        logger.warning("OpenRouter AI read failed (%s) for model %s: %s", status, model, exc)
        hint = {401: "key rejected", 402: "insufficient OpenRouter credit", 404: "model not found - pick another under More -> AI models"}.get(status, "")
        raise RuntimeError(f"AI read failed: OpenRouter returned {status}" + (f" ({hint})" if hint else "")) from exc
    except Exception as exc:  # network, timeout, malformed JSON
        logger.warning("OpenRouter AI read failed for model %s: %s", model, exc)
        raise RuntimeError("AI read temporarily unavailable") from exc
