import { describe, expect, it } from "vitest";
import { EMPTY_TICKET, PRICE_STALE_MS, analyzeTicket, buildOrder, defaultLevel, checkList, computeRR, cryptoLeverage, effectiveTicket, emptyTicketFor, favorable, instrumentFor, isFresh, marketStateOf, optionsAvailable, parseTradeParams, planAvailable, planHint, planNudges, planRows, planSide, planStatus, planTag, riskLots, STOP_WIDEN_MESSAGE, type Ticket, type TicketContext } from "./tradeModel";

const ctx = (over: Partial<TicketContext> = {}): TicketContext => ({
  price: 1000, lotSize: 1, capital: 100000, riskPct: 1, minRR: 2, requireStop: false, segment: "NSE", symbol: "RELIANCE", ...over,
});
const ticket = (over: Partial<Ticket> = {}): Ticket => ({ ...EMPTY_TICKET, ...over });

describe("parseTradeParams", () => {
  it("defaults to Nifty for a missing or nonsense symbol", () => {
    expect(parseTradeParams(null, null)).toEqual({ symbol: "NIFTY", segment: "NSE" });
    expect(parseTradeParams("<script>", "NSE")).toEqual({ symbol: "NIFTY", segment: "NSE" });
    expect(parseTradeParams("", "MCX")).toEqual({ symbol: "NIFTY", segment: "NSE" });
  });

  it("a known contract carries its own segment whatever the URL says", () => {
    expect(parseTradeParams("goldm", "NSE")).toEqual({ symbol: "GOLDM", segment: "MCX" });
    expect(parseTradeParams("BTCUSD", null)).toEqual({ symbol: "BTCUSD", segment: "CRYPTO" });
  });

  it("an unknown symbol is an NSE stock unless told otherwise", () => {
    expect(parseTradeParams("reliance", null)).toEqual({ symbol: "RELIANCE", segment: "NSE" });
    expect(parseTradeParams("M&M", "bogus")).toEqual({ symbol: "M&M", segment: "NSE" });
  });
});

describe("instrument", () => {
  it("stocks are shares, contracts are lots, and only contracts have options", () => {
    expect(instrumentFor("RELIANCE", "NSE")).toBe("spot");
    expect(instrumentFor("NIFTY", "NSE")).toBe("future");
    expect(instrumentFor("GOLDM", "MCX")).toBe("future");
    expect(optionsAvailable("NIFTY")).toBe(true);
    expect(optionsAvailable("RELIANCE")).toBe(false);
  });
});

describe("emptyTicketFor", () => {
  it("starts on Future when that is the preference, whatever else is blank", () => {
    expect(emptyTicketFor("NIFTY", "future", "naked").strategy).toBe("future");
    expect(emptyTicketFor("NIFTY", "future", "spread").strategy).toBe("future");
  });

  it("starts on the preferred option style when the preference is Option and options exist", () => {
    expect(emptyTicketFor("NIFTY", "option", "naked").strategy).toBe("naked");
    expect(emptyTicketFor("NIFTY", "option", "spread").strategy).toBe("spread");
  });

  it("falls back to Future for an Option preference on a symbol with no options", () => {
    expect(emptyTicketFor("RELIANCE", "option", "spread").strategy).toBe("future");
  });

  it("otherwise matches EMPTY_TICKET exactly - only the strategy field differs", () => {
    expect(emptyTicketFor("NIFTY", "option", "spread")).toEqual({ ...EMPTY_TICKET, strategy: "spread" });
  });
});

describe("sizing", () => {
  it("sizes by risk, capped by capital, at least one lot", () => {
    // budget 1000, stop distance 10 -> 100 units, capital allows 100
    expect(riskLots(100000, 1, 1000, 990, 1)).toBe(100);
    // a tight stop would allow 1000 units but capital only allows 100
    expect(riskLots(100000, 1, 1000, 999, 1)).toBe(100);
    // one lot is 65 units: 1000 / (10*65) = 1.5 -> 1
    expect(riskLots(1_000_000, 0.1, 23000, 22990, 65)).toBe(1);
    // an enormous stop still gives one lot rather than zero
    expect(riskLots(100000, 1, 1000, 100, 1)).toBe(1);
  });

  it("returns null when it cannot be worked out", () => {
    expect(riskLots(100000, 1, 1000, 1000, 1)).toBeNull();
    expect(riskLots(100000, 1, null, 990, 1)).toBeNull();
    expect(riskLots(100000, 1, 1000, 990, 0)).toBeNull();
  });

  it("computes reward-to-risk in either direction", () => {
    expect(computeRR(100, 90, 130)).toBe(3);
    expect(computeRR(100, 110, 70)).toBe(3);
    expect(computeRR(100, 100, 130)).toBeNull();
    expect(computeRR(null, 90, 130)).toBeNull();
  });
});

