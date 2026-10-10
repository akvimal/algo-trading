import type { Pretrade, Segment } from "../api/types";
import { formatInr } from "../format";

export type Action = "BUY" | "SELL";
// 'spread' = a debit spread (bull_call_spread/bear_put_spread - pays a net premium).
// 'credit_spread' = the net-credit counterpart (bull_put_spread/bear_call_spread - receives a
// net premium, sized by max loss instead of cost - see execution's _spread_sizing_basis). Only
// the Scan page's ScanOptionBias panel ever sets it today - TradePage's own "What to trade"
// chips (TradeTicket) don't offer it.
export type Strategy = "future" | "naked" | "spread" | "credit_spread";
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

/** What the market is doing: the person's read, pre-filled from the regime badge. */
export type MarketState = "trending_up" | "trending_down" | "ranging";
/** The three plans: trade a pullback (with a trend), a breakout (a level taken) or a reversal / fade (a retest of the same level with a rejection). */
export type PlanKind = "pullback" | "breakout" | "reversal";

export type Ticket = {
  action: Action;
  strategy: Strategy;
  moneyness: Moneyness;
  // How many strikes the short/protection leg sits from the primary leg, for 'spread'/
  // 'credit_spread' only - overrides option_templates.py's own SPREAD_WIDTH_STRIKES default (2).
  // Only still meaningful as a fallback when primaryStrike/secondStrike below are null (the Scan
  // page's leg table always has both set once its option chain has loaded).
  spreadWidth: number;
  // An explicit strike per leg, picked directly from a real fetched option chain (the Scan
  // page's leg table - see ScanOptionBias.tsx) - each overrides moneyness/spreadWidth entirely
  // for its own leg once set. null until a chain has loaded (or for TradePage's own option
  // ticket, which still drives off moneyness alone - see hideMoneynessField).
  primaryStrike: number | null;
  secondStrike: number | null;
  // The expiry a chosen primaryStrike/secondStrike actually came from - sent through so the
  // order resolves against the SAME chain the strike was picked from, not whatever the server's
  // own nearest-expiry default happens to be at submit time. null lets the server pick nearest,
  // same as before a chain was ever fetched.
  expiry: string | null;
  // The COMBINED (multi-leg) premium's own stop-loss/target, as a real price level - separate
  // from spot-based stop/target below, and separate from a single leg's own price. Computed by
  // ScanOptionBias.tsx from a %-of-max-profit/loss the person picks there (a defined-risk
  // spread's max profit/loss is bounded and known up front), not typed in directly - null means
  // "don't attach one" (also the only option for a naked position, which has no defined max
  // profit to measure a target against). Attached post-open via PUT /option-groups/{id}/
  // stop-loss and /target, the same "attach right after placing" pattern spot stop/target below
  // already use.
  combinedStopLossPrice: number | null;
  combinedTargetPrice: number | null;
  orderType: OrderType;
  // A WAITING order only: may it open a second position on an instrument already held? Off by default - the
  // server then skips it, with a reason, if something is open on that instrument when its price is hit.
  allowStacking: boolean;
  entry: string;
  stop: string;
  target: string;
  lots: string; // "" = size it from my risk
  setupTag: string | null;
  // The plan: what the market is doing (null = follow the regime read) and which plan the person is trading. setupTag is DERIVED from the two
  // (effectiveTicket) so it follows the market state if that is still the regime read.
  planState: MarketState | null;
  planKind: PlanKind | null;
  // What the person saw, optional, kept in the order's notes ("Saw: Order block.").
  trigger: string | null;
  confidence: number | null;
  // Free-text reason captured alongside setupTag, at order time - "why THIS trade", not just which
  // category. Sent as the order's own `notes` (positions.notes/option_position_groups.notes),
  // editable later the same way any other journal note is.
  reason: string;
};

