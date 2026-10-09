import { STOP_WIDEN_MESSAGE } from "../pages/tradeModel";
import type { OptionGroup, PendingOrder, Position } from "../api/types";
import { formatPnl } from "../format";

// The person's own trades, shaped for the chart. Plain data and no chart library, so it can be tested
// without a screen and used by the page without pulling the library into its bundle.

export type ChartTrade = {
  id: string;
  kind: "future" | "option";
  side: "long" | "short";
  state: "open" | "closed";
  entryTs: number;
  entryPrice: number;
  exitTs: number | null;
  exitPrice: number | null;
  /** Unrealized while open, realized once closed. */
  pnl: number | null;
  /** Short name for the marker, e.g. "Long 37" or "Naked Call". */
  label: string;
  /** Why it closed (stop-loss, target, square-off, counter-signal...), when it has. */
  reason: string | null;
};

export type TradeMarkerExtend = Omit<ChartTrade, "id" | "entryTs" | "exitTs">;

const qty = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));

/** A short, plain name for an option group's kind of trade. */
export function optionLabel(g: Pick<OptionGroup, "strategy_type" | "action">): string {
  const t = g.strategy_type.toLowerCase();
  const buy = g.action === "BUY";
  if (t.startsWith("naked")) return buy ? "Naked Call" : "Naked Put";
  if (t.includes("straddle")) return "Straddle";
  if (t.includes("strangle")) return "Strangle";
  return buy ? "Bull Call" : "Bear Put";
}

/** The instrument itself, or one of its contracts (NIFTY-Sep2026-FUT), but not another instrument that
 * merely starts the same way (NIFTYBEES, TCSX). */
export const isContractOf = (symbol: string, base: string) => {
  const s = symbol.toUpperCase();
  return s === base || s.startsWith(`${base}-`);
};

/** The trades that belong on the chart of `base` (the bare instrument, e.g. NIFTY), from the person's
 * positions and option groups. Trades that began before the first candle on the chart are left out:
 * there is nowhere to draw them.
 *
 * A future is stored under its resolved contract (NIFTY-Sep2026-FUT), an option group under the bare
 * underlying, so positions match by contract name, and option legs (which carry an `option_group_id`) are left
 * to their group's row. An option group has no exit price on the underlying, so it is drawn at the
 * underlying's price when it opened, as a diamond with its result beside it, not as an in-and-out line. */
export function toChartTrades(base: string, positions: Position[], groups: OptionGroup[], firstBarTs: number): ChartTrade[] {
  const want = base.trim().toUpperCase();
  const out: ChartTrade[] = [];
  for (const p of positions) {
    if (p.option_group_id != null || !isContractOf(p.symbol, want)) continue;
    if (p.status !== "OPEN" && p.status !== "CLOSED") continue;
    const entryTs = Date.parse(p.entry_time);
    if (!Number.isFinite(entryTs) || entryTs < firstBarTs || p.entry_price == null) continue;
    const open = p.status === "OPEN";
    const exitTs = p.exit_time ? Date.parse(p.exit_time) : NaN;
    out.push({
      id: p.id,
      kind: "future",
      side: p.action === "BUY" ? "long" : "short",
      state: open ? "open" : "closed",
      entryTs,
      entryPrice: p.entry_price,
      exitTs: Number.isFinite(exitTs) ? exitTs : null,
      exitPrice: p.exit_price,
      pnl: open ? (p.unrealized_pnl ?? null) : p.pnl,
      label: `${p.action === "BUY" ? "Long" : "Short"} ${p.quantity != null ? qty(p.quantity) : ""}`.trim(),
      reason: p.exit_reason ?? null,
    });
  }
  for (const g of groups) {
    if (g.underlying_symbol.toUpperCase() !== want) continue;
    if (g.status !== "OPEN" && g.status !== "CLOSED") continue;
    const spot = g.entry_spot_price;
    if (g.entry_time == null || spot == null) continue;
    const entryTs = Date.parse(g.entry_time);
    if (!Number.isFinite(entryTs) || entryTs < firstBarTs) continue;
    const open = g.status === "OPEN";
    const exitTs = g.exit_time ? Date.parse(g.exit_time) : NaN;
    out.push({
      id: g.id,
      kind: "option",
      side: g.action === "BUY" ? "long" : "short",
      state: open ? "open" : "closed",
      entryTs,
      entryPrice: spot,
      exitTs: Number.isFinite(exitTs) ? exitTs : null,
      exitPrice: null,
      pnl: open ? (g.unrealized_pnl ?? null) : g.pnl,
      label: optionLabel(g),
      reason: g.exit_reason ?? null,
    });
  }
  return out;
}