describe("analyzeTicket", () => {
  it("a market buy uses the live price, sizes from risk and shows rupees at risk", () => {
    const a = analyzeTicket(ticket({ stop: "990", target: "1030" }), ctx());
    expect(a.entry).toBe(1000);
    expect(a.lots).toBe(100);
    expect(a.lotsAuto).toBe(true);
    expect(a.riskAmount).toBe(1000);
    expect(a.rewardAmount).toBe(3000);
    expect(a.rr).toBe(3);
    expect(a.errors).toEqual([]);
  });

  it("refuses a stop on the wrong side, and a target on the wrong side, in words", () => {
    expect(analyzeTicket(ticket({ stop: "1010" }), ctx()).errors[0]).toMatch(/stop-loss must be below/);
    expect(analyzeTicket(ticket({ action: "SELL", stop: "990" }), ctx()).errors[0]).toMatch(/stop-loss must be above/);
    expect(analyzeTicket(ticket({ target: "990" }), ctx()).errors[0]).toMatch(/target must be above/);
    expect(analyzeTicket(ticket({ action: "SELL", target: "1010" }), ctx()).errors[0]).toMatch(/target must be below/);
  });

  it("a stop or target exactly at the entry is no stop or target: refused too", () => {
    expect(analyzeTicket(ticket({ stop: "1000" }), ctx()).errors[0]).toMatch(/stop-loss must be below/);
    expect(analyzeTicket(ticket({ target: "1000" }), ctx()).errors[0]).toMatch(/target must be above/);
    expect(analyzeTicket(ticket({ action: "SELL", stop: "1000" }), ctx()).errors[0]).toMatch(/stop-loss must be above/);
  });

  it("requires a stop-loss when the account does, and only warns when it does not", () => {
    expect(analyzeTicket(ticket(), ctx({ requireStop: true })).errors.join(" ")).toMatch(/require a stop-loss/);
    const soft = analyzeTicket(ticket(), ctx({ requireStop: false }));
    expect(soft.errors).toEqual([]);
    expect(soft.warnings.join(" ")).toMatch(/No stop-loss/);
  });

  it("never requires or warns about a stop-loss for an option - every option position here is already risk-capped", () => {
    const naked = analyzeTicket(ticket({ strategy: "naked" }), ctx({ requireStop: true }));
    expect(naked.errors.join(" ")).not.toMatch(/require a stop-loss/);
    expect(naked.warnings.join(" ")).not.toMatch(/No stop-loss/);
    const spread = analyzeTicket(ticket({ strategy: "spread" }), ctx({ requireStop: false }));
    expect(spread.warnings.join(" ")).not.toMatch(/No stop-loss/);
  });

  it("a limit order needs its price, and is judged against that price, not the live one", () => {
    expect(analyzeTicket(ticket({ orderType: "limit" }), ctx()).errors.join(" ")).toMatch(/price you want/);
    const a = analyzeTicket(ticket({ orderType: "limit", entry: "980", stop: "970", target: "1010" }), ctx());
    expect(a.entry).toBe(980);
    expect(a.errors).toEqual([]);
    expect(a.riskAmount).toBe(a.lots! * 10);
  });

  it("refuses a waiting order for a credit spread - the pending-order watcher can't build one yet", () => {
    const a = analyzeTicket(ticket({ orderType: "limit", strategy: "credit_spread", entry: "980" }), ctx());
    expect(a.errors.join(" ")).toMatch(/credit spread/);
    // The same ticket at Market instead isn't blocked by this rule.
    expect(analyzeTicket(ticket({ orderType: "market", strategy: "credit_spread" }), ctx()).errors.join(" ")).not.toMatch(/credit spread/);
  });

  it("waits for a live price on a market order", () => {
    expect(analyzeTicket(ticket({ stop: "990" }), ctx({ price: null })).errors.join(" ")).toMatch(/live price/);
  });

  it("warns, without blocking, on a thin reward-to-risk", () => {
    const a = analyzeTicket(ticket({ stop: "990", target: "1010" }), ctx());
    expect(a.errors).toEqual([]);
    expect(a.warnings.join(" ")).toMatch(/below your minimum of 2/);
  });

  it("a size typed by hand is used as is, and warned about when it risks too much", () => {
    const a = analyzeTicket(ticket({ stop: "990", lots: "500" }), ctx());
    expect(a.lots).toBe(500);
    expect(a.lotsAuto).toBe(false);
    expect(a.riskAmount).toBe(5000);
    expect(a.warnings.join(" ")).toMatch(/more than your 1%/);
    expect(analyzeTicket(ticket({ lots: "-1" }), ctx()).errors.join(" ")).toMatch(/size above 0/);
    expect(analyzeTicket(ticket({ lots: "abc" }), ctx()).errors.join(" ")).toMatch(/size above 0/);
  });

  it("uses the contract's lot size for futures", () => {
    const a = analyzeTicket(ticket({ stop: "22700" }), ctx({ price: 23000, lotSize: 65, capital: 30_000_000, symbol: "NIFTY" }));
    // budget 300,000 / (300 * 65) = 15.4 -> 15 lots; capital would allow 20
    expect(a.lots).toBe(15);
    expect(a.riskAmount).toBe(15 * 65 * 300);
    // a smaller account is held back by its capital, not its risk budget
    expect(analyzeTicket(ticket({ stop: "22700" }), ctx({ price: 23000, lotSize: 65, capital: 5_000_000, riskPct: 5, symbol: "NIFTY" })).lots).toBe(3);
  });

  it("does not pretend to know the rupee risk of options or crypto: the server sizes those", () => {
    expect(analyzeTicket(ticket({ strategy: "naked", stop: "990" }), ctx()).lots).toBeNull();
    expect(analyzeTicket(ticket({ stop: "9900" }), ctx({ segment: "CRYPTO", price: 10000, symbol: "BTCUSD" })).riskAmount).toBeNull();
  });
});

