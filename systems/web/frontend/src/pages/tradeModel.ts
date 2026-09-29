import type { Segment } from "../api/types";

export type Action = "BUY" | "SELL";
export type Strategy = "future" | "naked" | "spread";
export type Moneyness = "ITM2" | "ITM1" | "ATM" | "OTM1" | "OTM2";
export type OrderType = "market" | "limit";

export type Preset = { symbol: string; segment: Segment; label: string };

// The handful of index, commodity and crypto contracts that have futures and options here.
// Everything else on NSE is a stock, traded as plain shares.
export const PRESETS: Preset[] = [
  { symbol: "NIFTY", segment: "NSE", label: "Nifty" },
  { symbol: "BANKNIFTY", segment: "NSE", label: "Bank Nifty" },
  { symbol: "GOLDM", segment: "MCX", label: "Gold mini" },
  { symbol: "CRUDEOILM", segment: "MCX", label: "Crude mini" },
  { symbol: "BTCUSD", segment: "CRYPTO", label: "Bitcoin" },
  { symbol: "ETHUSD", segment: "CRYPTO", label: "Ether" },
];

export const presetFor = (symbol: string): Preset | undefined => PRESETS.find((p) => p.symbol === symbol.toUpperCase());

const SEGMENTS = ["NSE", "MCX", "CRYPTO"] as const;

/** Which instrument is on screen, from the URL. A known contract carries its own segment; an
 * unknown symbol is an NSE stock unless the URL says otherwise. Anything else falls back to Nifty. */
export function parseTradeParams(symbol: string | null, segment: string | null): { symbol: string; segment: Segment } {
  const s = (symbol ?? "").trim().toUpperCase();
  if (!s || !/^[A-Z0-9&_-]{1,30}$/.test(s)) return { symbol: "NIFTY", segment: "NSE" };
  const preset = presetFor(s);
  if (preset) return { symbol: preset.symbol, segment: preset.segment };
  const seg = (SEGMENTS as readonly string[]).includes(segment ?? "") ? (segment as Segment) : "NSE";
  return { symbol: s, segment: seg };
}

/** Shares for a stock, lots of a future for a contract. */
export const instrumentFor = (symbol: string, segment: Segment): "spot" | "future" => (presetFor(symbol) || segment !== "NSE" ? "future" : "spot");

export const optionsAvailable = (symbol: string): boolean => presetFor(symbol) !== undefined;

export const INTERVALS = [
  { id: "1min", label: "1m", days: 3 },
  { id: "5min", label: "5m", days: 5 },
  { id: "15min", label: "15m", days: 8 },
  { id: "60min", label: "1h", days: 30 },
] as const;
export type IntervalId = (typeof INTERVALS)[number]["id"];

export type Ticket = {
  action: Action;
  strategy: Strategy;
  moneyness: Moneyness;
  orderType: OrderType;
  entry: string;
  stop: string;
  target: string;
  lots: string; // "" = size it from my risk
  setupTag: string | null;
  confidence: number | null;
};

export const EMPTY_TICKET: Ticket = {
  action: "BUY", strategy: "future", moneyness: "ATM", orderType: "market", entry: "", stop: "", target: "", lots: "", setupTag: null, confidence: null,
};

export type DefaultInstrument = "future" | "option";
export type DefaultOptionStrategy = "naked" | "spread";

/** A fresh ticket for this instrument, its "what to trade" chip pre-set from the person's own
 * preference (More > Experience) instead of always starting on Future - "option" only takes
 * effect where options actually exist for the symbol; default_option_strategy then picks naked vs
 * spread within that, a second, independent preference. */
export function emptyTicketFor(symbol: string, defaultInstrument: DefaultInstrument, defaultOptionStrategy: DefaultOptionStrategy): Ticket {
  const strategy = defaultInstrument === "option" && optionsAvailable(symbol) ? defaultOptionStrategy : "future";
  return { ...EMPTY_TICKET, strategy };
}

export type TicketContext = {
  price: number | null; // live price of the underlying
  lotSize: number;
  capital: number;
  riskPct: number;
  minRR: number;
  requireStop: boolean;
  segment: Segment;
  symbol: string;
};

const num = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
};

export function computeRR(entry: number | null, stop: number | null, target: number | null): number | null {
  if (entry == null || stop == null || target == null) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  return Math.abs(target - entry) / risk;
}