/** "+1.2k", "−450": a signed, compact result for a small label. */
export function compactPnl(n: number | null): string {
  if (n == null) return "–";
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : String(Math.round(abs));
  return `${n < 0 ? "−" : "+"}${body}`;
}

/** The outline a trade is drawn with: how it is doing, not which way it points, on the result label. */
export function pnlTone(pnl: number | null): "up" | "dn" | "flat" {
  if (pnl == null || pnl === 0) return "flat";
  return pnl > 0 ? "up" : "dn";
}

// ---- the stop and target of trades that are still open, as levels on the chart ----

export type OpenLevel = {
  /** Unique per trade and field: "position:<id>:stop". */
  key: string;
  tradeId: string;
  /** A position, an option group, or an order that is still waiting for its price. */
  kind: "position" | "group" | "waiting";
  field: "entry" | "stop" | "target";
  price: number;
  /** For the tag on the line, e.g. "Stop · Long 10 · −₹450". */
  label: string;
  long: boolean;
  /** A stop that moves by itself (trailing) is shown but cannot be dragged: moving it by hand would switch the trailing off. The entry line of an
   * open trade is only ever shown; a waiting order's entry (its trigger), stop and target can all be dragged. */
  draggable: boolean;
  /** The line carries a small × that cancels the order it belongs to (a waiting order's entry line). */
  cancellable?: boolean;
};

/** What a futures trade makes or loses if it is closed at `price` (before charges): the same sum the server uses for P&L. */
const resultAt = (long: boolean, entry: number, price: number, quantity: number) => (long ? price - entry : entry - price) * quantity;

/** The stop and target of each open trade on the chart of `base`, with its entry between them: a position's own entry, stop and target, and for
 * an option group the same on the underlying's price. Each line's tag carries the money: the live result on the entry, and what the stop or
 * target would make or lose (a futures trade only: an option's result is not a straight line in the underlying). A level that is not set has no line. */
export function openLevels(base: string, positions: Position[], groups: OptionGroup[]): OpenLevel[] {
  const want = base.trim().toUpperCase();
  const out: OpenLevel[] = [];
  const add = (l: Omit<OpenLevel, "key">) => out.push({ ...l, key: `${l.kind}:${l.tradeId}:${l.field}` });
  for (const p of positions) {
    if (p.status !== "OPEN" || p.option_group_id != null || !isContractOf(p.symbol, want)) continue;
    const long = p.action === "BUY";
    const name = `${long ? "Long" : "Short"} ${qty(p.quantity)}`;
    const trailing = p.trailing_stop_enabled === true;
    const money = (price: number) => ` · ${formatPnl(resultAt(long, p.entry_price, price, p.quantity))}`;
    if (p.entry_price != null) add({ tradeId: p.id, kind: "position", field: "entry", price: p.entry_price, label: `${name}${p.unrealized_pnl != null ? ` · ${formatPnl(p.unrealized_pnl)}` : ""}`, long, draggable: false });
    if (p.stop_loss_price != null) add({ tradeId: p.id, kind: "position", field: "stop", price: p.stop_loss_price, label: `Stop · ${name}${trailing ? " (trailing)" : ""}${money(p.stop_loss_price)}`, long, draggable: !trailing });
    if (p.target_price != null) add({ tradeId: p.id, kind: "position", field: "target", price: p.target_price, label: `Target · ${name}${money(p.target_price)}`, long, draggable: true });
  }
  for (const g of groups) {
    if (g.status !== "OPEN" || g.underlying_symbol.toUpperCase() !== want) continue;
    const long = g.action === "BUY";
    const name = optionLabel(g);
    const trailing = g.spot_stop_loss_trailing_enabled === true;
    if (g.entry_spot_price != null) add({ tradeId: g.id, kind: "group", field: "entry", price: g.entry_spot_price, label: `${name}${g.unrealized_pnl != null ? ` · ${formatPnl(g.unrealized_pnl)}` : ""}`, long, draggable: false });
    if (g.spot_stop_loss_price != null) add({ tradeId: g.id, kind: "group", field: "stop", price: g.spot_stop_loss_price, label: `Stop · ${name}${trailing ? " (trailing)" : ""}`, long, draggable: !trailing });
    if (g.spot_target_price != null) add({ tradeId: g.id, kind: "group", field: "target", price: g.spot_target_price, label: `Target · ${name}`, long, draggable: true });
  }
  return out;
}