describe("checkList", () => {
  const a = (t: Partial<Ticket> = {}) => analyzeTicket(ticket({ stop: "990", target: "1030", ...t }), ctx());
  const find = (checks: ReturnType<typeof checkList>, key: string) => checks.find((c) => c.key === key)!;

  it("marks trading with the trend good and against it bad", () => {
    const up = { regime: "trending_up" as const, trend: "up" as const, adx: 30 };
    expect(find(checkList(ticket(), a(), ctx(), up, null), "regime").status).toBe("good");
    expect(find(checkList(ticket({ action: "SELL", stop: "1010", target: "970" }), a({ action: "SELL", stop: "1010", target: "970" }), ctx(), up, null), "regime").status).toBe("bad");
    expect(find(checkList(ticket(), a(), ctx(), { regime: "ranging", trend: "range", adx: 12 }, null), "regime").status).toBe("warn");
  });

  it("marks a missing stop bad, and reward-to-risk not applicable until there is a target", () => {
    const noStop = analyzeTicket(ticket(), ctx());
    const c = checkList(ticket(), noStop, ctx(), null, null);
    expect(find(c, "stop").status).toBe("bad");
    expect(find(c, "rr").status).toBe("na");
    expect(find(c, "regime").status).toBe("na");
  });

  it("judges the trade against what is left of the daily loss limit", () => {
    const t = ticket({ stop: "990" });
    const an = analyzeTicket(t, ctx()); // risk 1000
    expect(find(checkList(t, an, ctx(), null, { limit: 5000, lostToday: 0 }), "budget").status).toBe("good");
    expect(find(checkList(t, an, ctx(), null, { limit: 5000, lostToday: 4500 }), "budget").status).toBe("bad"); // 500 left, risking 1000
    expect(find(checkList(t, an, ctx(), null, { limit: 5000, lostToday: 5000 }), "budget").status).toBe("bad");
    expect(find(checkList(t, an, ctx(), null, null), "budget").status).toBe("na");
  });

  it("counts favourable items out of those that apply", () => {
    const c = checkList(ticket(), a(), ctx(), { regime: "trending_up", trend: "up", adx: 30 }, null);
    // stop good, rr good (3), regime good, trend good, budget n/a
    expect(favorable(c)).toEqual({ good: 4, total: 4 });
  });
});