export const EMPTY_TICKET: Ticket = {
  action: "BUY", strategy: "future", moneyness: "ATM", spreadWidth: 2, primaryStrike: null, secondStrike: null, expiry: null,
  combinedStopLossPrice: null, combinedTargetPrice: null,
  orderType: "market", allowStacking: false, entry: "", stop: "", target: "", lots: "", setupTag: null, planState: null, planKind: null, trigger: null, confidence: null, reason: "",
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

/** Crypto's margin maths (the same as the server's): the margin posted is the notional over the leverage, and the trade is liquidated when the price
 * moves against it by about 1 / leverage less the maintenance margin (0.5%). Null at 1× (nothing borrowed) or without an entry. */
export const MAINTENANCE_MARGIN = 0.005;
export function cryptoLeverage(entry: number | null, buy: boolean, leverage: number): { leverage: number; liquidation: number; awayPct: number } | null {
  if (entry == null || !(leverage > 1)) return null;
  const away = 1 / leverage - MAINTENANCE_MARGIN;
  if (!(away > 0)) return null;
  return { leverage, liquidation: buy ? entry * (1 - away) : entry * (1 + away), awayPct: away * 100 };
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
  /** Crypto only: rupees per dollar (null until one is set) and the account's margin multiplier. Prices are dollars, capital is rupees. */
  usdinr?: number | null;
  leverage?: number;
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
  // The pending-order watcher (execution's app/domain/pending_orders.py) only knows how to build
  // a naked/debit-spread leg once triggered, not a credit one yet - block this combo here too,
  // not just by disabling the chip in TradeTicket, so it's caught even if the ticket reached this
  // state some other way (e.g. picking Credit after already choosing "Wait for a price").
  if (limit && t.strategy === "credit_spread") errors.push("Waiting orders aren't supported for a credit spread yet - use Market instead.");
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

  // Every option position this platform can place is already risk-capped by construction (a
  // naked position's max loss is the premium paid; a spread's is the strike width - see
  // execution's _spread_sizing_basis) - unlike a spot/future position, which really can lose more
  // than expected without a stop. require_stop_loss (and the "no limit" warning otherwise) only
  // makes sense for the latter.
  if (validStop === null && stop === null && !isOption(t.strategy)) {
    if (ctx.requireStop) errors.push("Your settings require a stop-loss on every order.");
    else warnings.push("No stop-loss: there is no limit on how much this trade can lose.");
  }
  if (entry != null) {
    if (validStop !== null && (buy ? validStop >= entry : validStop <= entry)) errors.push(`For a ${buy ? "buy" : "sell"} the stop-loss must be ${buy ? "below" : "above"} your entry.`);
    if (validTarget !== null && (buy ? validTarget <= entry : validTarget >= entry)) errors.push(`For a ${buy ? "buy" : "sell"} the target must be ${buy ? "above" : "below"} your entry.`);
  }

  const rr = computeRR(entry, validStop, validTarget);
  // (a tiny tolerance: a plan built to exactly the minimum can come out a hair under it in floating point)
  if (rr !== null && rr + 1e-6 < ctx.minRR) warnings.push(`Reward-to-risk is ${rr.toFixed(1)}, below your minimum of ${ctx.minRR}.`);

  // Sizing. Options are sized by the server from capital (their stop is on the underlying, so a
  // rupee risk cannot be worked out here); crypto capital is rupees while its price is dollars.
  const lotsAuto = typedLots === null;
  let lots: number | null = null;
  const crypto = ctx.segment === "CRYPTO" && !isOption(t.strategy);
  if (crypto && lotsAuto && entry != null && ctx.usdinr) {
    // The server's own rule for an order without a size: the lots the stop lets you risk, held to what the margin buys (capital in dollars times
    // leverage), and at least one. With no stop it is all the margin buys.
    const capitalUsd = ctx.capital / ctx.usdinr;
    const buyable = Math.max(1, Math.floor((capitalUsd * (ctx.leverage ?? 1)) / (entry * ctx.lotSize)));
    const distance = validStop !== null ? Math.abs(entry - validStop) : 0;
    lots = distance > 0 ? Math.max(1, Math.min(Math.floor((capitalUsd * ctx.riskPct) / 100 / (distance * ctx.lotSize)), buyable)) : buyable;
  } else if (crypto && !lotsAuto && Number.isFinite(typedLots)) {
    lots = typedLots;
  } else if (!isOption(t.strategy) && ctx.segment !== "CRYPTO") {
    lots = lotsAuto ? (validStop !== null ? riskLots(ctx.capital, ctx.riskPct, entry, validStop, ctx.lotSize) : null) : Number.isFinite(typedLots) ? typedLots : null;
  } else if (!lotsAuto && Number.isFinite(typedLots)) {
    lots = typedLots;
  }

  const units = lots != null ? lots * ctx.lotSize : null;
  // Money is rupees: a crypto price distance is dollars, so it goes through the rate (none set: no figure rather than a wrong one).
  const fx = ctx.segment === "CRYPTO" ? (ctx.usdinr ?? null) : 1;
  const riskAmount = fx != null && units != null && entry != null && validStop !== null ? units * Math.abs(entry - validStop) * fx : null;
  const rewardAmount = fx != null && units != null && entry != null && validTarget !== null ? units * Math.abs(validTarget - entry) * fx : null;
  const budget = (ctx.capital * ctx.riskPct) / 100;
  const lev = crypto ? cryptoLeverage(entry, buy, ctx.leverage ?? 1) : null;
  if (lev && validStop !== null && (buy ? validStop <= lev.liquidation : validStop >= lev.liquidation)) {
    warnings.push(`At ${lev.leverage}× leverage the trade is liquidated near ${lev.liquidation.toFixed(2)}, before your stop-loss: the stop would never be reached.`);
  }
  if (riskAmount != null && !lotsAuto && riskAmount > budget) warnings.push(`This size risks more than your ${ctx.riskPct}% per trade.`);

  return { entry, stop: validStop, target: validTarget, rr, lots, lotsAuto, riskAmount, rewardAmount, errors, warnings };
}

export type CheckStatus = "good" | "warn" | "bad" | "na";
export type Check = { key: string; label: string; status: CheckStatus; detail: string };

export type RegimeRead = { regime: "trending_up" | "trending_down" | "ranging" | "transitional"; trend: "up" | "down" | "range"; adx: number };
export type DayBudget = { limit: number; lostToday: number } | null;

// ---- the plan: market state x plan ----
//
// Three plans cover it. A PULLBACK is a trend trade (price returns to a zone, you go with the trend), so it does not exist in a range. A
// BREAKOUT is a level being taken: the previous high in a trend, an edge that has been tested twice or more in a range. A REVERSAL is a retest of the
// same high or low with a rejection: counter-trend (higher risk) in a trend, and "fade the edge" in a range. The market state decides the risk and
// the hints, not what the person has to pick: they tap a plan, and the label kept with the trade is one of five (PLAN_TAGS).

export const PLAN_KINDS: { value: PlanKind; label: string }[] = [
  { value: "pullback", label: "Pullback" },
  { value: "breakout", label: "Breakout" },
  { value: "reversal", label: "Reversal / fade" },
];

/** The regime read as a market state, or null while it is changing or unavailable (the person then chooses). */
export function marketStateOf(regime: RegimeRead | null): MarketState | null {
  return regime && (regime.regime === "trending_up" || regime.regime === "trending_down" || regime.regime === "ranging") ? regime.regime : null;
}

/** A pullback needs a trend to pull back within. */
export const planAvailable = (state: MarketState | null, kind: PlanKind) => !(kind === "pullback" && state === "ranging");

/** The label kept with the trade, or null until both are known (or the pair does not exist: a pullback in a range). */
export function planTag(state: MarketState | null, kind: PlanKind | null): string | null {
  if (!state || !kind || !planAvailable(state, kind)) return null;
  const trend = state !== "ranging";
  if (kind === "pullback") return "Trend pullback";
  if (kind === "breakout") return trend ? "Trend breakout" : "Range break";
  return trend ? "Trend reversal" : "Range fade";
}

/** The side a plan implies, or null where the plan itself does not say (in a range it depends on which edge price is at). */
export function planSide(state: MarketState | null, kind: PlanKind): Action | null {
  if (state !== "trending_up" && state !== "trending_down") return null;
  const up = state === "trending_up";
  return (kind === "reversal" ? !up : up) ? "BUY" : "SELL";
}

/** One line on how to enter, in the market state the person is in. */
export function planHint(state: MarketState | null, kind: PlanKind | null): string {
  if (!kind) return "";
  const trend = state === "trending_up" || state === "trending_down";
  const high = state === "trending_down" ? "low" : "high";
  if (kind === "pullback") return trend ? "Wait for price to come back to a zone, then go with the trend." : "A pullback needs a trend: in a range, fade an edge or wait for a break.";
  if (kind === "breakout") return trend ? `Enter as the previous ${high} is taken.` : "Enter as an edge that has been tested twice or more breaks.";
  return trend ? "Against the trend: a retest of the same high or low with a rejection candle. Higher risk." : "Fade the edge: a retest of the same high or low with a rejection candle. Aim for the other side.";
}

/** Cautions that follow from the plan (never blocking): trading against it, or its usual weak spot. */
export function planNudges(t: Ticket, a: Analysis, state: MarketState | null): string[] {
  const kind = t.planKind;
  if (!kind || !state) return [];
  const out: string[] = [];
  const side = planSide(state, kind);
  if (side && side !== t.action) out.push(`Your side is against the plan: a ${kind === "reversal" ? "reversal" : kind} in ${state === "trending_up" ? "an uptrend" : "a downtrend"} is a ${ACTION_WORD(side)}.`);
  if (kind === "reversal" && state !== "ranging") out.push("This goes against the trend: it is the riskier plan. Consider half your usual size.");
  if (kind === "reversal" && state === "ranging" && a.rr != null && a.rr < 1.5) out.push(`A fade wants room to the other side: ${a.rr.toFixed(1)} to 1 is thin.`);
  return out;
}

/** The ticket with the label derived from the plan: the market state is the person's pick, else the regime read, so the tag follows the read until
 * they pin it. Everything that analyses or sends the ticket works from this, not from the stored one. */
export function effectiveTicket(t: Ticket, regime: RegimeRead | null): Ticket {
  const state = t.planState ?? marketStateOf(regime);
  const tag = planTag(state, t.planKind);
  return tag ? { ...t, setupTag: tag } : t;
}

/** The "before you place" list: each item is a fact about this trade, marked in favour of it,
 * against it, or not applicable. It informs the decision; it never blocks the order. */
export function checkList(t: Ticket, a: Analysis, ctx: TicketContext, regime: RegimeRead | null, budget: DayBudget): Check[] {
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
  | {
      kind: "option";
      path: string;
      body: Record<string, unknown>;
      stop: number | null;
      target: number | null;
      combinedStop: number | null;
      combinedTarget: number | null;
    }
  | { kind: "pending"; path: string; body: Record<string, unknown> };

export type BuildMeta = { instrument: "spot" | "future"; interval: string; trendFollowed: boolean };

/** The request for this ticket. A market order goes straight in at the live price; a limit order
 * is armed on the server, which watches the price and fires it (so it works with the app closed). */
export function buildOrder(t: Ticket, a: Analysis, ctx: TicketContext, meta: BuildMeta): OrderRequest {
  const journal = {
    ...(t.setupTag ? { setup_tag: t.setupTag } : {}),
    ...(t.confidence != null ? { confidence: t.confidence } : {}),
    ...(t.reason.trim() || t.trigger ? { notes: [t.trigger ? `Saw: ${t.trigger}.` : "", t.reason.trim()].filter(Boolean).join(" ") } : {}),
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
        ...qty, trend_followed: meta.trendFollowed, risk_managed: riskManaged, entry_interval: meta.interval, allow_stacking: t.allowStacking, ...journal,
        // An option order waits with the exact legs the ticket showed (a strike per leg and the expiry they came from), not a fresh pick when it fires.
        ...(t.strategy !== "future" && t.primaryStrike != null ? { primary_strike: t.primaryStrike } : {}),
        ...(t.strategy === "spread" && t.secondStrike != null ? { second_strike: t.secondStrike } : {}),
        ...(t.strategy !== "future" && t.expiry != null ? { expiry: t.expiry } : {}),
        ...(t.strategy === "spread" ? { spread_width: t.spreadWidth } : {}),
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
      ...common, option_position_style: t.strategy === "naked" ? "naked" : t.strategy, option_strike_moneyness: t.moneyness,
      ...(t.strategy !== "naked" ? { spread_width: t.spreadWidth } : {}),
      // An explicit strike per leg (picked from a real fetched chain - see ScanOptionBias.tsx)
      // takes precedence over moneyness/spread_width above entirely, same as the preview route.
      ...(t.primaryStrike != null ? { primary_strike: t.primaryStrike } : {}),
      ...(t.strategy !== "naked" && t.secondStrike != null ? { second_strike: t.secondStrike } : {}),
      ...(t.expiry != null ? { expiry: t.expiry } : {}),
      ...(a.lotsAuto ? {} : { option_fixed_lots: a.lots }), plan_checklist: [], order_type: "market",
      trend_followed: meta.trendFollowed, risk_managed: riskManaged, entry_interval: meta.interval, ...journal,
    },
    stop: a.stop,
    target: a.target,
    combinedStop: t.combinedStopLossPrice,
    combinedTarget: t.combinedTargetPrice,
  };
}

/** A sensible first position for a plan level, from the live price, so a line can be put on the chart and
 * then dragged to where the person really wants it. When the chart can say how far one bar typically moves
 * (`typicalMove`), the line is measured in that: a stop one bar-move against the trade, a target two in its
 * favour (a 2:1 plan), a waiting entry half one back - so it lands inside the part of the chart on screen
 * whatever the instrument or interval. Without it, a small share of the price instead (0.15% stop, 0.3%
 * target, 0.1% entry). Rounded to the decimals the chart shows. Null when there is no price to work from. */
export function defaultLevel(field: "entry" | "stop" | "target", action: Action, price: number | null, typicalMove: number | null = null, minRR = 2): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const buy = action === "BUY";
  const sign = field === "target" ? (buy ? 1 : -1) : buy ? -1 : 1; // stop and entry sit against the trade's direction
  // The target is as many stop-distances away as the person's minimum reward-to-risk asks (never under 2), so a suggestion does not
  // arrive already under their own rule.
  const reach = Math.max(2, Number.isFinite(minRR) ? minRR : 2);
  const away = typicalMove != null && Number.isFinite(typicalMove) && typicalMove > 0
    ? typicalMove * (field === "stop" ? 1 : field === "target" ? reach : 0.5)
    : price * (field === "stop" ? 0.0015 : field === "target" ? 0.0015 * reach : 0.001);
  const raw = price + sign * away;
  const decimals = price >= 100 ? 2 : price >= 1 ? 3 : 6;
  return Number(raw.toFixed(decimals));
}

