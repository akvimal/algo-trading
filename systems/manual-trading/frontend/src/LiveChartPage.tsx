import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  type Account,
  type ManualOptionGroup,
  type ManualPosition,
  type Segment,
  type UnderlyingSentiment,
  fetchAccounts,
  fetchExecPositions,
  fetchOptionGroups,
  fetchSentiment,
  updateOptionGroupTags,
  updatePositionTags,
} from "./api";
import AutoTradePanel from "./AutoTradePanel";
import ChartTradePanel from "./ChartTradePanel";
import { type DisciplineTrade, computeDisciplineScore, disciplineColor } from "./discipline";
import { type ChartContext, type IntervalTrend, type PricePickField, LiveChartPanel } from "./LiveChartPanel";
import { type PendingOrder, fetchUnderlyingLtp, fmt, fmtMoney, placeManualOrder, pendingTriggerCrossed } from "./manualOrder";
import InfoTabsRow from "./InfoTabsRow";

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
// Whether the right-hand trade panel (ChartTradePanel + AutoTradePanel) is
// shown - a user who just wants the chart + OI strip + news, with no order
// entry in view, can collapse it. Persisted per-browser like the other
// storedFlag/toggleFlag toggles here; the panel itself stays mounted while
// collapsed (only hidden via CSS) so its own polling/local state (armed
// pending order, open-trade tracking) isn't lost by a remount.
const TRADE_PANEL_STORAGE_KEY = "manualLiveChartTradePanelVisible";

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

// How often the symbol tab bar re-checks OI sentiment - same cadence as
// the shell's old global bar (moved here 2026-09-21, see the tab bar's
// own comment below): each tick is a real Dhan/Delta option-chain fetch
// per watchlist symbol server-side, no reason to poll more often than the
// data itself actually refreshes.
const SENTIMENT_POLL_MS = 5 * 60_000;

// Mirrors SentimentBadges.tsx/the old shell bar's own levelGlyph() - ▲/▼
// repeated 1-3x for mild/strong/very_strong. Neutral and errored reads
// return null (render nothing) rather than a "•"/"?" placeholder - unlike
// that global bar, this glyph sits right on the instrument it's about, so
// a glyph on every tab all the time would out-clutter the open-trade dot/
// pending-order hourglass already living there for no real benefit; only
// an actual directional read earns the space.
function sentimentGlyph(u: UnderlyingSentiment): string | null {
  if (u.error || u.direction === "neutral" || !u.strength) return null;
  const count = u.strength === "very_strong" ? 3 : u.strength === "strong" ? 2 : 1;
  return (u.direction === "bullish" ? "▲" : "▼").repeat(count);
}

const SENTIMENT_STRENGTH_LABEL: Record<string, string> = { mild: "Mild", strong: "Strong", very_strong: "Very Strong" };

function sentimentTitle(u: UnderlyingSentiment): string {
  const strengthLabel = u.strength ? SENTIMENT_STRENGTH_LABEL[u.strength] : null;
  const label = u.direction === "neutral" || !strengthLabel ? "Neutral" : `${u.direction === "bullish" ? "Bullish" : "Bearish"} (${strengthLabel})`;
  return `OI sentiment: ${label}`;
}

// How often the tab bar's discipline badge re-checks the score - a slow
// poll like ACTIVE_TRADE_POLL_MS above, not the fast pending-order loop -
// the underlying trades change roughly at the pace you close positions.
const DISCIPLINE_POLL_MS = 60_000;
const DISCIPLINE_WINDOW_DAYS = 30;