describe("buildOrder", () => {
  const meta = { instrument: "spot" as const, interval: "15min", trendFollowed: true };

  it("a market stock order goes to /positions/manual at the live price, sized by the server from the stop", () => {
    const t = ticket({ stop: "990", target: "1030", setupTag: "Breakout", confidence: 4, reason: "  Retested the OB.  " });
    const o = buildOrder(t, analyzeTicket(t, ctx()), ctx(), meta);
    expect(o.kind).toBe("position");
    expect(o.path).toBe("/positions/manual");
    expect(o.body).toMatchObject({
      segment: "NSE", symbol: "RELIANCE", action: "BUY", instrument_type: "spot", price: 1000, order_type: "market",
      stop_loss_price: 990, target_price: 1030, risk_managed: true, trend_followed: true, setup_tag: "Breakout", confidence: 4, entry_interval: "15min",
      notes: "Retested the OB.", // trimmed
    });
    expect("quantity" in o.body).toBe(false); // auto: the server sizes it
  });

  it("sends the size when it was typed, and marks the order not risk-managed", () => {
    const t = ticket({ stop: "990", lots: "5" });
    const o = buildOrder(t, analyzeTicket(t, ctx()), ctx(), meta);
    expect(o.body).toMatchObject({ quantity: 5, risk_managed: false });
  });

  it("a limit order is armed on the server, at the typed level", () => {
    const t = ticket({ orderType: "limit", entry: "980", stop: "970" });
    const o = buildOrder(t, analyzeTicket(t, ctx()), ctx(), meta);
    expect(o.kind).toBe("pending");
    expect(o.path).toBe("/pending-orders");
    expect(o.body).toMatchObject({ trigger_price: 980, stop_loss_price: 970, strategy: "future", symbol: "RELIANCE" });
    expect("price" in o.body).toBe(false);
  });

  it("a waiting option order carries the exact legs the ticket showed, so it opens those and not a fresh pick", () => {
    const t = ticket({ orderType: "limit", entry: "23100", strategy: "spread", moneyness: "OTM1", primaryStrike: 23200, secondStrike: 23300, expiry: "2026-10-27", spreadWidth: 2, reason: "retest" });
    const c = ctx({ price: 23000, symbol: "NIFTY", lotSize: 65 });
    const o = buildOrder(t, analyzeTicket(t, c), c, { ...meta, instrument: "future" });
    expect(o.kind).toBe("pending");
    expect(o.body).toMatchObject({ strategy: "spread", trigger_price: 23100, primary_strike: 23200, second_strike: 23300, expiry: "2026-10-27", spread_width: 2, notes: "retest" });
  });

  it("a waiting naked option sends one strike and no second leg, and a waiting spot order sends no strikes at all", () => {
    const naked = ticket({ orderType: "limit", entry: "23100", strategy: "naked", primaryStrike: 23200, secondStrike: 23300, expiry: "2026-10-27" });
    const c = ctx({ price: 23000, symbol: "NIFTY", lotSize: 65 });
    const o = buildOrder(naked, analyzeTicket(naked, c), c, { ...meta, instrument: "future" });
    expect(o.body).toMatchObject({ primary_strike: 23200, expiry: "2026-10-27" });
    expect("second_strike" in o.body).toBe(false);
    expect("spread_width" in o.body).toBe(false);
    const spot = ticket({ orderType: "limit", entry: "980", stop: "970", primaryStrike: 23200, expiry: "2026-10-27" });
    const s2 = buildOrder(spot, analyzeTicket(spot, ctx()), ctx(), meta);
    expect("primary_strike" in s2.body || "expiry" in s2.body).toBe(false);
  });

  it("an option order goes to the option route, with the stop and target carried for the follow-up calls", () => {
    const t = ticket({ strategy: "spread", moneyness: "OTM1", stop: "22900", target: "23300" });
    const c = ctx({ price: 23000, symbol: "NIFTY", lotSize: 65 });
    const o = buildOrder(t, analyzeTicket(t, c), c, { ...meta, instrument: "future" });
    expect(o.kind).toBe("option");
    expect(o.path).toBe("/option-groups/manual");
    expect(o.body).toMatchObject({ option_position_style: "spread", option_strike_moneyness: "OTM1", symbol: "NIFTY", order_type: "market" });
    if (o.kind === "option") expect(o).toMatchObject({ stop: 22900, target: 23300 });
    expect("stop_loss_price" in o.body).toBe(false); // for options the stop lives on the underlying, set after
  });

  it("omits optional fields rather than sending nulls", () => {
    const t = ticket({ stop: "990" });
    const o = buildOrder(t, analyzeTicket(t, ctx()), ctx(), meta);
    for (const k of ["target_price", "setup_tag", "confidence", "notes"]) expect(k in o.body).toBe(false);
  });

  it("omits notes for a blank or whitespace-only reason", () => {
    const t = ticket({ stop: "990", reason: "   " });
    const o = buildOrder(t, analyzeTicket(t, ctx()), ctx(), meta);
    expect("notes" in o.body).toBe(false);
  });
});