/** Whole lots so that losing the stop distance costs about the risk budget, never more than the
 * capital allows and never below one lot: the same rule the server applies when it sizes an
 * order, so what is shown here is what will happen. Null when it cannot be worked out. */
export function riskLots(capital: number, riskPct: number, entry: number | null, stop: number | null, lotSize: number): number | null {
  if (entry == null || stop == null || !(entry > 0) || !(lotSize > 0)) return null;
  const distance = Math.abs(entry - stop);
  if (distance <= 0) return null;
  const budget = (capital * riskPct) / 100;
  const byRisk = Math.floor(budget / (distance * lotSize));
  const byCapital = Math.max(1, Math.floor(capital / (entry * lotSize)));
  return Math.max(1, Math.min(byRisk, byCapital));
}

export type Analysis = {
  entry: number | null;
  stop: number | null;
  target: number | null;
  rr: number | null;
  lots: number | null; // what will be bought, in lots (shares for a stock); null = the server decides
  lotsAuto: boolean;
  riskAmount: number | null; // rupees lost if the stop is hit
  rewardAmount: number | null;
  errors: string[]; // stop the order
  warnings: string[]; // shown, do not stop it
};

const isOption = (s: Strategy) => s !== "future";

/** Everything the ticket shows and checks, from what the person typed. Blocking problems are
 * `errors`; the server still validates every one of them. */
export function analyzeTicket(t: Ticket, ctx: TicketContext): Analysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const buy = t.action === "BUY";

  const limit = t.orderType === "limit";
  const typedEntry = num(t.entry);
  const stop = num(t.stop);
  const target = num(t.target);
  const typedLots = num(t.lots);

  let entry: number | null;
  if (limit) {
    entry = typedEntry;
    if (entry === null || Number.isNaN(entry) || entry <= 0) {
      errors.push("Enter the price you want to buy or sell at.");
      entry = null;
    }
  } else {
    entry = ctx.price;
    if (entry == null) errors.push("Waiting for a live price.");
  }

  if (stop !== null && (Number.isNaN(stop) || stop <= 0)) errors.push("Enter a valid stop-loss price.");
  if (target !== null && (Number.isNaN(target) || target <= 0)) errors.push("Enter a valid target price.");
  if (typedLots !== null && (Number.isNaN(typedLots) || typedLots <= 0)) errors.push("Enter a size above 0, or leave it blank to size from your risk.");

  const validStop = stop !== null && Number.isFinite(stop) && stop > 0 ? stop : null;
  const validTarget = target !== null && Number.isFinite(target) && target > 0 ? target : null;

  if (validStop === null && stop === null) {
    if (ctx.requireStop) errors.push("Your settings require a stop-loss on every order.");
    else warnings.push("No stop-loss: there is no limit on how much this trade can lose.");
  }
  if (entry != null) {
    if (validStop !== null && (buy ? validStop >= entry : validStop <= entry)) errors.push(`For a ${buy ? "buy" : "sell"} the stop-loss must be ${buy ? "below" : "above"} your entry.`);
    if (validTarget !== null && (buy ? validTarget <= entry : validTarget >= entry)) errors.push(`For a ${buy ? "buy" : "sell"} the target must be ${buy ? "above" : "below"} your entry.`);
  }

  const rr = computeRR(entry, validStop, validTarget);
  if (rr !== null && rr < ctx.minRR) warnings.push(`Reward-to-risk is ${rr.toFixed(1)}, below your minimum of ${ctx.minRR}.`);

  // Sizing. Options are sized by the server from capital (their stop is on the underlying, so a
  // rupee risk cannot be worked out here); crypto capital is rupees while its price is dollars.
  const lotsAuto = typedLots === null;
  let lots: number | null = null;
  if (!isOption(t.strategy) && ctx.segment !== "CRYPTO") {
    lots = lotsAuto ? (validStop !== null ? riskLots(ctx.capital, ctx.riskPct, entry, validStop, ctx.lotSize) : null) : Number.isFinite(typedLots) ? typedLots : null;
  } else if (!lotsAuto && Number.isFinite(typedLots)) {
    lots = typedLots;
  }

  const units = lots != null ? lots * ctx.lotSize : null;
  const riskAmount = units != null && entry != null && validStop !== null ? units * Math.abs(entry - validStop) : null;
  const rewardAmount = units != null && entry != null && validTarget !== null ? units * Math.abs(validTarget - entry) : null;
  const budget = (ctx.capital * ctx.riskPct) / 100;
  if (riskAmount != null && !lotsAuto && riskAmount > budget) warnings.push(`This size risks more than your ${ctx.riskPct}% per trade.`);

  return { entry, stop: validStop, target: validTarget, rr, lots, lotsAuto, riskAmount, rewardAmount, errors, warnings };
}