// Moved here 2026-09-21 from the shell's own global header badge - reuses
// discipline.ts's computeDisciplineScore/disciplineColor directly (this
// page, unlike the shell, IS part of the same React app, so no need for
// the shell's vanilla-JS duplicate of the formula). Only the trade-
// fetch+mapping is repeated, same as DisciplinePage.tsx's own copy.
async function fetchDisciplineTrades(): Promise<DisciplineTrade[]> {
  const [positions, groups] = await Promise.all([
    fetchExecPositions({ status: "CLOSED", manualOnly: true, limit: 1000 }),
    fetchOptionGroups({ status: "CLOSED", manualOnly: true, limit: 1000 }),
  ]);
  const reviewed = (reviewedAt: string | null, notes: string | null) =>
    reviewedAt != null || (notes != null && notes.trim().length > 0);
  const fromPositions: DisciplineTrade[] = positions
    .filter((p) => p.option_group_id == null && p.exit_time != null)
    .map((p) => ({
      segment: p.segment,
      pnl: p.pnl,
      entry_price: p.entry_price,
      stop_loss_price: p.stop_loss_price,
      target_price: p.target_price,
      quantity: p.quantity,
      exit_time: p.exit_time!,
      exit_reason: p.exit_reason,
      order_type: p.order_type,
      entry_setup_tag: p.entry_setup_tag,
      entry_confidence: p.entry_confidence,
      setup_tag: p.setup_tag,
      confidence: p.confidence,
      reviewed: reviewed(p.reviewed_at, p.notes),
      auto_traded: p.auto_traded,
    }));
  const fromGroups: DisciplineTrade[] = groups
    .filter((g) => g.exit_time != null)
    .map((g) => ({
      segment: g.segment,
      pnl: g.pnl,
      entry_price: null,
      stop_loss_price: g.spot_stop_loss_price,
      target_price: g.spot_target_price,
      quantity: g.quantity,
      exit_time: g.exit_time!,
      exit_reason: g.exit_reason,
      order_type: g.order_type,
      entry_setup_tag: g.entry_setup_tag,
      entry_confidence: g.entry_confidence,
      setup_tag: g.setup_tag,
      confidence: g.confidence,
      reviewed: reviewed(g.reviewed_at, g.notes),
      auto_traded: g.auto_traded,
    }));
  return [...fromPositions, ...fromGroups];
}

const SYMBOLS: { symbol: string; segment: Segment }[] = [
  { symbol: "NIFTY", segment: "NSE" },
  { symbol: "BANKNIFTY", segment: "NSE" },
  { symbol: "GOLDM", segment: "MCX" },
  { symbol: "CRUDEOILM", segment: "MCX" },
  { symbol: "BTCUSD", segment: "CRYPTO" },
  { symbol: "ETHUSD", segment: "CRYPTO" },
  { symbol: "SOLUSD", segment: "CRYPTO" },
];

// A symbol outside the fixed desk list - typed into "Other symbol" below,
// or arrived at via a ?symbol= deep link the fixed list doesn't cover
// (e.g. weekly_advisor's "Open chart" link for an arbitrary F&O stock).
// Always NSE - every caller of this (weekly_advisor, the OI page's own
// deep link) only ever names individual NSE equities/indices, never MCX/
// CRYPTO, which stay reachable solely through the fixed tabs. Everything
// downstream (LiveChartPanel, ChartTradePanel, drawing persistence via
// overlayStorageKey) is already keyed by plain {segment, symbol} strings,
// not by membership in SYMBOLS, so this needs no changes below the page
// level - it really is just the tab bar/storedSymbol lookup that was
// fixed-list-only.
type SymbolEntry = { symbol: string; segment: Segment };

function isCustomSymbol(entry: SymbolEntry): boolean {
  return !SYMBOLS.some((s) => s.symbol === entry.symbol && s.segment === entry.segment);
}