describe("defaultLevel", () => {
  it("puts a stop against the trade, a target in its favour, and a waiting entry back from the price", () => {
    expect(defaultLevel("stop", "BUY", 1000)).toBe(998.5);
    expect(defaultLevel("target", "BUY", 1000)).toBe(1003);
    expect(defaultLevel("entry", "BUY", 1000)).toBe(999);
    expect(defaultLevel("stop", "SELL", 1000)).toBe(1001.5);
    expect(defaultLevel("target", "SELL", 1000)).toBe(997);
    expect(defaultLevel("entry", "SELL", 1000)).toBe(1001);
  });

  it("puts the target as far as the minimum reward-to-risk asks, never under two stop-distances", () => {
    expect(defaultLevel("target", "BUY", 1000, 10, 4)).toBe(1040);
    expect(defaultLevel("target", "SELL", 1000, 10, 3)).toBe(970);
    expect(defaultLevel("target", "BUY", 1000, 10, 1)).toBe(1020); // a lower minimum still plans 2:1
    expect(defaultLevel("target", "BUY", 1000, null, 4)).toBe(1006); // no bar-move to measure by: a share of the price, scaled the same way
    expect(defaultLevel("stop", "BUY", 1000, 10, 4)).toBe(990); // the stop is unchanged
  });

  it("gives levels on the right side for the order, which the ticket accepts", () => {
    for (const action of ["BUY", "SELL"] as const) {
      const t = ticket({ action, stop: String(defaultLevel("stop", action, 1000)), target: String(defaultLevel("target", action, 1000)) });
      expect(analyzeTicket(t, ctx()).errors).toEqual([]);
    }
  });

  it("rounds to the decimals the chart shows", () => {
    expect(defaultLevel("stop", "BUY", 23140.5)).toBe(23105.79);
    expect(defaultLevel("stop", "BUY", 12.5)).toBe(12.481);
    expect(defaultLevel("target", "BUY", 0.5)).toBe(0.5015);
  });

  it("measures in the chart's typical bar move when it is known, so the line lands on screen", () => {
    // NIFTY near 22,540 on 1-minute bars moves about 6 points a bar: stop 6 away, target 12, entry 3 back
    expect(defaultLevel("stop", "BUY", 22540, 6)).toBe(22534);
    expect(defaultLevel("target", "BUY", 22540, 6)).toBe(22552);
    expect(defaultLevel("entry", "BUY", 22540, 6)).toBe(22537);
    expect(defaultLevel("stop", "SELL", 22540, 6)).toBe(22546);
    expect(defaultLevel("target", "SELL", 22540, 6)).toBe(22528);
  });

  it("ignores an unusable typical move and falls back to a share of the price", () => {
    expect(defaultLevel("stop", "BUY", 1000, 0)).toBe(998.5);
    expect(defaultLevel("stop", "BUY", 1000, Number.NaN)).toBe(998.5);
    expect(defaultLevel("stop", "BUY", 1000, null)).toBe(998.5);
  });

  it("has nothing to offer without a usable price", () => {
    expect(defaultLevel("stop", "BUY", null)).toBeNull();
    expect(defaultLevel("stop", "BUY", 0)).toBeNull();
    expect(defaultLevel("stop", "BUY", Number.NaN)).toBeNull();
  });
});

describe("isFresh", () => {
  it("is never fresh with no timestamp at all", () => {
    expect(isFresh(null, Date.now())).toBe(false);
  });

  it("is fresh right up to, but not at or past, the staleness cutoff", () => {
    const now = 1_700_000_000_000;
    expect(isFresh(now - (PRICE_STALE_MS - 1), now)).toBe(true);
    expect(isFresh(now - PRICE_STALE_MS, now)).toBe(false);
    expect(isFresh(now, now)).toBe(true); // just arrived
  });
});

describe("planStatus", () => {
  const status = (over: Partial<Ticket>, c = ctx()) => {
    const t = ticket(over);
    return planStatus(t, analyzeTicket(t, c), c);
  };

  it("says there is no plan until a stop is set", () => {
    expect(status({})).toMatchObject({ tone: "empty" });
  });

  it("says the reward is unplanned when there is a stop and no target", () => {
    expect(status({ stop: "990" })).toMatchObject({ tone: "partial", text: expect.stringContaining("reward unplanned") });
  });

  it("shows reward-to-risk and the risk as a share of capital once planned", () => {
    expect(status({ stop: "990", target: "1030" })).toEqual({ tone: "ready", text: "Planned · R:R 3.0 · risk 1.0%" });
  });

  it("warns when the reward-to-risk is under the minimum", () => {
    expect(status({ stop: "990", target: "1010" })).toMatchObject({ tone: "warn", text: expect.stringContaining("under your 2 minimum") });
  });

  it("warns when the size was typed over the plan and risks more than it", () => {
    expect(status({ stop: "990", target: "1030", lots: "500" })).toMatchObject({ tone: "warn", text: expect.stringContaining("Size above your plan") });
  });

  it("warns when even the system's smallest size (one lot) risks more than the plan", () => {
    // 65-unit lots, a 20-point stop: one lot risks 1300 of a 100000 capital at a 1% plan (1000)
    expect(status({ stop: "980", target: "1040" }, ctx({ lotSize: 65 }))).toMatchObject({ tone: "warn", text: expect.stringContaining("Even the smallest size is over your plan") });
  });

  it("covers an option order too, on the underlying's levels, with no risk figure (the server sizes it)", () => {
    expect(status({ strategy: "naked" })).toMatchObject({ tone: "empty", text: expect.stringContaining("on the underlying") });
    expect(status({ strategy: "naked", stop: "990", target: "1030" })).toEqual({ tone: "ready", text: "Planned · R:R 3.0" });
    expect(status({ strategy: "spread", stop: "990" })).toMatchObject({ tone: "partial", text: "Stop set · reward unplanned" });
  });
});

