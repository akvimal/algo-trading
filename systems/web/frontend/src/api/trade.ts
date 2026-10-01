import { api } from "./http";
import type { AiRead, Candle, Ltp, MarketRegime, OiSummary, OptionChain, OptionGroup, OptionLegPreview, PendingOrder, Position, ResolvedUnderlying, Segment, SentimentHistoryDay } from "./types";
import type { OrderRequest } from "../pages/tradeModel";
import type { OpenLevel } from "../chart/trades";

export const resolveUnderlying = (segment: Segment, symbol: string) =>
  api<ResolvedUnderlying>("marketData", `/instruments/resolve?segment=${segment}&underlying=${encodeURIComponent(symbol)}`);

/** Any OPEN spot/future position or option group already on this (segment, symbol) - backs the
 * Scan page's inline trade panel showing an existing position's own status (with a square-off)
 * instead of, or alongside, a blank ticket. Small limit: pyramiding (Strategy.duplicate_signal_
 * policy='add_position', or any manual order - manual orders always allow it) can leave more than
 * one open, but never many. */
export const getOpenPositionsFor = (exchange: Segment, symbol: string) =>
  api<Position[]>("execution", `/positions?segment=${exchange}&symbol=${encodeURIComponent(symbol)}&status=OPEN&with_live_pnl=true&limit=10`);
export const getOpenOptionGroupsFor = (exchange: Segment, symbol: string) =>
  api<OptionGroup[]>("execution", `/option-groups?segment=${exchange}&symbol=${encodeURIComponent(symbol)}&status=OPEN&with_live_pnl=true&limit=10`);

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Recent candles for one series. `days` reaches back far enough to cover a weekend or holiday. */
export function getCandles(exchange: string, symbol: string, interval: string, days: number, now: Date = new Date(), source?: string) {
  const from = isoDay(new Date(now.getTime() - days * 86_400_000));
  const src = source ? `&source=${source}` : "";
  return api<Candle[]>("marketData", `/candles/history?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&from=${from}${src}`);
}

export const getLtp = (exchange: string, symbol: string) => api<Ltp>("marketData", `/quotes/ltp?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}`);

/** The model read can take several seconds, so it is only ever fetched on a click, never polled. */
export const getAiRead = (exchange: string, symbol: string, expiry?: string) =>
  api<AiRead>("marketData", `/ai-read?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&interval=5min${expiry ? `&expiry=${encodeURIComponent(expiry)}` : ""}`);

export const getRegime = (exchange: string, symbol: string, interval: string) =>
  api<MarketRegime>("marketData", `/regime?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&interval=${interval}`);

/** The person's open trades (with live results) and their most recent closed ones, for the segments on
 * screen, to draw on the chart. Each of the four requests stands alone: a slow quote for the live result
 * must not take the closed trades away. */
export async function loadChartTrades(segments: Segment[]): Promise<{ positions: Position[]; groups: OptionGroup[] }> {
  const none = <T,>() => [] as T[];
  const calls = segments.flatMap((s) => [
    api<Position[]>("execution", `/positions?segment=${s}&status=OPEN&with_live_pnl=true&limit=100`).catch(none<Position>),
    api<Position[]>("execution", `/positions?segment=${s}&status=CLOSED&limit=50`).catch(none<Position>),
    api<OptionGroup[]>("execution", `/option-groups?segment=${s}&status=OPEN&with_live_pnl=true&limit=100`).catch(none<OptionGroup>),
    api<OptionGroup[]>("execution", `/option-groups?segment=${s}&status=CLOSED&limit=50`).catch(none<OptionGroup>),
  ]);
  const results = await Promise.all(calls);
  return {
    positions: results.filter((_, i) => i % 4 < 2).flat() as Position[],
    groups: results.filter((_, i) => i % 4 >= 2).flat() as OptionGroup[],
  };
}

/** The option-chain expiries for an underlying, nearest first. The provider can be slow to answer. */
export const getExpiries = (exchange: string, symbol: string) =>
  api<{ expiries: string[] }>("marketData", `/options/expiries?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}`).then((r) => r.expiries);

/** The real option chain for one expiry - every strike's live CE/PE quote (security_id,
 * last_price, oi, moneyness). Fetched once per (exchange, symbol, expiry) so the Scan page's leg
 * table can let a person pick any strike directly and re-render instantly on every click, instead
 * of a fresh preview-legs round trip per interaction. */
export const getOptionChain = (exchange: string, symbol: string, expiry: string) =>
  api<OptionChain>("marketData", `/options/chain?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`);

export const getOiSummary = (exchange: string, symbol: string, expiry: string) =>
  api<OiSummary>("marketData", `/options/oi-summary?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`);

/** The real, current lot size for one specific option contract (its own security_id) - NOT the
 * same thing as the underlying's own lot-size concept (which returns 1 for a bare stock symbol).
 * Needed to size a Dhan margin-calculator request correctly: quantity there must be an exact
 * multiple of this, not just any number of "lots". */
export const getLotSizeForSecurity = (securityId: string, exchange: string) =>
  api<{ lot_size: number }>("marketData", `/dhan/lot-size?security_id=${encodeURIComponent(securityId)}&exchange=${exchange}`).then((r) => r.lot_size);

export type ComboMarginLeg = { security_id: string; action: "BUY" | "SELL"; price: number; quantity: number };
/** Real Dhan margin for a set of legs (read-only "what if" - nothing is placed). NSE_FNO/
 * INTRADAY are hardcoded: the Scan page's OI-buildup panel is NSE stocks only, and every option
 * order it places is intraday (squared off same day, see execution's OptionPositionGroup.horizon)
 * - "MARGIN" (Dhan's held-to-expiry product) would return a different, larger figure, the wrong
 * one for what these paper positions actually are. */
