import { describe, expect, it } from "vitest";
import { EMPTY_TICKET, PRICE_STALE_MS, analyzeTicket, buildOrder, defaultLevel, checkList, computeRR, emptyTicketFor, favorable, instrumentFor, isFresh, optionsAvailable, parseTradeParams, planStatus, riskLots, suggestPlan, STOP_WIDEN_MESSAGE, type Ticket, type TicketContext } from "./tradeModel";

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

describe("suggestPlan", () => {
  it("puts the stop one typical move against the trade and the target as far as the minimum reward-to-risk asks", () => {
    expect(suggestPlan("BUY", 1000, 10, 3)).toEqual({ stop: 990, target: 1030 });
    expect(suggestPlan("SELL", 1000, 10, 3)).toEqual({ stop: 1010, target: 970 });
  });

  it("never plans under 2:1, whatever the minimum says", () => {
    expect(suggestPlan("BUY", 1000, 10, 1)).toEqual({ stop: 990, target: 1020 });
  });

  it("keeps a stop already typed and measures the target from it", () => {
    expect(suggestPlan("BUY", 1000, 10, 2, 980)).toEqual({ stop: 980, target: 1040 });
  });

  it("has nothing to suggest without a price", () => {
    expect(suggestPlan("BUY", null, 10, 2)).toBeNull();
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

  it("is not shown for an option order", () => {
    expect(status({ strategy: "naked", stop: "990" })).toBeNull();
  });
});

describe("the live-stop message", () => {
  it("is the one the server sends", () => {
    expect(STOP_WIDEN_MESSAGE).toBe("The stop can only move toward price once the order is live.");
  });
});