describe("the live-stop message", () => {
  it("is the one the server sends", () => {
    expect(STOP_WIDEN_MESSAGE).toBe("The stop can only move toward price once the order is live.");
  });
});

describe("planRows", () => {
  const rows = (over: Partial<Ticket>, today: Parameters<typeof planRows>[3] = null, c = ctx()) => {
    const t = ticket(over);
    return planRows(t, analyzeTicket(t, c), c, today);
  };
  const row = (r: ReturnType<typeof rows>, key: string) => r.find((x) => x.key === key)!;
  const today = (over: object = {}) => ({
    segment: "NSE" as const, symbol: "RELIANCE", cooldown_minutes_left: 0, cooldown_minutes: 15, trades_today: 1, trade_cap: 6,
    loss_limit: null, lost_today: 0, loss_room: null, off_window: false, ...over,
  });

  it("lists stop, size, reward, setup and entry in the order the score checks them", () => {
    expect(rows({}).map((r) => r.key)).toEqual(["stop", "size", "reward", "setup", "entry"]);
  });

  it("calls a missing stop bad for a spot or future order and only a caution for an option", () => {
    expect(row(rows({}), "stop")).toMatchObject({ status: "bad" });
    expect(row(rows({ strategy: "naked" }), "stop")).toMatchObject({ status: "warn" });
  });

  it("measures size against the system size: at it good, above it a caution, far below it for information", () => {
    expect(row(rows({ stop: "990" }), "size")).toMatchObject({ status: "good" });
    expect(row(rows({ stop: "990", lots: "500" }), "size")).toMatchObject({ status: "warn", detail: expect.stringContaining("Above the system size (100)") });
    expect(row(rows({ stop: "990", lots: "20" }), "size")).toMatchObject({ status: "info", detail: expect.stringContaining("Below the system size (100)") });
    expect(row(rows({ stop: "990", lots: "90" }), "size")).toMatchObject({ status: "good" });
    expect(row(rows({}), "size")).toMatchObject({ status: "na" });
  });

  it("warns when even the smallest size is over the plan", () => {
    expect(row(rows({ stop: "980" }, null, ctx({ lotSize: 65 })), "size")).toMatchObject({ status: "warn", detail: expect.stringContaining("Even the smallest size") });
  });

  it("checks reward against the minimum, and says when there is no target", () => {
    expect(row(rows({ stop: "990", target: "1030" }), "reward").status).toBe("good");
    expect(row(rows({ stop: "990", target: "1010" }), "reward").status).toBe("warn");
    expect(row(rows({ stop: "990" }), "reward")).toMatchObject({ status: "warn", detail: "No target: the reward is unplanned." });
  });

  it("adds the day's rows from the server: a cooldown only while it runs, the cap, the loss limit, the session edge", () => {
    expect(rows({}, today()).map((r) => r.key)).toEqual(["stop", "size", "reward", "setup", "entry", "trades", "loss"]);
    const busy = rows({ stop: "990", lots: "100" }, today({ cooldown_minutes_left: 7, trades_today: 6, loss_limit: 1000, lost_today: 800, loss_room: 200, off_window: true }));
    expect(busy.map((r) => r.key)).toEqual(["stop", "size", "reward", "setup", "entry", "cooldown", "trades", "loss", "window"]);
    expect(row(busy, "cooldown").detail).toBe("7 min left after your loss on RELIANCE.");
    expect(row(busy, "trades")).toMatchObject({ status: "warn", detail: "This would be trade 7, over your cap of 6." });
    expect(row(busy, "loss").status).toBe("warn"); // risking 1000 against 200 of room
    expect(row(rows({}, today({ loss_limit: 1000, lost_today: 1000, loss_room: 0 })), "loss").status).toBe("bad");
  });
});