export const getComboMargin = (exchange: string, legs: ComboMarginLeg[]) =>
  api<{ raw: Record<string, unknown> }>("marketData", `/dhan/margin/combo?exchange=${exchange}`, {
    method: "POST",
    json: {
      legs: legs.map((l) => ({
        security_id: l.security_id,
        exchange_segment: "NSE_FNO",
        transaction_type: l.action,
        quantity: l.quantity,
        product_type: "INTRADAY",
        price: l.price,
      })),
    },
  });

/** The legs a real order with these exact params would use, without placing anything - backs the
 * Scan page's bias-driven option panel (Bullish/Bearish -> the real recommended strikes, before
 * committing to an order). `action`: "BUY" for bullish, "SELL" for bearish - the same field a real
 * order carries, see execution's option_position_manager.preview_option_legs. `spreadWidth`
 * overrides the short/protection leg's own distance (in strikes) from the primary leg - omit for
 * the backend's own default. */
export const getOptionLegPreview = (exchange: string, symbol: string, action: "BUY" | "SELL", style: "naked" | "spread" | "credit_spread", moneyness: string, spreadWidth?: number) =>
  api<OptionLegPreview>(
    "execution",
    `/option-groups/preview-legs?segment=${exchange}&symbol=${encodeURIComponent(symbol)}&action=${action}&option_position_style=${style}&option_strike_moneyness=${moneyness}` +
      (spreadWidth != null ? `&spread_width=${spreadWidth}` : ""),
  );

/** Today's 5-minute OI-sentiment readings for `symbol` (the bare underlying, not its resolved contract —
 * sentiment_history is keyed by the underlying). */
export const getSentimentHistory = (symbol: string) => api<SentimentHistoryDay>("marketData", `/options/sentiment-history?symbol=${encodeURIComponent(symbol)}`);

const ATR_INTERVALS = new Set(["1min", "3min", "5min", "15min", "25min", "30min", "60min"]);

/** Moves the stop or target of an open trade to a new price. A position's target has its own route; an
 * option group's stop and target are levels of the underlying. */
export async function moveOpenLevel(level: Pick<OpenLevel, "kind" | "field" | "tradeId">, price: number, interval?: string): Promise<void> {
  // The chart interval the person trades on, so the server can judge a tight trail against that interval's ATR.
  const atr = interval && ATR_INTERVALS.has(interval) ? { atr_interval: interval } : {};
  const base = level.kind === "position" ? `/positions/${level.tradeId}` : `/option-groups/${level.tradeId}`;
  const [path, body] =
    level.kind === "position"
      ? level.field === "stop" ? [`${base}/stop-loss`, { stop_loss_price: price, ...atr }] : [`${base}/target`, { target_price: price }]
      : level.field === "stop" ? [`${base}/spot-stop-loss`, { spot_stop_loss_price: price, ...atr }] : [`${base}/spot-target`, { spot_target_price: price }];
  await api("execution", path, { method: "PUT", json: body });
}

export const listWaitingOrders = () => api<PendingOrder[]>("execution", "/pending-orders?status=pending");
export const cancelWaitingOrder = (id: string) => api<PendingOrder>("execution", `/pending-orders/${id}`, { method: "DELETE" });

export type PlaceResult = {
  ok: boolean;
  /** Plain-language outcome to show the person. */
  message: string;
  /** Something that did not go as planned but did not stop the order (e.g. a stop that would not attach). */
  warning?: string;
  kind: OrderRequest["kind"];
};

type Placed = { id?: string; status?: string; rejection_reason?: string | null };

/** Sends the order. A rejection from the server (an over-budget order, a stop on the wrong side)
 * comes back as a message, not a crash: the person sees why and can change the ticket. */
export async function placeOrder(req: OrderRequest): Promise<PlaceResult> {
  if (req.kind === "pending") {
    const o = await api<PendingOrder>("execution", req.path, { method: "POST", json: req.body });
    return { ok: true, kind: "pending", message: `Order waiting. It is placed when the price reaches ${o.trigger_price}. It stays armed for up to a day, even with the app closed.` };
  }
  const placed = await api<Placed>("execution", req.path, { method: "POST", json: req.body });
  if (placed.status === "REJECTED") return { ok: false, kind: req.kind, message: placed.rejection_reason ?? "The order was rejected." };

  if (req.kind === "option" && placed.id) {
    // For an option the stop and target are levels of the underlying, attached right after it
    // opens - the combined (multi-leg) premium's own stop/target, when the Scan page's leg table
    // computed one from a %-of-max-profit/loss, are attached the same post-open way.
    const missed: string[] = [];
    if (req.stop != null) await api("execution", `/option-groups/${placed.id}/spot-stop-loss`, { method: "PUT", json: { spot_stop_loss_price: req.stop } }).catch(() => missed.push("stop-loss"));
    if (req.target != null) await api("execution", `/option-groups/${placed.id}/spot-target`, { method: "PUT", json: { spot_target_price: req.target } }).catch(() => missed.push("target"));
    if (req.combinedStop != null) await api("execution", `/option-groups/${placed.id}/stop-loss`, { method: "PUT", json: { stop_loss_price: req.combinedStop } }).catch(() => missed.push("combined stop-loss"));
    if (req.combinedTarget != null) await api("execution", `/option-groups/${placed.id}/target`, { method: "PUT", json: { target_price: req.combinedTarget } }).catch(() => missed.push("combined target"));
    if (missed.length) return { ok: true, kind: "option", message: "Paper order placed.", warning: `The ${missed.join(" and ")} did not attach. Set it from Portfolio → Positions.` };
  }
  return { ok: true, kind: req.kind, message: "Paper order placed." };
}