function storedSymbol(): SymbolEntry {
  // Deep link (?symbol=NIFTY, or now any NSE symbol) - the shell reloads
  // this iframe at that URL when the "Intraday Chart" link on the OI page
  // is clicked (same mechanism as ?tab=oi&symbol=), or weekly_advisor's
  // own "Open chart" link. Wins over the remembered symbol. A value not in
  // the fixed list is treated as an ad-hoc NSE symbol rather than silently
  // falling back - see the SymbolEntry comment above.
  const requested = new URLSearchParams(window.location.search).get("symbol");
  if (requested) {
    const upper = requested.toUpperCase();
    return SYMBOLS.find((s) => s.symbol === upper) ?? { symbol: upper, segment: "NSE" };
  }
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
  const [active, setActive] = useState<SymbolEntry>(storedSymbol);
  const [customSymbolInput, setCustomSymbolInput] = useState("");
  // The chart-interval structure trend, lifted from LiveChartPanel so the
  // trade panel can lock direction to it.
  const [trendInfo, setTrendInfo] = useState<IntervalTrend>({ trend: null, interval: "5min" });
  const [riskManaged, setRiskManaged] = useState<boolean>(() => storedFlag(RISK_MANAGED_STORAGE_KEY));
  const [tradePanelVisible, setTradePanelVisible] = useState<boolean>(() => storedFlag(TRADE_PANEL_STORAGE_KEY));
  // Mirrors AutoTradePanel's own (server-side) armed status for the
  // active symbol, purely for ChartTradePanel/SetupCardRow's display -
  // AutoTradePanel owns the actual arm/disarm logic and config now, this
  // is a read-only echo via its onArmedChange callback.
  const [autoTradeOn, setAutoTradeOn] = useState(false);
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

  // Setup tag, driven by the full-width SetupCardRow below the chart.
  // While flat it's the tag the next order (manual OR auto-trade) carries;
  // while a trade is open, selecting a card PUTs it onto that trade.
  // Controlled prop into ChartTradePanel (its own Setup dropdown mirrors it).
  const [chartSetup, setChartSetup] = useState<string>("");
  const [setupBusy, setSetupBusy] = useState(false);
  const openPos = openTrade?.pos ?? null;
  const openGroup = openTrade?.group ?? null;
  const openSetup = openGroup?.setup_tag ?? openPos?.setup_tag ?? "";

  const onSelectSetup = useCallback(
    async (tag: string) => {
      if (openGroup || openPos) {
        setSetupBusy(true);
        // Optimistic: patch just setup_tag locally so the card highlights
        // immediately. The API returns a row without live P&L, so don't
        // swap the whole object in - the panel's 5s poll re-syncs it.
        setOpenTrade((t) =>
          t
            ? t.group
              ? { ...t, group: { ...t.group, setup_tag: tag || null } }
              : t.pos
                ? { ...t, pos: { ...t.pos, setup_tag: tag || null } }
                : t
            : t,
        );
        try {
          if (openGroup) await updateOptionGroupTags(openGroup.id, { setup_tag: tag });
          else if (openPos) await updatePositionTags(openPos.id, { setup_tag: tag });
        } catch {
          /* transient - the panel's own poll re-syncs the tag anyway */
        } finally {
          setSetupBusy(false);
        }
        return;
      }
      setChartSetup(tag);
    },
    [openGroup, openPos],
  );

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

  // Per-tab OI-sentiment glyph (see sentimentGlyph above) - moved here
  // 2026-09-21 from the shell's own global header bar, so it reads next
  // to the instrument it's actually about. Not every SYMBOLS entry has a
  // read (SOLUSD isn't on market-data's sentiment watchlist) - those tabs
  // just render no glyph.
  const [sentimentBySymbol, setSentimentBySymbol] = useState<Map<string, UnderlyingSentiment>>(new Map());
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const data = await fetchSentiment();
        if (cancelled) return;
        const next = new Map<string, UnderlyingSentiment>();
        for (const entry of Object.values(data.exchanges)) {
          for (const u of entry.underlyings) next.set(u.symbol, u);
        }
        setSentimentBySymbol(next);
      } catch {
        // transient - keep the last known reads, retried next tick
      }
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), SENTIMENT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Discipline score badge, right-aligned at the end of the tab bar -
  // moved here 2026-09-21 from the shell's own global header (next to the
  // username), same reasoning as the sentiment glyphs above: it's about
  // trading habits on exactly the trades this page places, so it reads
  // better in context here than as an always-on badge on every shell tab.
  const [disciplineScore, setDisciplineScore] = useState<number | null | undefined>(undefined); // undefined = not loaded yet
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const trades = await fetchDisciplineTrades();
        if (cancelled) return;
        setDisciplineScore(computeDisciplineScore(trades, [], DISCIPLINE_WINDOW_DAYS).score);
      } catch {
        // transient - keep the last known score, retried next tick
      }
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), DISCIPLINE_POLL_MS);
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

  function pick(entry: SymbolEntry) {
    if (entry.symbol === active.symbol) return;
    // Auto-trade is now server-side, per (segment, symbol) - switching the
    // chart's own symbol tab no longer disarms anything; AutoTradePanel
    // just shows/arms whichever Strategy belongs to the newly-active
    // symbol, independent of any other symbol's own armed Strategy. Reset
    // the mirrored display flag though, so it doesn't show the PREVIOUS
    // symbol's armed status for an instant before the new symbol's own
    // status loads.
    setAutoTradeOn(false);
    // A custom (non-fixed) symbol is deliberately NOT remembered as the
    // page's default - it's a one-off deep-link/lookup, not a desk switch.
    // Reloading the page without ?symbol= should return to the fixed desk.
    if (!isCustomSymbol(entry)) localStorage.setItem(SYMBOL_STORAGE_KEY, entry.symbol);
    setActive(entry);
    setTrendInfo({ trend: null, interval: "5min" });
    setChartLtp(null);
    setChartContext({ regime: null, oiBias: null });
    // A price picked / armed for one symbol must not leak into another.
    setPickField(null);
    setPickedPrice(null);
    setOpenTrade(null);
    setChartSetup("");
  }

  function goToCustomSymbol(e: FormEvent) {
    e.preventDefault();
    const symbol = customSymbolInput.trim().toUpperCase();
    if (!symbol) return;
    pick({ symbol, segment: "NSE" });
    setCustomSymbolInput("");
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
        {SYMBOLS.map((s) => {
          const sent = sentimentBySymbol.get(s.symbol);
          const glyph = sent ? sentimentGlyph(sent) : null;
          return (
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
              {glyph && sent && (
                <span className={`live-chart-symbol-sentiment ${sent.direction}`} title={sentimentTitle(sent)}>
                  {glyph}
                </span>
              )}
            </button>
          );
        })}
        {isCustomSymbol(active) && (
          <button className="active" onClick={() => pick(active)}>
            {active.symbol}
          </button>
        )}
        <form className="live-chart-custom-symbol" onSubmit={goToCustomSymbol}>
          <input
            value={customSymbolInput}
            onChange={(e) => setCustomSymbolInput(e.target.value)}
            placeholder="Other NSE symbol"
            title="Any NSE symbol not on the desk above (e.g. an individual F&O stock) - opens here as a one-off, not added to the desk. Drawings still save per-symbol."
          />
        </form>
        <button
          type="button"
          className="live-chart-panel-toggle"
          title={tradePanelVisible ? "Collapse the trade panel - chart-only view" : "Show the trade panel"}
          onClick={() => toggleFlag(TRADE_PANEL_STORAGE_KEY, setTradePanelVisible)}
        >
          {tradePanelVisible ? "Hide panel ▸" : "◂ Show panel"}
        </button>
        {disciplineScore !== undefined && (
          <button
            type="button"
            className={`live-chart-discipline-badge is-${disciplineColor(disciplineScore)}`}
            title="Discipline score - click to see the full breakdown"
            onClick={() => window.parent.postMessage({ source: "algo-trading-app", type: "navigate-discipline" }, "*")}
          >
            Discipline {disciplineScore ?? "—"}
          </button>
        )}
      </nav>

      <div className={`live-chart-layout${tradePanelVisible ? "" : " is-trade-panel-collapsed"}`}>
        <LiveChartPanel
          key={`${active.segment}:${active.symbol}`}
          segment={active.segment}
          symbol={active.symbol}
          defaultInterval={isCustomSymbol(active) ? "daily" : undefined}
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
            autoTradeActive={autoTradeOn}
            setupTag={chartSetup}
            onSetupTagChange={setChartSetup}
            setupCardSelected={openPos || openGroup ? openSetup : chartSetup}
            onSelectSetupCard={onSelectSetup}
            setupCardContext={openPos || openGroup ? "open" : autoTradeOn ? "auto" : "entry"}
            setupCardBusy={setupBusy}
            pendingOrder={activePending}
            pendingNote={pendingNote[active.symbol] ?? null}
            onArmPending={armPending}
            onCancelPending={cancelPending}
            pickField={pickField}
            onPickField={setPickField}
            pickedPrice={pickedPrice}
            onOpenTradeChange={setOpenTrade}
            headerExtra={
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
                        &#8377;{fmtMoney((account.capital_per_trade * account.risk_per_trade_pct) / 100)} ·{" "}
                        {account.risk_per_trade_pct}%
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

                <AutoTradePanel segment={active.segment} symbol={active.symbol} onArmedChange={setAutoTradeOn} />
              </div>
            }
          />
        </div>
      </div>

      <InfoTabsRow segment={active.segment} symbol={active.symbol} />
    </div>
  );
}