describe("the plan: market state x plan", () => {
  const regime = (r: string) => ({ regime: r, trend: r === "trending_up" ? "up" : r === "trending_down" ? "down" : "range", adx: 25 }) as never;

  it("reads the market state from the regime badge, and leaves it to the person while the market is changing or unknown", () => {
    expect(marketStateOf(regime("trending_up"))).toBe("trending_up");
    expect(marketStateOf(regime("trending_down"))).toBe("trending_down");
    expect(marketStateOf(regime("ranging"))).toBe("ranging");
    expect(marketStateOf(regime("transitional"))).toBeNull();
    expect(marketStateOf(null)).toBeNull();
  });

  it("three plans give five labels: a pullback needs a trend, a breakout and a reversal exist in both", () => {
    expect(planTag("trending_up", "pullback")).toBe("Trend pullback");
    expect(planTag("trending_down", "pullback")).toBe("Trend pullback");
    expect(planTag("ranging", "pullback")).toBeNull(); // no trend to pull back within
    expect(planAvailable("ranging", "pullback")).toBe(false);
    expect(planAvailable("ranging", "breakout")).toBe(true);
    expect(planTag("trending_up", "breakout")).toBe("Trend breakout");
    expect(planTag("ranging", "breakout")).toBe("Range break");
    expect(planTag("trending_down", "reversal")).toBe("Trend reversal");
    expect(planTag("ranging", "reversal")).toBe("Range fade");
    expect(planTag(null, "breakout")).toBeNull(); // the market state is not known yet
    expect(planTag("ranging", null)).toBeNull();
  });

  it("a trend implies the side (a reversal is the opposite), and a range leaves it to the person", () => {
    expect(planSide("trending_up", "pullback")).toBe("BUY");
    expect(planSide("trending_up", "breakout")).toBe("BUY");
    expect(planSide("trending_up", "reversal")).toBe("SELL");
    expect(planSide("trending_down", "pullback")).toBe("SELL");
    expect(planSide("trending_down", "reversal")).toBe("BUY");
    expect(planSide("ranging", "reversal")).toBeNull(); // which edge price is at decides it
    expect(planSide(null, "breakout")).toBeNull();
  });

  it("says how to enter in words for the market the person is in", () => {
    expect(planHint("trending_up", "breakout")).toBe("Enter as the previous high is taken.");
    expect(planHint("trending_down", "breakout")).toBe("Enter as the previous low is taken.");
    expect(planHint("ranging", "breakout")).toMatch(/tested twice or more/);
    expect(planHint("ranging", "reversal")).toMatch(/Fade the edge.*rejection/);
    expect(planHint("trending_up", "reversal")).toMatch(/Against the trend/);
    expect(planHint("ranging", "pullback")).toMatch(/needs a trend/);
    expect(planHint("ranging", null)).toBe("");
  });

  it("the label kept with the trade follows the regime read until the person pins a market state", () => {
    const t = ticket({ planKind: "breakout" });
    expect(effectiveTicket(t, regime("trending_up")).setupTag).toBe("Trend breakout");
    expect(effectiveTicket(t, regime("ranging")).setupTag).toBe("Range break"); // the read changed: so did the label
    expect(effectiveTicket({ ...t, planState: "trending_down" }, regime("ranging")).setupTag).toBe("Trend breakout"); // pinned
    expect(effectiveTicket(t, null).setupTag).toBeNull(); // nothing to derive it from
    expect(effectiveTicket(ticket({ setupTag: "News" }), regime("ranging")).setupTag).toBe("News"); // no plan chosen: whatever was there stays
    expect(effectiveTicket(ticket({ planKind: "pullback", setupTag: "News" }), regime("ranging")).setupTag).toBe("News"); // an impossible pair derives nothing
  });

  it("nudges, never blocks: against the plan's side, counter-trend risk, a thin fade", () => {
    const a = (t: Ticket) => analyzeTicket(t, ctx());
    const sellInUp = ticket({ planKind: "pullback", action: "SELL" });
    expect(planNudges(sellInUp, a(sellInUp), "trending_up")[0]).toMatch(/against the plan: a pullback in an uptrend is a Buy/);
    const counter = ticket({ planKind: "reversal", action: "SELL" });
    expect(planNudges(counter, a(counter), "trending_up")).toEqual([expect.stringMatching(/riskier plan.*half/)]);
    const thin = ticket({ planKind: "reversal", entry: "1000", stop: "990", target: "1010", orderType: "limit" });
    expect(planNudges(thin, a(thin), "ranging")[0]).toMatch(/1\.0 to 1 is thin/);
    const fine = ticket({ planKind: "reversal", entry: "1000", stop: "990", target: "1030", orderType: "limit" });
    expect(planNudges(fine, a(fine), "ranging")).toEqual([]);
    expect(planNudges(ticket(), a(ticket()), "ranging")).toEqual([]); // no plan chosen
    expect(planNudges(sellInUp, a(sellInUp), null)).toEqual([]); // market state unknown
  });

  it("what the person saw goes into the order's notes, before their own words, and the tag is the derived one", () => {
    const t = effectiveTicket(ticket({ stop: "990", planKind: "reversal", planState: "ranging", trigger: "Order block", reason: "  Second test.  " }), null);
    const o = buildOrder(t, analyzeTicket(t, ctx()), ctx(), { instrument: "spot", interval: "15min", trendFollowed: false });
    expect(o.body).toMatchObject({ setup_tag: "Range fade", notes: "Saw: Order block. Second test." });
    const noWords = effectiveTicket(ticket({ stop: "990", trigger: "News" }), null);
    expect(buildOrder(noWords, analyzeTicket(noWords, ctx()), ctx(), { instrument: "spot", interval: "15min", trendFollowed: false }).body).toMatchObject({ notes: "Saw: News." });
  });
});

