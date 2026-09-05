import { useCallback, useEffect, useRef, useState } from "react";

import {
  type Account,
  type ManualOptionGroup,
  type ManualPosition,
  type Segment,
  fetchAccounts,
  fetchExecPositions,
  fetchOptionGroups,
} from "./api";
import ChartTradePanel from "./ChartTradePanel";
import { type ChartContext, type IntervalTrend, type PricePickField, LiveChartPanel } from "./LiveChartPanel";
import { type PendingOrder, fetchUnderlyingLtp, fmt, fmtMoney, placeManualOrder, pendingTriggerCrossed } from "./manualOrder";

// Standalone Intraday sub-tab wrapping the candlestick panel (see
// LiveChartPanel.tsx for the live-data mechanics and the klinecharts
// rationale). One tab per instrument on the desk's fixed intraday
// watchlist rather than a free-text segment/symbol picker - the same
// move OiSummaryPage made (see its PRESETS): the list is short and
// known (2 NSE index, 2 MCX commodity, 3 crypto), so a tab bar beats a
// dropdown + text field. The last-picked symbol is remembered in
// localStorage.

const SYMBOL_STORAGE_KEY = "manualLiveChartSymbol";

// "Trend only" (the SMC-structure-trend direction lock, manualChartForceTrendDirection)
// was removed 2026-09-04 - structure_state's confirmed trend only sets on a
// BOS, so it often turned well after the move was already tradeable, and a
// hard gate on a laggy signal blocked good trades more than it prevented bad
// ones. The chart-interval trend is still surfaced, now informationally, in
// ChartTradePanel's confluence readout alongside the (more responsive) ADX
// regime badge (see GET /regime) - nothing here blocks placement on it.

// "Risk managed" gate - requires Limit(or LTP)/SL/Target and blocks
// placement when reward:risk is below the segment's configured minimum
// (execution.accounts.min_reward_risk_ratio). Also omits the lot count so
// execution risk-sizes it. Persisted globally, default ON (opt out, same
// as the trend lock - both are discipline aids).
const RISK_MANAGED_STORAGE_KEY = "manualChartRiskManaged";

// Armed limit orders, one per symbol max (the panel is single-slot). Held
// HERE, not in ChartTradePanel, because this component does NOT remount
// on a symbol-tab switch (only LiveChartPanel/ChartTradePanel inside it
// are `key`-ed) - so an armed limit keeps being watched while you look at
// another chart. Mirrored to localStorage so it also survives a refresh.
const PENDING_STORAGE_KEY = "manualChartPendingOrders";

// How often the pending-order loop re-checks each armed limit against a
// fresh underlying LTP.
const PENDING_POLL_MS = 4000;

// How often the symbol tab bar re-checks which OTHER (non-active) symbols
// have an open trade - a slow poll, since it's just a tab dot, not a
// live-P&L readout (no with_live_pnl - a plain existence check for every
// segment in one pair of calls, cheap and quote-free).
const ACTIVE_TRADE_POLL_MS = 15_000;

const SYMBOLS: { symbol: string; segment: Segment }[] = [
  { symbol: "NIFTY", segment: "NSE" },
  { symbol: "BANKNIFTY", segment: "NSE" },
  { symbol: "GOLDM", segment: "MCX" },
  { symbol: "CRUDEOILM", segment: "MCX" },
  { symbol: "BTCUSD", segment: "CRYPTO" },
  { symbol: "ETHUSD", segment: "CRYPTO" },
  { symbol: "SOLUSD", segment: "CRYPTO" },
];

function storedSymbol(): (typeof SYMBOLS)[number] {
  // Deep link (?symbol=NIFTY) - the shell reloads this iframe at that URL
  // when the "Intraday Chart" link on the OI page is clicked (same
  // mechanism as ?tab=oi&symbol=). Wins over the remembered symbol;
  // falls back silently for an unknown/missing value.
  const requested = new URLSearchParams(window.location.search).get("symbol");
  const byUrl = requested ? SYMBOLS.find((s) => s.symbol === requested.toUpperCase()) : null;
  if (byUrl) return byUrl;
  const v = localStorage.getItem(SYMBOL_STORAGE_KEY);
  return SYMBOLS.find((s) => s.symbol === v) ?? SYMBOLS[0];
}

// Default ON - opt out, not in.
function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function loadPending(): Record<string, PendingOrder> {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PendingOrder>) : {};
  } catch {
    return {};
  }
}