/** The entry, stop and target of orders still waiting for their price on the chart of `base`, so the plan is on the chart before it is a trade.
 * All three can be dragged (the server re-checks them) and the entry line has a × that cancels the order. The quantity is only worked out when
 * the order fires, so there is no money on these. */
export function waitingLevels(base: string, orders: PendingOrder[]): OpenLevel[] {
  const want = base.trim().toUpperCase();
  const out: OpenLevel[] = [];
  const add = (l: Omit<OpenLevel, "key">) => out.push({ ...l, key: `${l.kind}:${l.tradeId}:${l.field}` });
  for (const o of orders) {
    if (o.status !== "pending" || !isContractOf(o.symbol, want)) continue;
    const long = o.action === "BUY";
    add({ tradeId: o.id, kind: "waiting", field: "entry", price: o.trigger_price, label: `Waiting ${o.action}`, long, draggable: true, cancellable: true });
    if (o.stop_loss_price != null) add({ tradeId: o.id, kind: "waiting", field: "stop", price: o.stop_loss_price, label: `Stop · waiting ${o.action}`, long, draggable: true });
    if (o.target_price != null) add({ tradeId: o.id, kind: "waiting", field: "target", price: o.target_price, label: `Target · waiting ${o.action}`, long, draggable: true });
  }
  return out;
}

/** Why a waiting order's line cannot be moved to `price`, or null when it can: the same rule the server applies (a stop on the losing side of the
 * trigger, a target on the winning side), judged against the order's own other lines rather than the live price, since the order has not fired.
 * `levels` are the order's lines as they are now. */
export function checkWaitingMove(level: Pick<OpenLevel, "field" | "long">, price: number, levels: { entry: number; stop: number | null; target: number | null }): string | null {
  if (!Number.isFinite(price) || price <= 0) return "That is not a price.";
  const trigger = level.field === "entry" ? price : levels.entry;
  const stop = level.field === "stop" ? price : levels.stop;
  const target = level.field === "target" ? price : levels.target;
  const side = level.long ? "buy" : "sell";
  if (stop != null && !(level.long ? stop < trigger : stop > trigger)) return `The stop-loss of a ${side} order has to stay ${level.long ? "below" : "above"} its trigger price (${trigger}).`;
  if (target != null && !(level.long ? target > trigger : target < trigger)) return `The target of a ${side} order has to stay ${level.long ? "above" : "below"} its trigger price (${trigger}).`;
  return null;
}

/** Why a level cannot be moved to `price`, or null when it can. A stop must stay on the losing side of the
 * price now and a target on the winning side: on the wrong side it would close the trade at the next check,
 * which is not what dragging a line means. The server has the last word; this saves a trip and says why. */
export function checkLevelMove(level: Pick<OpenLevel, "field" | "long">, price: number, live: number | null, current: number | null = null): string | null {
  if (!Number.isFinite(price) || price <= 0) return "That is not a price.";
  // Once an order is live its stop only moves toward price: a long's stop up, a short's down.
  if (level.field === "stop" && current != null && (level.long ? price < current : price > current)) return STOP_WIDEN_MESSAGE;
  if (live == null) return "There is no live price yet, so the level cannot be checked. Try again in a moment.";
  const below = level.field === "stop" ? level.long : !level.long; // the level belongs below the price now
  const word = level.field === "stop" ? "stop-loss" : "target";
  const trade = level.long ? "long" : "short";
  if (below && price >= live) return `The ${word} of a ${trade} trade has to stay below the current price (${live}).`;
  if (!below && price <= live) return `The ${word} of a ${trade} trade has to stay above the current price (${live}).`;
  return null;
}