/** The server refuses to move a live stop away from price; the page says the same before asking. */
export const STOP_WIDEN_MESSAGE = "The stop can only move toward price once the order is live.";

export type PlanStatus = { tone: "empty" | "partial" | "ready" | "warn"; text: string };

/** One quiet line saying how complete the plan is, for a spot/future ticket. It never blocks anything. */
export function planStatus(t: Ticket, a: Analysis, ctx: TicketContext): PlanStatus | null {
  const option = t.strategy !== "future";
  const risk = a.riskAmount != null && ctx.capital > 0 ? `risk ${((a.riskAmount / ctx.capital) * 100).toFixed(1)}%` : null;
  const parts = (...p: (string | null)[]) => p.filter(Boolean).join(" · ");
  if (a.stop == null) return { tone: "empty", text: option ? "No plan yet · set a stop and a target on the underlying" : "No plan yet · set a stop to size the trade" };
  if (a.riskAmount != null && a.riskAmount > (ctx.capital * ctx.riskPct) / 100) {
    // Sized by the system but still over: the smallest order (one lot) already risks more than the plan allows.
    return { tone: "warn", text: parts(a.lotsAuto ? "Even the smallest size is over your plan" : "Size above your plan", risk, `plan is ${ctx.riskPct}%`) };
  }
  if (a.target == null) return { tone: "partial", text: parts("Stop set", "reward unplanned", risk) };
  if (a.rr != null && a.rr + 1e-6 < ctx.minRR) return { tone: "warn", text: parts(`R:R ${a.rr.toFixed(1)} is under your ${ctx.minRR} minimum`, risk) };
  return { tone: "ready", text: parts("Planned", a.rr != null ? `R:R ${a.rr.toFixed(1)}` : null, risk) };
}