describe("crypto: dollars in, rupees out", () => {
  // BTCUSD: lot 0.001, price $80,000, capital ₹100,000 at ₹90/$ = $1,111.11, 5x leverage
  const btc = (over: Partial<TicketContext> = {}) => ctx({ price: 80000, lotSize: 0.001, segment: "CRYPTO", symbol: "BTCUSD", usdinr: 90, leverage: 5, ...over });

  it("shows the risk and reward in rupees, through the rate", () => {
    const a = analyzeTicket(ticket({ lots: "100", stop: "79000", target: "82000" }), btc());
    // 100 lots x 0.001 = 0.1 BTC; $1,000 a unit to the stop = $100 = ₹9,000; $2,000 to the target = $200 = ₹18,000
    expect(a.riskAmount).toBeCloseTo(9000);
    expect(a.rewardAmount).toBeCloseTo(18000);
  });

  it("has no rupee figure at all while no rate is set, rather than dollars called rupees", () => {
    const a = analyzeTicket(ticket({ lots: "100", stop: "79000", target: "82000" }), btc({ usdinr: null }));
    expect(a.riskAmount).toBeNull();
    expect(a.rewardAmount).toBeNull();
    expect(a.lots).toBe(100);
  });

  it("works out the size the server will use: the risk allows it, the margin caps it", () => {
    // risk 1% of $1,111.11 = $11.11; a $1,000 stop costs $1 a lot (0.001 BTC), so 11 lots
    expect(analyzeTicket(ticket({ stop: "79000" }), btc()).lots).toBe(11);
    // a $20 stop: $11.11 / (20 x 0.001) = 555 lots by risk; the margin buys 5 x 1,111.11 / (80,000 x 0.001) = 69 lots, so 69
    expect(analyzeTicket(ticket({ stop: "79980" }), btc()).lots).toBe(69);
  });

  it("more leverage buys more with the same capital", () => {
    const at = (leverage: number) => analyzeTicket(ticket({}), btc({ leverage })).lots;
    expect(at(1)).toBe(13);
    expect(at(5)).toBe(69);
  });

  it("warns when the stop is beyond where the trade would be liquidated", () => {
    // 10x: liquidated about 9.5% away, so 72,400 for a buy at 80,000
    const far = analyzeTicket(ticket({ stop: "70000", lots: "1" }), btc({ leverage: 10 }));
    expect(far.warnings.some((w) => /liquidated near 72400\.00/.test(w))).toBe(true);
    const near = analyzeTicket(ticket({ stop: "78000", lots: "1" }), btc({ leverage: 10 }));
    expect(near.warnings.some((w) => /liquidated/.test(w))).toBe(false);
  });
});

describe("cryptoLeverage", () => {
  it("is liquidated a little before 1 / leverage away, either way round", () => {
    expect(cryptoLeverage(100, true, 10)?.liquidation).toBeCloseTo(100 * (1 - 0.095));
    expect(cryptoLeverage(100, false, 10)?.liquidation).toBeCloseTo(100 * (1 + 0.095));
    expect(cryptoLeverage(100, true, 10)?.awayPct).toBeCloseTo(9.5);
  });
  it("has nothing to say at 1x or without an entry", () => {
    expect(cryptoLeverage(100, true, 1)).toBeNull();
    expect(cryptoLeverage(null, true, 10)).toBeNull();
  });
});