export type CheckStatus = "good" | "warn" | "bad" | "na";
export type Check = { key: string; label: string; status: CheckStatus; detail: string };

export type RegimeRead = { regime: "trending_up" | "trending_down" | "ranging" | "transitional"; trend: "up" | "down" | "range"; adx: number };
export type DayBudget = { limit: number; lostToday: number } | null;
/** The other chart on the desk, when there is one: which way it is pointing. */
export type PeerRead = { symbol: string; direction: "up" | "down" | "neutral" | null } | null;

/** The "before you place" list: each item is a fact about this trade, marked in favour of it,
 * against it, or not applicable. It informs the decision; it never blocks the order. */
export function checkList(t: Ticket, a: Analysis, ctx: TicketContext, regime: RegimeRead | null, budget: DayBudget, peer: PeerRead = null): Check[] {
  const buy = t.action === "BUY";
  const checks: Check[] = [];

  checks.push(
    a.stop !== null
      ? { key: "stop", label: "Stop-loss set", status: "good", detail: "You know where you are wrong." }
      : { key: "stop", label: "Stop-loss set", status: "bad", detail: "No stop-loss, so your risk is unlimited." },
  );

  if (a.rr === null) checks.push({ key: "rr", label: `Reward-to-risk of ${ctx.minRR} or better`, status: "na", detail: "Set a stop-loss and a target to see it." });
  else
    checks.push({
      key: "rr", label: `Reward-to-risk of ${ctx.minRR} or better`, status: a.rr >= ctx.minRR ? "good" : "warn",
      detail: `This trade is ${a.rr.toFixed(1)} to 1.`,
    });

  if (!regime) checks.push({ key: "regime", label: "Market regime", status: "na", detail: "Not available right now." });
  else {
    const withIt = (regime.regime === "trending_up" && buy) || (regime.regime === "trending_down" && !buy);
    const against = (regime.regime === "trending_up" && !buy) || (regime.regime === "trending_down" && buy);
    const word = { trending_up: "Trending up", trending_down: "Trending down", ranging: "Ranging", transitional: "Changing" }[regime.regime];
    checks.push({
      key: "regime", label: `Regime: ${word.toLowerCase()}`, status: withIt ? "good" : against ? "bad" : "warn",
      detail: withIt ? "You are trading with the trend." : against ? "You are trading against the trend." : "Trends are unreliable in this kind of market.",
    });
    if (regime.trend !== "range") {
      const aligned = (regime.trend === "up") === buy;
      checks.push({
        key: "trend", label: `Structure: ${regime.trend === "up" ? "higher highs" : "lower lows"}`, status: aligned ? "good" : "warn",
        detail: aligned ? "Recent structure agrees with your side." : "Recent structure points the other way.",
      });
    }
  }

  if (peer) {
    const label = `Confirmed by ${peer.symbol}`;
    if (peer.direction === null) checks.push({ key: "peer", label, status: "na", detail: `${peer.symbol} has not loaded yet.` });
    else if (peer.direction === "neutral") checks.push({ key: "peer", label, status: "warn", detail: `${peer.symbol} is going sideways, so it does not confirm either side.` });
    else {
      const with_ = (peer.direction === "up") === buy;
      checks.push({
        key: "peer", label, status: with_ ? "good" : "bad",
        detail: with_ ? `${peer.symbol} is moving the same way.` : `${peer.symbol} is moving the other way.`,
      });
    }
  }

  if (!budget) checks.push({ key: "budget", label: "Within your daily loss limit", status: "na", detail: "You have not set a daily loss limit." });
  else {
    const left = budget.limit - budget.lostToday;
    if (left <= 0) checks.push({ key: "budget", label: "Within your daily loss limit", status: "bad", detail: "You have already used your daily loss limit." });
    else if (a.riskAmount != null && a.riskAmount > left) checks.push({ key: "budget", label: "Within your daily loss limit", status: "bad", detail: "This trade could take you past your daily loss limit." });
    else checks.push({ key: "budget", label: "Within your daily loss limit", status: "good", detail: "There is room left today." });
  }
  return checks;
}

export const favorable = (checks: Check[]) => ({ good: checks.filter((c) => c.status === "good").length, total: checks.filter((c) => c.status !== "na").length });