export type PlanRowStatus = "good" | "warn" | "bad" | "info" | "na";
export type PlanRow = { key: string; label: string; status: PlanRowStatus; detail: string };

/** The rows of the ticket's "Your plan" block, in the order the discipline score checks them: only things the person controls before
 * the order. Nothing here blocks an order, and there is no tally: the header chip (planStatus) is the one-line summary. */
export function planRows(t: Ticket, a: Analysis, ctx: TicketContext, today: Pretrade | null): PlanRow[] {
  const option = t.strategy !== "future";
  const rows: PlanRow[] = [];
  const budget = (ctx.capital * ctx.riskPct) / 100;
  const pct = (amount: number) => `${((amount / ctx.capital) * 100).toFixed(1)}%`;

  // stop
  if (a.stop !== null) rows.push({ key: "stop", label: "Stop", status: "good", detail: `At ${a.stop}.` });
  else if (option) rows.push({ key: "stop", label: "Stop", status: "warn", detail: "No stop on the underlying yet." });
  else rows.push({ key: "stop", label: "Stop", status: "bad", detail: "No stop: your risk is open-ended." });

  // size
  if (option || ctx.segment === "CRYPTO") {
    rows.push({ key: "size", label: "Size", status: "info", detail: t.lots.trim() === "" ? "Sized for you from your capital." : `${t.lots} lots, as you chose.` });
  } else if (a.stop === null) {
    rows.push({ key: "size", label: "Size", status: "na", detail: "Set a stop to size the trade." });
  } else if (a.lotsAuto) {
    if (a.riskAmount != null && a.riskAmount > budget) {
      rows.push({ key: "size", label: "Size", status: "warn", detail: `Even the smallest size risks ${pct(a.riskAmount)} of your ${ctx.riskPct}% plan.` });
    } else rows.push({ key: "size", label: "Size", status: "good", detail: `At the system size${a.lots != null ? `: ${a.lots}` : ""}.` });
  } else {
    const system = riskLots(ctx.capital, ctx.riskPct, a.entry, a.stop, ctx.lotSize);
    if (system == null || a.lots == null) rows.push({ key: "size", label: "Size", status: "info", detail: "As you typed it." });
    else if (a.lots > system) rows.push({ key: "size", label: "Size", status: "warn", detail: `Above the system size (${system})${a.riskAmount != null ? `: risks ${pct(a.riskAmount)} of your ${ctx.riskPct}% plan` : ""}.` });
    else if (a.lots < system / 2) rows.push({ key: "size", label: "Size", status: "info", detail: `Below the system size (${system}). Fine once, but sizing down after losses is a habit to watch.` });
    else rows.push({ key: "size", label: "Size", status: "good", detail: `Close to the system size (${system}).` });
  }

  // reward
  if (a.target === null) rows.push({ key: "reward", label: "Reward", status: "warn", detail: "No target: the reward is unplanned." });
  else if (a.rr === null) rows.push({ key: "reward", label: "Reward", status: "na", detail: "Set a stop to see reward-to-risk." });
  else if (a.rr + 1e-6 >= ctx.minRR) rows.push({ key: "reward", label: "Reward", status: "good", detail: `${a.rr.toFixed(1)} to 1, your minimum is ${ctx.minRR}.` });
  else rows.push({ key: "reward", label: "Reward", status: "warn", detail: `${a.rr.toFixed(1)} to 1 is under your minimum of ${ctx.minRR}.` });

  // setup (the chips themselves are drawn by the ticket)
  rows.push(t.setupTag ? { key: "setup", label: "Setup", status: "good", detail: `Tagged ${t.setupTag}.` } : { key: "setup", label: "Setup", status: "warn", detail: "Not tagged: pick a plan above." });

  // entry
  rows.push(t.orderType === "limit" ? { key: "entry", label: "Entry", status: "good", detail: "Waiting for your price." } : { key: "entry", label: "Entry", status: "info", detail: "At the market." });

  // today, from the server
  if (today) {
    if (today.cooldown_minutes_left > 0) {
      rows.push({ key: "cooldown", label: "Cooldown", status: "warn", detail: `${today.cooldown_minutes_left} min left after your loss on ${ctx.symbol}.` });
    }
    rows.push(
      today.trades_today >= today.trade_cap
        ? { key: "trades", label: "Trades today", status: "warn", detail: `This would be trade ${today.trades_today + 1}, over your cap of ${today.trade_cap}.` }
        : { key: "trades", label: "Trades today", status: "good", detail: `${today.trades_today} of ${today.trade_cap}.` },
    );
    if (today.loss_room == null) rows.push({ key: "loss", label: "Loss limit", status: "na", detail: "No daily loss limit set." });
    else if (today.loss_room <= 0) rows.push({ key: "loss", label: "Loss limit", status: "bad", detail: "Your daily loss limit is already reached." });
    else if (a.riskAmount != null && a.riskAmount > today.loss_room) rows.push({ key: "loss", label: "Loss limit", status: "warn", detail: `This trade could take you past it (${formatInr(today.loss_room)} of room).` });
    else rows.push({ key: "loss", label: "Loss limit", status: "good", detail: `${formatInr(today.loss_room)} of room left today.` });
    if (today.off_window) rows.push({ key: "window", label: "Session", status: "warn", detail: "Outside the middle of the session: the first 10 minutes, the last 15, or after hours." });
  }
  return rows;
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