export default function LiveChartPage() {
  const [active, setActive] = useState<(typeof SYMBOLS)[number]>(storedSymbol);
  // The chart-interval structure trend, lifted from LiveChartPanel so the
  // trade panel can lock direction to it.
  const [trendInfo, setTrendInfo] = useState<IntervalTrend>({ trend: null, interval: "5min" });
  const [riskManaged, setRiskManaged] = useState<boolean>(() => storedFlag(RISK_MANAGED_STORAGE_KEY));
  // The chart's own live price, so the trade panel shows exactly what the
  // chart shows instead of running a second, out-of-step LTP poll.
  const [chartLtp, setChartLtp] = useState<number | null>(null);
  const [chartContext, setChartContext] = useState<ChartContext>({ regime: null, oiBias: null });

  // The segment account (capital / risk% / min R:R) - fetched here rather
  // than in ChartTradePanel so the "Risk/Trade" figure can sit in the
  // discipline strip and the panel gets it as a prop (one fetch per
  // segment, not one per symbol remount).
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAccount(null);
    fetchAccounts()
      .then((accts) => {
        if (!cancelled) setAccount(accts.find((a) => a.segment === active.segment) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active.segment]);

  const [pending, setPending] = useState<Record<string, PendingOrder>>(loadPending);
  // Post-fire message for a symbol (a rejection reason, or a soft warning
  // that an option SL/target didn't attach) - shown by that symbol's panel.
  const [pendingNote, setPendingNote] = useState<Record<string, string>>({});

  // Chart price-pick: which panel field is waiting for a chart click, and
  // the last picked price (nonce so the same price twice still applies).
  const [pickField, setPickField] = useState<PricePickField | null>(null);
  const [pickedPrice, setPickedPrice] = useState<{ field: PricePickField; price: number; nonce: number } | null>(null);
  // The panel's single open trade, lifted so the chart's trade markers can
  // reuse its already-fetched live P&L instead of polling for it again.
  const [openTrade, setOpenTrade] = useState<{ pos: ManualPosition | null; group: ManualOptionGroup | null } | null>(null);

  // Which of the tab bar's symbols (any of them, not just the active one -
  // ChartTradePanel only ever knows about its own) currently has an open
  // manual position or option group - a small dot on that tab. HERE, not
  // in ChartTradePanel, for the same "outlives a symbol-tab switch" reason
  // the pending-order state is - a background poll across every segment,
  // independent of which chart you're looking at.
  const [activeTradeSymbols, setActiveTradeSymbols] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        // No withLivePnl / segment filter - a cheap existence check across
        // every segment in one pair of calls, not a quote-heavy P&L poll.
        const [positions, groups] = await Promise.all([
          fetchExecPositions({ status: "OPEN", manualOnly: true }),
          fetchOptionGroups({ status: "OPEN", manualOnly: true }),
        ]);
        if (cancelled) return;
        const next = new Set<string>();
        for (const { symbol } of SYMBOLS) {
          // Same matching convention as ChartTradePanel's own isStandaloneFuture/
          // isThisGroup: a future/spot position persists its resolved contract
          // symbol (not the bare underlying), so prefix-match; an option group
          // is keyed by underlying_symbol directly.
          const hasFuture = positions.some((p) => p.option_group_id == null && p.symbol.toUpperCase().startsWith(symbol));
          const hasGroup = groups.some((g) => g.underlying_symbol.toUpperCase() === symbol);
          if (hasFuture || hasGroup) next.add(symbol);
        }
        setActiveTradeSymbols(next);
      } catch {
        // transient - keep the last known state, retried next tick
      }
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), ACTIVE_TRADE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (!pickField) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickField(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickField]);

  function pick(entry: (typeof SYMBOLS)[number]) {
    localStorage.setItem(SYMBOL_STORAGE_KEY, entry.symbol);
    setActive(entry);
    setTrendInfo({ trend: null, interval: "5min" });
    setChartLtp(null);
    setChartContext({ regime: null, oiBias: null });
    // A price picked / armed for one symbol must not leak into another.
    setPickField(null);
    setPickedPrice(null);
    setOpenTrade(null);
  }

  function toggleFlag(key: string, setter: (fn: (v: boolean) => boolean) => void) {
    setter((v) => {
      const next = !v;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* private mode / quota - still applies this session */
      }
      return next;
    });
  }

  const persistPending = useCallback((next: Record<string, PendingOrder>) => {
    setPending(next);
    try {
      localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* best-effort - still armed this session */
    }
  }, []);

  const armPending = useCallback(
    (order: PendingOrder) => {
      setPendingNote((n) => {
        const { [order.symbol]: _drop, ...rest } = n;
        return rest;
      });
      persistPending({ ...loadPending(), [order.symbol]: order });
    },
    [persistPending],
  );

  const cancelPending = useCallback(
    (symbol: string) => {
      const { [symbol]: _drop, ...rest } = loadPending();
      persistPending(rest);
    },
    [persistPending],
  );

  // --- Pending-order watch loop. One timer for every armed limit, keyed
  // by symbol; fires placeManualOrder on the first crossing then drops it.
  // A ref Set guards against a slow place() call overlapping the next
  // tick for the same symbol. ---
  const firingRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    const tick = async () => {
      const orders = Object.values(pendingRef.current);
      if (orders.length === 0) return;
      for (const order of orders) {
        if (firingRef.current.has(order.symbol)) continue;
        let ltp: number;
        try {
          ltp = await fetchUnderlyingLtp(order.segment, order.symbol);
        } catch {
          continue; // retry next tick
        }
        if (!pendingTriggerCrossed(order, ltp)) continue;
        firingRef.current.add(order.symbol);
        try {
          const result = await placeManualOrder({
            segment: order.segment,
            symbol: order.symbol,
            action: order.action,
            strategy: order.strategy,
            moneyness: order.moneyness,
            orderType: "limit",
            entryPrice: order.triggerPrice,
            quantity: order.quantity,
            stop: order.stop,
            target: order.target,
            trendFollowed: order.trendFollowed,
            riskManaged: order.riskManaged,
            setupTag: order.setupTag,
            confidence: order.confidence,
            entryInterval: order.entryInterval,
          });
          const note = result.rejected
            ? `Limit order rejected: ${result.reason ?? "unknown"}`
            : (result.warning ?? "");
          setPendingNote((n) => (note ? { ...n, [order.symbol]: note } : n));
        } catch (e) {
          setPendingNote((n) => ({
            ...n,
            [order.symbol]: e instanceof Error ? e.message : "failed to place the limit order",
          }));
        } finally {
          const { [order.symbol]: _drop, ...rest } = loadPending();
          persistPending(rest);
          firingRef.current.delete(order.symbol);
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), PENDING_POLL_MS);
    return () => window.clearInterval(id);
  }, [persistPending]);

  const { trend, interval } = trendInfo;
  const activePending = pending[active.symbol] ?? null;

  return (
    <div className="live-chart-page">
      <nav className="tabs live-chart-symbols">
        {SYMBOLS.map((s) => (
          <button key={s.symbol} className={active.symbol === s.symbol ? "active" : ""} onClick={() => pick(s)}>
            {s.symbol}
            {activeTradeSymbols.has(s.symbol) && (
              <span className="live-chart-symbol-active-trade" title="An open trade is running on this symbol">
                ●
              </span>
            )}
            {pending[s.symbol] && (
              <span className="live-chart-symbol-pending" title={`Limit armed at ${fmt(pending[s.symbol].triggerPrice)}`}>
                ⏳
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="live-chart-layout">
        <LiveChartPanel
          key={`${active.segment}:${active.symbol}`}
          segment={active.segment}
          symbol={active.symbol}
          onTrendChange={setTrendInfo}
          onContextChange={setChartContext}
          onLtpChange={setChartLtp}
          pricePick={pickField}
          onPricePick={(price) => {
            if (pickField) setPickedPrice({ field: pickField, price, nonce: Date.now() });
            setPickField(null);
          }}
          openTrade={openTrade}
        />

        <div className="chart-trade-col">
          <div className="chart-discipline-row">
            <label
              className="chart-trend-lock"
              title="When on: limit orders only, Limit/Stop-loss/Target all required, the lot count is sized from your risk budget (limit price → stop-loss distance), and Proceed stays disabled until reward:risk clears the segment minimum (Money → account settings)."
            >
              <input
                type="checkbox"
                checked={riskManaged}
                onChange={() => toggleFlag(RISK_MANAGED_STORAGE_KEY, setRiskManaged)}
              />
              <span className="chart-trend-lock-text">Risk managed</span>
              {account && (
                <span className="chart-risk-per-trade" title="Max loss budgeted per trade (segment account)">
                  Risk/Trade{" "}
                  <b>
                    {/* capital_per_trade is rupee-denominated for every segment,
                        including CRYPTO - see execution's AccountsPage fix - so
                        this is always ₹, never the segment-native "$". */}
                    &#8377;{fmtMoney((account.capital_per_trade * account.risk_per_trade_pct) / 100)} · {account.risk_per_trade_pct}%
                  </b>
                </span>
              )}
            </label>
            {/* Informational only, never a gate (see the "Trend only" removal
                above) - a nudge when the chart's own interval isn't the
                declared default (or its paired higher TF) for this segment.
                Feeds the Discipline score's "Timeframe consistency"
                component regardless of whether you switch back or not. */}
            {account?.default_interval &&
              trendInfo.interval !== account.default_interval &&
              trendInfo.interval !== account.default_higher_interval && (
                <span
                  className="chart-tf-off-default"
                  title={`Your default for ${active.segment} is ${account.default_interval}${account.default_higher_interval ? `/${account.default_higher_interval}` : ""} - set on the Money tab.`}
                >
                  off default ({account.default_interval}
                  {account.default_higher_interval ? `/${account.default_higher_interval}` : ""})
                </span>
              )}
          </div>

          <ChartTradePanel
            key={`ctp:${active.segment}:${active.symbol}`}
            segment={active.segment}
            symbol={active.symbol}
            account={account}
            intervalTrend={trend}
            regime={chartContext.regime}
            oiBias={chartContext.oiBias}
            chartInterval={interval}
            riskManaged={riskManaged}
            chartLtp={chartLtp}
            pendingOrder={activePending}
            pendingNote={pendingNote[active.symbol] ?? null}
            onArmPending={armPending}
            onCancelPending={cancelPending}
            pickField={pickField}
            onPickField={setPickField}
            pickedPrice={pickedPrice}
            onOpenTradeChange={setOpenTrade}
          />
        </div>
      </div>
    </div>
  );
}