export type OrderRequest =
  | { kind: "position"; path: string; body: Record<string, unknown> }
  | { kind: "option"; path: string; body: Record<string, unknown>; stop: number | null; target: number | null }
  | { kind: "pending"; path: string; body: Record<string, unknown> };

export type BuildMeta = { instrument: "spot" | "future"; interval: string; trendFollowed: boolean };

/** The request for this ticket. A market order goes straight in at the live price; a limit order
 * is armed on the server, which watches the price and fires it (so it works with the app closed). */
export function buildOrder(t: Ticket, a: Analysis, ctx: TicketContext, meta: BuildMeta): OrderRequest {
  const journal = {
    ...(t.setupTag ? { setup_tag: t.setupTag } : {}),
    ...(t.confidence != null ? { confidence: t.confidence } : {}),
  };
  const riskManaged = a.lotsAuto && a.stop !== null;
  const common = { segment: ctx.segment, symbol: ctx.symbol, action: t.action };
  const qty = a.lotsAuto ? {} : { quantity: a.lots };

  if (t.orderType === "limit") {
    return {
      kind: "pending",
      path: "/pending-orders",
      body: {
        ...common, strategy: t.strategy, moneyness: t.moneyness, trigger_price: a.entry,
        ...(a.stop !== null ? { stop_loss_price: a.stop } : {}), ...(a.target !== null ? { target_price: a.target } : {}),
        ...qty, trend_followed: meta.trendFollowed, risk_managed: riskManaged, entry_interval: meta.interval, ...journal,
      },
    };
  }
  if (t.strategy === "future") {
    return {
      kind: "position",
      path: "/positions/manual",
      body: {
        ...common, instrument_type: meta.instrument, price: a.entry, order_type: "market", ...qty,
        ...(a.stop !== null ? { stop_loss_price: a.stop } : {}), ...(a.target !== null ? { target_price: a.target } : {}),
        trend_followed: meta.trendFollowed, risk_managed: riskManaged, entry_interval: meta.interval, plan_checklist: [], ...journal,
      },
    };
  }
  return {
    kind: "option",
    path: "/option-groups/manual",
    body: {
      ...common, option_position_style: t.strategy === "spread" ? "spread" : "naked", option_strike_moneyness: t.moneyness,
      ...(a.lotsAuto ? {} : { option_fixed_lots: a.lots }), plan_checklist: [], order_type: "market",
      trend_followed: meta.trendFollowed, risk_managed: riskManaged, entry_interval: meta.interval, ...journal,
    },
    stop: a.stop,
    target: a.target,
  };
}

/** A sensible first position for a plan level, from the live price, so a line can be put on the chart and
 * then dragged to where the person really wants it: a stop half a percent against the trade, a target a
 * percent in its favour, a waiting entry a third of a percent back from the price. Rounded to the
 * decimals the chart shows. Null when there is no price to work from. */
export function defaultLevel(field: "entry" | "stop" | "target", action: Action, price: number | null): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const buy = action === "BUY";
  const pct = field === "stop" ? (buy ? -0.005 : 0.005) : field === "target" ? (buy ? 0.01 : -0.01) : buy ? -0.003 : 0.003;
  const raw = price * (1 + pct);
  const decimals = price >= 100 ? 2 : price >= 1 ? 3 : 6;
  return Number(raw.toFixed(decimals));
}

export const ACTION_WORD = (a: Action) => (a === "BUY" ? "Buy" : "Sell");

// How old a price is allowed to be before the page stops treating it as "live" and falls back to
// showing none at all - matches useQuoteSocket's own MAX_TICK_AGE_MS. Both the pushed (WS) and
// polled (REST) price sources can go stale in the same way: a value that was genuinely fresh when
// it arrived just sits there once the upstream feed goes quiet (a dead Dhan token, a network
// stall, ...), with nothing to invalidate it - useResource keeps the last successful fetch on
// screen through any number of failing background refreshes, by design, and a WS tick that passed
// its own freshness check on arrival is still just a React state value afterwards. Checking
// freshness again at READ time, not only at arrival, is what actually closes that gap.
export const PRICE_STALE_MS = 2 * 60_000;

/** True when `at` (a client-clock timestamp from useResource's fetchedAt or the moment a socket
 * tick was received) is recent enough to trust as a live price; null means "never fetched". */
export function isFresh(at: number | null, now: number): boolean {
  return at != null && now - at < PRICE_STALE_MS;
}
