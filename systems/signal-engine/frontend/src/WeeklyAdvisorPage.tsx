import { Fragment, useEffect, useState } from "react";

import {
  checkWeeklyAdvisorMargin,
  closeWeeklyAdvisorTrade,
  createWatchlist,
  createWeeklyAdvisorTrade,
  fetchWatchlists,
  fetchWeeklyAdvisorHistory,
  fetchWeeklyAdvisorPerformance,
  fetchWeeklyAdvisorRecommendations,
  fetchWeeklyAdvisorSettings,
  fetchWeeklyAdvisorTrades,
  saveWeeklyAdvisorRecommendation,
  screenerScreenshotUrl,
  setWeeklyAdvisorDecision,
  updateWatchlist,
  updateWeeklyAdvisorSettings,
  updateWeeklyAdvisorTradeEntry,
  weeklyAdvisorUnrealizedPnl,
  type SavedWeeklyRecommendation,
  type Watchlist,
  type WeeklyAdvisorDecision,
  type WeeklyAdvisorPerformanceSummary,
  type WeeklyAdvisorSignal,
  type WeeklyAdvisorSignalCategory,
  type WeeklyAdvisorSkipped,
  type WeeklyAdvisorTrade,
  type WeeklyAdvisorTradeLeg,
  type WeeklyAdvisorTradeStatus,
  type WeeklyRecommendation,
} from "./api";
import { manualTradingChartUrl, manualTradingOiUrl } from "./links";

// A batch run chunks the symbol list into requests of this size rather
// than one giant call - the backend already runs up to 5 symbols
// concurrently per request (see weekly_advisor.py's _BATCH_CONCURRENCY),
// but the ~200-symbol F&O universe would still be a single multi-minute
// request with no feedback and real risk of a stalled-looking UI. Chunks
// of 20 give ~10 progress updates for a 200-symbol run and keep each
// individual request to roughly 20/5 * ~3s (worst case, cold cache) = ~12s.
const RUN_CHUNK_SIZE = 20;

// On-demand only (no polling, unlike every other tab here) - this is a
// weekly-cadence read against live NSE OHLCV, not a live feed, and each
// call re-fetches long-history candles + an option chain per symbol, too
// expensive to poll on a timer. See app/domain/weekly_advisor/pipeline.py's
// docstring for what's explicitly NOT built yet (AI memo, scheduler, Redis
// publish) - this tab is a real, on-demand read of the same deterministic
// engine, plus explicit save/journal/performance below.
const DEFAULT_SYMBOLS = "RELIANCE,TCS,HDFCBANK,ABB,TATASTEEL";

type SubTab = "run" | "history" | "performance" | "settings";

const BIAS_BADGE: Record<WeeklyRecommendation["regime"]["bias"], string> = {
  bullish: "badge-buy",
  bearish: "badge-sell",
  neutral: "badge-mini-muted",
};

// Fixed reading order for the technical-signal groups below (fundamentals
// gets its own separate card section, same as before this grouping was
// added - excluded here, see technicalSignals in RecommendationCard).
const SIGNAL_CATEGORY_ORDER: WeeklyAdvisorSignalCategory[] = ["trend", "structure", "order_blocks", "oi", "momentum"];
const SIGNAL_CATEGORY_LABEL: Record<WeeklyAdvisorSignalCategory, string> = {
  trend: "Trend",
  structure: "Price structure",
  order_blocks: "Order blocks",
  oi: "Open interest",
  momentum: "Momentum",
  fundamentals: "Fundamentals",
};

// ▲/▼/– rather than a plain bullet - direction is exactly the thing this
// list previously made you read every sentence to find out.
function SignalIndicator({ direction }: { direction: WeeklyAdvisorSignal["direction"] }) {
  if (direction === "bullish") return <span className="weekly-advisor-signal-dot bullish">▲</span>;
  if (direction === "bearish") return <span className="weekly-advisor-signal-dot bearish">▼</span>;
  return <span className="weekly-advisor-signal-dot neutral">–</span>;
}

const BASE_ACTION_LABELS: Record<WeeklyRecommendation["strategy"]["action"], string> = {
  sell_otm_put: "Sell OTM Put",
  sell_otm_call: "Sell OTM Call",
  short_strangle: "Short Strangle",
  iron_condor: "Iron Condor",
  avoid_new_entry: "Avoid new entry",
  close_existing: "Close existing",
};

// sell_otm_put/sell_otm_call with more than one leg means select_strategy's
// own defined_risk=True default (the only mode pipeline.py ever calls it
// in - it never passes defined_risk=False) added a protective further-OTM
// wing, which makes this structurally a bull put / bear call spread, not
// a naked single-leg sale - but the engine's own StrategyAction enum has
// no separate value for that shape (see docs/architecture.md's Weekly
// Advisor writeup, "strikes anchored to order blocks" issue's Finding 1).
// Label from the actual leg count rather than the bare action string, so
// what's shown matches what's actually being recommended - avoids a
// contract/schema change (the action string itself is unchanged) while
// fixing the misleading display.
function actionLabel(action: WeeklyRecommendation["strategy"]["action"], legCount: number): string {
  if (action === "sell_otm_put" && legCount > 1) return "Bull Put Spread";
  if (action === "sell_otm_call" && legCount > 1) return "Bear Call Spread";
  return BASE_ACTION_LABELS[action];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const DECISION_LABELS: Record<WeeklyAdvisorDecision, string> = { execute: "Execute", hold: "Hold", drop: "Drop" };
const DECISION_BADGE: Record<WeeklyAdvisorDecision, string> = { execute: "badge-mini-buy", hold: "badge-mini-muted", drop: "badge-mini-sell" };

// One form for the whole "did you act on this" review: the decision
// itself (execute/hold/drop + confidence + comments), and - the first
// time you pick "execute" for a recommendation - the trade-journal
// capture in the SAME submit (bias/strategy/economics/notes), instead of
// a separate "Mark as taken" step you had to remember to click after.
// Deliberately a manual journal entry, not a real execution-opened
// position - every weekly_advisor strategy is net-short-premium, which
// execution's option P&L/sizing math can't price yet (see
// app/domain/weekly_advisor/journal.py's module docstring). Once a trade
// already exists for this recommendation (`alreadyTaken`), re-opening
// this form (e.g. to bump confidence or edit comments) drops back to the
// simple decision-only fields - further trade edits happen via the
// Performance tab's own Close flow instead.
const BIAS_OPTIONS: WeeklyRecommendation["regime"]["bias"][] = ["bullish", "bearish", "neutral"];

// The full named option-strategy universe for each bias (matching a
// standard options-analytics platform's own Bullish/Bearish/Neutral
// strategy library, e.g. Sensibull) - `actual_strategy` on the trade
// journal is free text (see journal.py's TradeCreate docstring: "what
// someone actually traded can be a shape this engine doesn't model at
// all"), so the dropdown isn't limited to the 4 actions this engine's own
// strategy_selector.py can recommend.
const OPTION_STRATEGIES_BY_BIAS: Record<WeeklyRecommendation["regime"]["bias"], string[]> = {
  bullish: [
    "Buy Call",
    "Sell Put",
    "Bull Call Spread",
    "Bull Put Spread",
    "Call Ratio Back Spread",
    "Long Calendar with Calls",
    "Bull Condor",
    "Bull Butterfly",
    "Range Forward",
    "Long Synthetic Future",
  ],
  bearish: [
    "Buy Put",
    "Sell Call",
    "Bear Call Spread",
    "Bear Put Spread",
    "Put Ratio Back Spread",
    "Long Calendar with Puts",
    "Bear Condor",
    "Bear Butterfly",
    "Risk Reversal",
    "Short Synthetic Future",
  ],
  neutral: ["Short Straddle", "Iron Butterfly", "Short Strangle", "Short Iron Condor", "Batman", "Double Plateau", "Jade Lizard", "Reverse Jade Lizard"],
};

// This engine's own 4 recommendable actions, mapped to their equivalent
// named strategy above - used only to mark that entry "(recommended)" and
// to default the dropdown's initial selection; every other entry in
// OPTION_STRATEGIES_BY_BIAS is still freely selectable regardless.
// sell_otm_put/sell_otm_call resolve to the spread name rather than the
// naked-sell name once a wing leg is actually present (legCount > 1) -
// same leg-count-aware logic as actionLabel above, and "Bull Put Spread"/
// "Bear Call Spread" are already real entries in OPTION_STRATEGIES_BY_BIAS,
// so this was previously defaulting the dropdown to the WRONG entry
// whenever defined_risk's wing leg was present (which is always, today).
function recommendedStrategyLabel(action: WeeklyRecommendation["strategy"]["action"], legCount: number): string | undefined {
  if (action === "sell_otm_put") return legCount > 1 ? "Bull Put Spread" : "Sell Put";
  if (action === "sell_otm_call") return legCount > 1 ? "Bear Call Spread" : "Sell Call";
  if (action === "short_strangle") return "Short Strangle";
  if (action === "iron_condor") return "Short Iron Condor";
  return undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Suggested starting values for the decision-log form's fill-price/credit/
// max-profit/max-loss fields, from each leg's own premium_estimate - the
// SAME option-chain fetch pipeline.py's strategy_selector already used to
// pick these strikes, just never threaded through to this form before now
// (see contracts.py's StrategyLeg.premium_estimate docstring). Every value
// here is a plain suggested default, never locked - the caller still wires
// these into ordinary editable useState initializers, same as
// actualBias/actualStrategy/targetPct already are.
//
// Deliberately does NOT attempt funds_needed/margin_needed (broker-
// specific) or pop (needs a live-Greeks model) - both stay "from broker" /
// blank, same as before this change; see docs/architecture.md's Weekly
// Advisor writeup for why.
function estimateTradeEconomics(legs: WeeklyRecommendation["strategy"]["legs"]): {
  legEntryPrices: string[];
  entryCredit: string;
  maxProfit: string;
  maxLoss: string;
} {
  const legEntryPrices = legs.map((leg) => (leg.premium_estimate != null ? String(leg.premium_estimate) : ""));
  if (legs.length === 0 || legs.some((leg) => leg.premium_estimate == null)) {
    // Any missing premium (a chain miss, or an avoid_new_entry/close_existing
    // recommendation with no legs at all) makes credit/max-profit/max-loss
    // unreliable to guess at from a partial set - leave them blank rather
    // than compute off incomplete data.
    return { legEntryPrices, entryCredit: "", maxProfit: "", maxLoss: "" };
  }
  const netCredit = legs.reduce((sum, leg) => sum + (leg.side === "sell" ? 1 : -1) * (leg.premium_estimate ?? 0), 0);

  // Strike width of one side's defined-risk spread (sell + protective buy
  // on the same option_type) - null when that side has no wing at all
  // (an undefined-risk naked leg, which max loss can't be computed for).
  function widthOf(optionType: "PE" | "CE"): number | null {
    const sell = legs.find((l) => l.option_type === optionType && l.side === "sell");
    const buy = legs.find((l) => l.option_type === optionType && l.side === "buy");
    return sell && buy ? Math.abs(sell.strike - buy.strike) : null;
  }
  const widths = [widthOf("PE"), widthOf("CE")].filter((w): w is number => w != null);
  if (widths.length === 0) {
    // No wing on either side - max loss is genuinely unbounded (a naked
    // short), don't pretend to compute one. Credit is still meaningful.
    return { legEntryPrices, entryCredit: String(round2(netCredit)), maxProfit: "", maxLoss: "" };
  }
  // An iron condor's max loss is bounded by whichever side actually gets
  // tested at expiry - the wider of the two sides, not their sum (only one
  // side can be breached).
  const width = Math.max(...widths);
  return {
    legEntryPrices,
    entryCredit: String(round2(netCredit)),
    maxProfit: String(round2(netCredit)),
    maxLoss: String(round2(width - netCredit)),
  };
}

function DecisionForm({
  rec,
  recommendationId,
  alreadyTaken,
  existingDecision,
  existingConfidence,
  existingComments,
  existingTrade,
  onDone,
  onTradeUpdated,
  onCancel,
}: {
  rec: WeeklyRecommendation;
  recommendationId: string;
  alreadyTaken: boolean;
  // The decision already logged for this recommendation, if any - so
  // reopening this form (the "Change decision" path) starts from what was
  // actually saved last time instead of silently resetting to the
  // execute/3/blank defaults.
  existingDecision: WeeklyAdvisorDecision | null;
  existingConfidence: number | null;
  existingComments: string | null;
  // The trade already journaled for this recommendation, if any - shown
  // with an "Edit trade" toggle (EditTradeForm below) so a trade planned
  // off-session with provisional numbers can be corrected once the legs
  // actually fill, without re-creating it.
  existingTrade: WeeklyAdvisorTrade | null;
  onDone: (row: SavedWeeklyRecommendation, trade: WeeklyAdvisorTrade | null) => void;
  onTradeUpdated: (trade: WeeklyAdvisorTrade) => void;
  onCancel: () => void;
}) {
  const [decision, setDecision] = useState<WeeklyAdvisorDecision>(existingDecision ?? "execute");
  const [confidence, setConfidence] = useState(existingConfidence != null ? String(existingConfidence) : "3");
  const [comments, setComments] = useState(existingComments ?? "");
  // Trade-journal fields - only captured (and only shown) the first time
  // "execute" is picked for this recommendation; see alreadyTaken above.
  // Seeded from estimateTradeEconomics (each leg's own premium_estimate,
  // from the same option-chain fetch that picked these strikes) rather
  // than blank - a suggested starting value, always freely editable, never
  // a substitute for the real fill once the trade is actually placed.
  const [economics] = useState(() => estimateTradeEconomics(rec.strategy.legs));
  const [quantity, setQuantity] = useState("");
  const [entryCredit, setEntryCredit] = useState(economics.entryCredit);
  const [fundsNeeded, setFundsNeeded] = useState("");
  const [marginNeeded, setMarginNeeded] = useState("");
  const [pop, setPop] = useState("");
  const [maxProfit, setMaxProfit] = useState(economics.maxProfit);
  const [maxLoss, setMaxLoss] = useState(economics.maxLoss);
  // Per-leg fill price at entry time - same fields EditTradeForm lets you
  // correct later, but captured up front too now, since a trade is often
  // journaled the moment it's actually filled (not always off-session).
  const [legEntryPrices, setLegEntryPrices] = useState<string[]>(economics.legEntryPrices);
  // The close-out thresholds to watch this position against. Target
  // defaults from the recommendation's own exit rule (already shown as
  // descriptive text on every card, e.g. "Exit at 65% of max profit") -
  // stop-loss has no engine default at all, it's set by the trader.
  const [targetPct, setTargetPct] = useState(() => String(Math.round(rec.strategy.exit_rule.target_pct_of_max_profit * 100)));
  const [stopLossPct, setStopLossPct] = useState("");
  // "Check margin" - a real Dhan margin-calculator lookup (market-data's
  // DhanProvider.get_combo_margin, confirmed live 2026-09-22), separate
  // from the pure-arithmetic economics above since it needs a real
  // quantity first (margin scales with it) and a real network call, not
  // something to fire automatically on every keystroke. Every leg needs a
  // security_id to check margin at all - missing on any leg (e.g. a chain
  // miss that cycle) disables the button rather than sending a partial,
  // guaranteed-to-fail request.
  const canCheckMargin = rec.strategy.legs.length > 0 && rec.strategy.legs.every((leg) => leg.security_id != null);
  const [marginChecking, setMarginChecking] = useState(false);
  const [marginResult, setMarginResult] = useState<Record<string, number | string> | null>(null);
  const [marginError, setMarginError] = useState<string | null>(null);

  async function handleCheckMargin() {
    setMarginChecking(true);
    setMarginError(null);
    setMarginResult(null);
    try {
      const legs = rec.strategy.legs.map((leg, i) => ({
        security_id: leg.security_id as string,
        side: leg.side,
        price: legEntryPrices[i] ? Number(legEntryPrices[i]) : (leg.premium_estimate ?? 0),
      }));
      const { raw } = await checkWeeklyAdvisorMargin(legs, Number(quantity));
      setMarginResult(raw);
      const total = raw.totalMargin;
      if (typeof total === "number") setMarginNeeded(String(total));
    } catch (err) {
      setMarginError(err instanceof Error ? err.message : "Could not get a margin estimate");
    } finally {
      setMarginChecking(false);
    }
  }
  // Pre-filled from the recommendation, but freely editable - what you
  // actually traded is often not exactly what the system recommended.
  const [actualBias, setActualBias] = useState<WeeklyRecommendation["regime"]["bias"]>(rec.regime.bias);
  const [actualStrategy, setActualStrategy] = useState<string>(() => {
    const recommendedLabel = recommendedStrategyLabel(rec.strategy.action, rec.strategy.legs.length);
    return recommendedLabel && OPTION_STRATEGIES_BY_BIAS[rec.regime.bias].includes(recommendedLabel)
      ? recommendedLabel
      : OPTION_STRATEGIES_BY_BIAS[rec.regime.bias][0];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTrade, setEditingTrade] = useState(false);

  function handleBiasChange(bias: WeeklyRecommendation["regime"]["bias"]) {
    setActualBias(bias);
    // Re-align the strategy dropdown to the newly picked bias - keep the
    // current selection if it's still a valid option there, otherwise
    // fall back to that bias's default.
    setActualStrategy((prev) => (OPTION_STRATEGIES_BY_BIAS[bias].includes(prev) ? prev : OPTION_STRATEGIES_BY_BIAS[bias][0]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const row = await setWeeklyAdvisorDecision(recommendationId, {
        decision,
        confidence: decision === "execute" ? Number(confidence) : undefined,
        comments: comments || undefined,
      });
      let trade: WeeklyAdvisorTrade | null = null;
      if (decision === "execute" && !alreadyTaken) {
        const legs: WeeklyAdvisorTradeLeg[] | undefined =
          rec.strategy.legs.length > 0
            ? rec.strategy.legs.map((leg, i) => ({
                option_type: leg.option_type,
                strike: leg.strike,
                side: leg.side,
                quantity: quantity ? Number(quantity) : null,
                entry_price: legEntryPrices[i] ? Number(legEntryPrices[i]) : null,
                // Carried over from the recommendation's own StrategyLeg so
                // the scheduled leg-price refresh job can look this leg up
                // later - current_price starts unset, written by that job.
                security_id: leg.security_id,
                current_price: null,
              }))
            : undefined;
        trade = await createWeeklyAdvisorTrade(recommendationId, {
          quantity: quantity ? Number(quantity) : undefined,
          entry_credit: entryCredit ? Number(entryCredit) : undefined,
          funds_needed: fundsNeeded ? Number(fundsNeeded) : undefined,
          margin_needed: marginNeeded ? Number(marginNeeded) : undefined,
          pop: pop ? Number(pop) : undefined,
          max_profit: maxProfit ? Number(maxProfit) : undefined,
          max_loss: maxLoss ? Number(maxLoss) : undefined,
          actual_bias: actualBias,
          actual_strategy: actualStrategy,
          legs,
          entry_notes: comments || undefined,
          target_pct_of_max_profit: targetPct ? Number(targetPct) : undefined,
          stop_loss_pct_of_max_loss: stopLossPct ? Number(stopLossPct) : undefined,
        });
      }
      onDone(row, trade);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const capturingTrade = decision === "execute" && !alreadyTaken;

  return (
    <>
      {alreadyTaken && existingTrade && (
        <div className="weekly-advisor-trade-readonly">
          <p className="hint">
            Already marked as taken - {existingTrade.actual_bias ?? "?"} / {existingTrade.actual_strategy ?? rec.strategy.action}
            {existingTrade.quantity != null && `, qty ${existingTrade.quantity}`}
            {existingTrade.entry_credit != null && `, credit ${existingTrade.entry_credit}`}
            {!editingTrade && (
              <>
                {" "}
                <button type="button" className="secondary tiny" onClick={() => setEditingTrade(true)}>
                  Edit trade
                </button>
              </>
            )}
          </p>
          {editingTrade && (
            <EditTradeForm
              trade={existingTrade}
              onDone={(updated) => {
                setEditingTrade(false);
                onTradeUpdated(updated);
              }}
              onCancel={() => setEditingTrade(false)}
            />
          )}
        </div>
      )}
      <form className="weekly-advisor-journal-form" onSubmit={handleSubmit}>
        {error && <p className="error">{error}</p>}
        <label>
          Decision
          <select value={decision} onChange={(e) => setDecision(e.target.value as WeeklyAdvisorDecision)}>
            <option value="execute">Execute</option>
            <option value="hold">Hold</option>
            <option value="drop">Drop</option>
          </select>
        </label>
        {decision === "execute" && (
          <label>
            Confidence
            <select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {capturingTrade && (
          <>
            {rec.strategy.legs.length > 0 && (
              <div className="weekly-advisor-legs-edit">
                {economics.legEntryPrices.some((v) => v !== "") && (
                  <p className="hint">Fill prices/credit/max-profit/max-loss below are estimated from the option chain at analysis time - confirm or correct once the legs actually fill.</p>
                )}
                {rec.strategy.legs.map((leg, i) => (
                  <label key={i}>
                    {leg.side.toUpperCase()} {leg.option_type} {leg.strike} - fill price
                    <input
                      type="number"
                      step="any"
                      value={legEntryPrices[i] ?? ""}
                      onChange={(e) => setLegEntryPrices((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                      placeholder="not filled yet"
                      title={leg.premium_estimate != null ? "Pre-filled estimate as of analysis time - confirm or correct" : undefined}
                    />
                  </label>
                ))}
              </div>
            )}
            <label>
              Your bias
              <select value={actualBias} onChange={(e) => handleBiasChange(e.target.value as WeeklyRecommendation["regime"]["bias"])}>
                {BIAS_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === rec.regime.bias ? " (recommended)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Your strategy
              <select value={actualStrategy} onChange={(e) => setActualStrategy(e.target.value)} style={{ width: "14rem" }}>
                {OPTION_STRATEGIES_BY_BIAS[actualBias].map((label) => (
                  <option key={label} value={label}>
                    {label}
                    {label === recommendedStrategyLabel(rec.strategy.action, rec.strategy.legs.length) ? " (recommended)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Qty/lots
              <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
            <label>
              Credit received
              <input type="number" step="any" value={entryCredit} onChange={(e) => setEntryCredit(e.target.value)} />
            </label>
            <label>
              Funds needed
              <input type="number" step="any" value={fundsNeeded} onChange={(e) => setFundsNeeded(e.target.value)} placeholder="from broker" />
            </label>
            <label>
              Margin needed
              <span className="weekly-advisor-margin-check">
                <input type="number" step="any" value={marginNeeded} onChange={(e) => setMarginNeeded(e.target.value)} placeholder="from broker, or Check margin ->" />
                {canCheckMargin && (
                  <button
                    type="button"
                    className="secondary tiny"
                    disabled={marginChecking || !quantity || Number(quantity) <= 0}
                    onClick={handleCheckMargin}
                    title="Real Dhan margin lookup for these legs at this quantity - quantity must be a valid lot-size multiple"
                  >
                    {marginChecking ? "Checking..." : "Check margin"}
                  </button>
                )}
              </span>
              {marginError && <span className="hint error">{marginError} - check quantity is a valid lot-size multiple for this contract.</span>}
              {marginResult && typeof marginResult.totalMargin === "number" && (
                <span className="hint">Dhan: total margin ~{marginResult.totalMargin.toLocaleString()} for qty {quantity} - pre-filled above, still editable.</span>
              )}
            </label>
            <label>
              POP %
              <input type="number" min="0" max="100" step="any" value={pop} onChange={(e) => setPop(e.target.value)} />
            </label>
            <label>
              Max profit
              <input type="number" step="any" value={maxProfit} onChange={(e) => setMaxProfit(e.target.value)} />
            </label>
            <label>
              Max loss
              <input type="number" min="0" step="any" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} placeholder="positive amount, e.g. 4500" />
            </label>
            <label>
              Target % of max profit
              <input type="number" min="0" max="100" step="any" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} />
            </label>
            <label>
              Stop-loss % of max loss
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                value={stopLossPct}
                onChange={(e) => setStopLossPct(e.target.value)}
                placeholder="optional"
              />
            </label>
          </>
        )}
        <label className="weekly-advisor-notes-label">
          {capturingTrade ? "Comments / entry notes" : "Comments"}
          <textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="optional" rows={3} />
        </label>
        <button type="submit" className="secondary" disabled={saving}>
          {saving ? "Saving..." : capturingTrade ? "Log decision & mark as taken" : "Log decision"}
        </button>
        <button type="button" className="secondary tiny" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </form>
    </>
  );
}

// Overwrites a trade's provisional entry data with the real thing once the
// legs actually fill - the missing half of the off-session planning
// workflow (journal it Friday/mid-week with numbers copied from an
// options-analytics platform, then correct them Monday once the broker
// confirms real fills), see journal.py's TradeEntryUpdate docstring.
// Per-leg quantity is deliberately not editable here (every leg already
// shares the trade's own aggregate quantity by construction) - only each
// leg's own fill price, since that's the number that's actually unknown
// until it triggers.
function EditTradeForm({ trade, onDone, onCancel }: { trade: WeeklyAdvisorTrade; onDone: (trade: WeeklyAdvisorTrade) => void; onCancel: () => void }) {
  const [quantity, setQuantity] = useState(trade.quantity != null ? String(trade.quantity) : "");
  const [entryCredit, setEntryCredit] = useState(trade.entry_credit != null ? String(trade.entry_credit) : "");
  const [fundsNeeded, setFundsNeeded] = useState(trade.funds_needed != null ? String(trade.funds_needed) : "");
  const [marginNeeded, setMarginNeeded] = useState(trade.margin_needed != null ? String(trade.margin_needed) : "");
  const [pop, setPop] = useState(trade.pop != null ? String(trade.pop) : "");
  const [maxProfit, setMaxProfit] = useState(trade.max_profit != null ? String(trade.max_profit) : "");
  const [maxLoss, setMaxLoss] = useState(trade.max_loss != null ? String(trade.max_loss) : "");
  const [targetPct, setTargetPct] = useState(trade.target_pct_of_max_profit != null ? String(trade.target_pct_of_max_profit) : "");
  const [stopLossPct, setStopLossPct] = useState(trade.stop_loss_pct_of_max_loss != null ? String(trade.stop_loss_pct_of_max_loss) : "");
  const [legEntryPrices, setLegEntryPrices] = useState<string[]>((trade.legs ?? []).map((leg) => (leg.entry_price != null ? String(leg.entry_price) : "")));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const legs: WeeklyAdvisorTradeLeg[] | undefined = trade.legs
        ? trade.legs.map((leg, i) => ({ ...leg, entry_price: legEntryPrices[i] ? Number(legEntryPrices[i]) : null }))
        : undefined;
      const updated = await updateWeeklyAdvisorTradeEntry(trade.id, {
        quantity: quantity ? Number(quantity) : undefined,
        entry_credit: entryCredit ? Number(entryCredit) : undefined,
        funds_needed: fundsNeeded ? Number(fundsNeeded) : undefined,
        margin_needed: marginNeeded ? Number(marginNeeded) : undefined,
        pop: pop ? Number(pop) : undefined,
        max_profit: maxProfit ? Number(maxProfit) : undefined,
        max_loss: maxLoss ? Number(maxLoss) : undefined,
        target_pct_of_max_profit: targetPct ? Number(targetPct) : undefined,
        stop_loss_pct_of_max_loss: stopLossPct ? Number(stopLossPct) : undefined,
        legs,
      });
      onDone(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update trade");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="weekly-advisor-journal-form" onSubmit={handleSubmit}>
      {error && <p className="error">{error}</p>}
      {trade.legs && trade.legs.length > 0 && (
        <div className="weekly-advisor-legs-edit">
          {trade.legs.map((leg, i) => (
            <label key={i}>
              {leg.side.toUpperCase()} {leg.option_type} {leg.strike} - fill price
              <input
                type="number"
                step="any"
                value={legEntryPrices[i] ?? ""}
                onChange={(e) => setLegEntryPrices((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                placeholder="not filled yet"
              />
            </label>
          ))}
        </div>
      )}
      <label>
        Qty/lots
        <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>
      <label>
        Credit received
        <input type="number" step="any" value={entryCredit} onChange={(e) => setEntryCredit(e.target.value)} />
      </label>
      <label>
        Funds needed
        <input type="number" step="any" value={fundsNeeded} onChange={(e) => setFundsNeeded(e.target.value)} placeholder="from broker" />
      </label>
      <label>
        Margin needed
        <input type="number" step="any" value={marginNeeded} onChange={(e) => setMarginNeeded(e.target.value)} placeholder="from broker" />
      </label>
      <label>
        POP %
        <input type="number" min="0" max="100" step="any" value={pop} onChange={(e) => setPop(e.target.value)} />
      </label>
      <label>
        Max profit
        <input type="number" step="any" value={maxProfit} onChange={(e) => setMaxProfit(e.target.value)} />
      </label>
      <label>
        Max loss
        <input type="number" min="0" step="any" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} placeholder="positive amount, e.g. 4500" />
      </label>
      <label>
        Target % of max profit
        <input type="number" min="0" max="100" step="any" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} />
      </label>
      <label>
        Stop-loss % of max loss
        <input type="number" min="0" max="100" step="any" value={stopLossPct} onChange={(e) => setStopLossPct(e.target.value)} placeholder="optional" />
      </label>
      <button type="submit" className="secondary" disabled={saving}>
        {saving ? "Saving..." : "Save trade updates"}
      </button>
      <button type="button" className="secondary tiny" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
    </form>
  );
}

// Suggested exit_debit/realized_pnl from each leg's last-tracked
// current_price (the scheduled leg-refresh job, see WeeklyAdvisorTrade's
// own prices_updated_at) - same "sum of (sell ? +1 : -1) * price" shape
// estimateTradeEconomics uses for entry_credit, applied to current_price
// instead of premium_estimate: closing a sell leg costs its current price
// (buy it back), closing a buy leg pays its current price (sell it) - net
// debit to close is exactly that same signed sum. Blank when any leg is
// missing a current_price rather than guessing off a partial set, same
// convention as the entry-side pre-fill.
function estimateCloseOut(trade: WeeklyAdvisorTrade): { exitDebit: string; realizedPnl: string } {
  if (!trade.legs || trade.legs.length === 0 || trade.legs.some((leg) => leg.current_price == null)) {
    return { exitDebit: "", realizedPnl: "" };
  }
  const exitDebit = trade.legs.reduce((sum, leg) => sum + (leg.side === "sell" ? 1 : -1) * (leg.current_price ?? 0), 0);
  const quantity = trade.quantity ?? 1;
  const realizedPnl = trade.entry_credit != null ? (trade.entry_credit - exitDebit) * quantity : null;
  return {
    exitDebit: String(round2(exitDebit)),
    realizedPnl: realizedPnl != null ? String(round2(realizedPnl)) : "",
  };
}

function CloseTradeForm({ trade, onDone }: { trade: WeeklyAdvisorTrade; onDone: () => void }) {
  const [suggested] = useState(() => estimateCloseOut(trade));
  const [exitDebit, setExitDebit] = useState(suggested.exitDebit);
  const [realizedPnl, setRealizedPnl] = useState(suggested.realizedPnl);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await closeWeeklyAdvisorTrade(trade.id, {
        exit_debit: exitDebit ? Number(exitDebit) : undefined,
        realized_pnl: realizedPnl ? Number(realizedPnl) : undefined,
        exit_notes: notes || undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close trade");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="weekly-advisor-journal-form" onSubmit={handleSubmit}>
      {error && <p className="error">{error}</p>}
      {trade.status === "expired" && (
        <p className="hint pnl-negative">This trade's expiry has passed - review the numbers below before confirming.</p>
      )}
      {suggested.exitDebit && (
        <p className="hint">Debit/P&amp;L below are estimated from each leg's last tracked price ({trade.prices_updated_at ? formatDateTime(trade.prices_updated_at) : "unknown"}) - confirm or correct.</p>
      )}
      <label>
        Debit paid to close
        <input type="number" step="any" value={exitDebit} onChange={(e) => setExitDebit(e.target.value)} />
      </label>
      <label>
        Realized P&amp;L
        <input type="number" step="any" value={realizedPnl} onChange={(e) => setRealizedPnl(e.target.value)} required />
      </label>
      <label className="weekly-advisor-notes-label">
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" rows={3} />
      </label>
      <button type="submit" className="secondary" disabled={saving}>
        {saving ? "Closing..." : "Close trade"}
      </button>
    </form>
  );
}

// The Save/Mark-as-taken control block shown under a recommendation card
// in the Run tab - separate from RecommendationCard itself so the same
// pure display card can be reused (with no footer) in the History tab.
function SaveControl({ rec }: { rec: WeeklyRecommendation }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedWeeklyRecommendation | null>(null);
  const [showDecisionForm, setShowDecisionForm] = useState(false);
  const [trade, setTrade] = useState<WeeklyAdvisorTrade | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const row = await saveWeeklyAdvisorRecommendation(rec.symbol);
      setSaved(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div className="weekly-advisor-save-control">
        <p className="hint">Saved at {formatDateTime(saved.saved_at)}.</p>

        {saved.decision && !showDecisionForm ? (
          <p className="hint">
            Decision: <span className={`badge-mini ${DECISION_BADGE[saved.decision]}`}>{DECISION_LABELS[saved.decision]}</span>
            {saved.confidence != null && ` (confidence ${saved.confidence}/5)`}
            {saved.decision_comments && ` - ${saved.decision_comments}`}{" "}
            {trade && saved.decision === "execute" && " - marked as taken"}{" "}
            <button type="button" className="secondary tiny" onClick={() => setShowDecisionForm(true)}>
              Change
            </button>
          </p>
        ) : (
          !showDecisionForm && (
            <button type="button" className="secondary tiny" onClick={() => setShowDecisionForm(true)}>
              Log decision
            </button>
          )
        )}
        {showDecisionForm && (
          <DecisionForm
            rec={rec}
            recommendationId={saved.id}
            alreadyTaken={trade !== null}
            existingDecision={saved.decision}
            existingConfidence={saved.confidence}
            existingComments={saved.decision_comments}
            existingTrade={trade}
            onDone={(row, newTrade) => {
              setShowDecisionForm(false);
              setSaved(row);
              if (newTrade) setTrade(newTrade);
            }}
            onTradeUpdated={(updated) => setTrade(updated)}
            onCancel={() => setShowDecisionForm(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="weekly-advisor-save-control">
      {error && <p className="error">{error}</p>}
      <button type="button" className="secondary tiny" onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

// Adds one symbol to an existing (or brand-new) Watchlist - the write
// counterpart to RunTab's own Watchlist dropdown (which only reads them,
// to pick what to run against). Watchlists aren't fetched until the
// popover is actually opened (not on every card's initial render, since a
// batch run can show dozens of cards at once and most never get this
// clicked) - each card's popover keeps its own copy rather than sharing
// one across cards, same "plain, no premature shared-state abstraction"
// trade this file already makes elsewhere (e.g. DecisionForm/EditTradeForm
// not sharing state either).
function SaveToWatchlistControl({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  const [watchlists, setWatchlists] = useState<Watchlist[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && watchlists === null) {
      setLoading(true);
      setError(null);
      try {
        setWatchlists(await fetchWatchlists());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load watchlists");
      } finally {
        setLoading(false);
      }
    }
  }

  function symbolsOf(w: Watchlist): string[] {
    return w.symbols.split(",").map((s) => s.trim()).filter(Boolean);
  }

  async function addTo(w: Watchlist) {
    const existing = symbolsOf(w);
    if (existing.includes(symbol)) {
      setSavedTo(w.name);
      setOpen(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const updated = await updateWatchlist(w.id, { symbols: [...existing, symbol].join(",") });
      setWatchlists((prev) => prev?.map((x) => (x.id === w.id ? updated : x)) ?? null);
      setSavedTo(w.name);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  async function createAndAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const created = await createWatchlist({ name, symbols: symbol });
      setWatchlists((prev) => (prev ? [...prev, created] : [created]));
      setSavedTo(created.name);
      setNewName("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create watchlist");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="weekly-advisor-watchlist-control">
      <button type="button" className="secondary tiny" onClick={toggleOpen}>
        {savedTo ? `✓ ${savedTo}` : "Save to watchlist ▾"}
      </button>
      {open && (
        <div className="weekly-advisor-watchlist-popover">
          {error && <p className="error">{error}</p>}
          {loading && watchlists === null && <p className="hint">Loading...</p>}
          {watchlists && watchlists.length > 0 && (
            <ul>
              {watchlists.map((w) => {
                const already = symbolsOf(w).includes(symbol);
                return (
                  <li key={w.id}>
                    <button type="button" className="secondary tiny" disabled={loading || already} onClick={() => addTo(w)}>
                      {already ? `✓ ${w.name}` : `+ ${w.name}`}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {watchlists && watchlists.length === 0 && <p className="hint">No watchlists yet.</p>}
          <form onSubmit={createAndAdd} className="weekly-advisor-watchlist-new">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New watchlist name" />
            <button type="submit" className="secondary tiny" disabled={loading || !newName.trim()}>
              + Create
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// Emphasis order, top to bottom: symbol/bias/confidence (the headline) ->
// recommended action + legs summary (the actual takeaway) -> everything
// else (the technical/fundamental "why", each collapsed by default behind
// its own toggle) -> footer. Collapsing the bulky, symbol-to-symbol
// variable-length content (reasons list, leg detail table, fundamentals
// pros/cons) is what keeps every card's default (unexpanded) height close
// to uniform in the grid below, instead of a symbol with 8 reasons towering
// over one with 2.
function RecommendationCard({ rec, footer }: { rec: WeeklyRecommendation; footer?: React.ReactNode }) {
  const bias = rec.regime.bias;
  const noNewEntry = rec.strategy.action === "avoid_new_entry" || rec.strategy.action === "close_existing";
  const [showTechnical, setShowTechnical] = useState(false);
  const [showFundamentals, setShowFundamentals] = useState(false);
  const [showLegs, setShowLegs] = useState(false);

  // The fundamentals vote's own reason (regime_engine.py's _fundamental_vote)
  // is already shown in full in the Fundamentals section below (its summary
  // is richer than this one-liner) - excluded here so technical vs
  // fundamental reasoning reads as two distinct sections, not one list with
  // the fundamentals line repeated a second time underneath. Grouped by
  // category (2026-09-16, see contracts.RegimeSignal on the backend)
  // instead of one flat sentence-by-sentence list - each category only
  // renders when it actually has a signal this cycle.
  const technicalSignals = rec.regime.signals.filter((s) => s.category !== "fundamentals");
  const technicalGroups = SIGNAL_CATEGORY_ORDER.map((category) => ({
    category,
    signals: technicalSignals.filter((s) => s.category === category),
  })).filter((g) => g.signals.length > 0);
  const bullishCount = technicalSignals.filter((s) => s.direction === "bullish").length;
  const bearishCount = technicalSignals.filter((s) => s.direction === "bearish").length;
  const legsSummary = rec.strategy.legs.map((leg) => `${leg.side === "sell" ? "SELL" : "BUY"} ${leg.strike} ${leg.option_type}`).join(" / ");

  return (
    <div className="panel weekly-advisor-card">
      <div className="weekly-advisor-card-head">
        <h3 className="symbol">{rec.symbol}</h3>
        <span className={`badge ${BIAS_BADGE[bias]}`}>{bias}</span>
        <span className="badge-mini badge-mini-muted" title="Weekly ADX trend strength">
          {rec.regime.trend_strength}
        </span>
        <a
          className="crosslink"
          href={manualTradingChartUrl(rec.symbol)}
          target="_blank"
          rel="noreferrer"
          title="Open this symbol in manual-trading's Live Chart (opens as a one-off view; drawings save per-symbol)"
        >
          Open chart ↗
        </a>
        <SaveToWatchlistControl symbol={rec.symbol} />
        <span className="muted weekly-advisor-confidence">confidence {Math.round(rec.regime.confidence * 100)}%</span>
      </div>

      <div className="weekly-advisor-action-row">
        <span className={`badge-mini ${noNewEntry ? "badge-mini-sell" : "badge-mini-buy"}`}>
          {actionLabel(rec.strategy.action, rec.strategy.legs.length)}
        </span>
        {legsSummary && <span className="weekly-advisor-legs-summary muted">{legsSummary}</span>}
        {rec.strategy.legs.length > 0 && (
          <button type="button" className="secondary tiny" onClick={() => setShowLegs((v) => !v)}>
            {showLegs ? "Hide" : "Leg detail ▸"}
          </button>
        )}
      </div>
      {showLegs && rec.strategy.legs.length > 0 && (
        <table className="weekly-advisor-legs">
          <tbody>
            {rec.strategy.legs.map((leg, i) => (
              <tr key={i}>
                <td>
                  <span className={leg.side === "sell" ? "badge-mini badge-mini-sell" : "badge-mini badge-mini-buy"}>
                    {leg.side.toUpperCase()}
                  </span>
                </td>
                <td className="num">{leg.strike}</td>
                <td>{leg.option_type}</td>
                <td className="muted weekly-advisor-leg-basis">{leg.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!noNewEntry && (
        <p className="hint weekly-advisor-exit">
          Entry window: {formatDate(rec.strategy.entry_window.earliest)} – {formatDate(rec.strategy.entry_window.latest)}{" "}
          ({rec.strategy.entry_window.days_to_expiry_at_entry}d to expiry). Exit at{" "}
          {Math.round(rec.strategy.exit_rule.target_pct_of_max_profit * 100)}% of max profit or{" "}
          {rec.strategy.exit_rule.hard_exit_days_before_expiry}d before expiry, whichever comes first.
        </p>
      )}

      <div className="weekly-advisor-technicals">
        <span>Close <strong>{rec.technical.close.toFixed(2)}</strong></span>
        <span>EMA50 {rec.technical.ema50.toFixed(2)}</span>
        <span>ADX {rec.technical.adx14.toFixed(1)} ({rec.technical.adx14_slope})</span>
        <span>ATR {rec.technical.atr14.toFixed(1)}</span>
        <span title={rec.oi.available ? "" : "OI data unavailable this run"}>
          OI {rec.oi.available ? (rec.oi.aggregate_signal ?? "mixed") : "n/a"}
          <a
            className="crosslink"
            href={manualTradingOiUrl(rec.symbol)}
            target="_blank"
            rel="noreferrer"
            title="Open this symbol's OI tab in manual-trading (opens as a one-off tab; not added to the fixed watchlist)"
          >
            {" "}
            ↗
          </a>
        </span>
      </div>

      <div className="weekly-advisor-section-head">
        <span className="muted weekly-advisor-signal-summary">
          {bullishCount > 0 && <span className="bullish">{bullishCount} bullish</span>}
          {bearishCount > 0 && <span className="bearish">{bearishCount} bearish</span>}
          {technicalSignals.length - bullishCount - bearishCount > 0 && (
            <span>{technicalSignals.length - bullishCount - bearishCount} neutral</span>
          )}
        </span>
        <button type="button" className="secondary tiny" onClick={() => setShowTechnical((v) => !v)}>
          {showTechnical ? "Hide" : "Details ▸"}
        </button>
      </div>
      {showTechnical && (
        <div className="weekly-advisor-signal-groups">
          {technicalGroups.map(({ category, signals }) => (
            <div key={category} className="weekly-advisor-signal-group">
              <div className="weekly-advisor-signal-group-label">{SIGNAL_CATEGORY_LABEL[category]}</div>
              <ul className="weekly-advisor-reasons">
                {signals.map((s, i) => (
                  <li key={i}>
                    <SignalIndicator direction={s.direction} />
                    {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {rec.fundamentals.available && (
        <div className="weekly-advisor-fundamentals">
          <div className="weekly-advisor-section-head">
            {rec.fundamentals.bias && rec.fundamentals.bias !== "neutral" && (
              <span className={`badge-mini ${BIAS_BADGE[rec.fundamentals.bias]}`}>fundamentals {rec.fundamentals.bias}</span>
            )}
            {rec.fundamentals.confidence != null && <span className="muted">confidence {Math.round(rec.fundamentals.confidence * 100)}%</span>}
            <button type="button" className="secondary tiny" onClick={() => setShowFundamentals((v) => !v)}>
              {showFundamentals ? "Hide" : "Details ▸"}
            </button>
          </div>
          {showFundamentals && (
            <>
              <a
                className="crosslink"
                href={screenerScreenshotUrl(rec.symbol)}
                target="_blank"
                rel="noreferrer"
                title="The screener.in screenshot the AI read this from"
              >
                View screener.in ↗
              </a>
              {rec.fundamentals.summary && <p className="hint">{rec.fundamentals.summary}</p>}
              {(rec.fundamentals.pros.length > 0 || rec.fundamentals.cons.length > 0) && (
                <div className="weekly-advisor-pros-cons">
                  {rec.fundamentals.pros.length > 0 && (
                    <ul className="weekly-advisor-pros">
                      {rec.fundamentals.pros.map((p, i) => (
                        <li key={i}>+ {p}</li>
                      ))}
                    </ul>
                  )}
                  {rec.fundamentals.cons.length > 0 && (
                    <ul className="weekly-advisor-cons">
                      {rec.fundamentals.cons.map((c, i) => (
                        <li key={i}>- {c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {footer && <div className="weekly-advisor-card-footer">{footer}</div>}
    </div>
  );
}

type BiasFilter = "all" | "bullish" | "bearish" | "neutral";
type ZoneFilter = "all" | "testing" | "mid-range";
type TrendFilter = "all" | WeeklyRecommendation["regime"]["trend_strength"];
// "none" means "no OI/fundamentals data available" (oi.available or
// fundamentals.available is false that cycle) - a real, distinct option
// rather than letting those rows just silently vanish under any specific
// non-"all" choice with no explanation.
type OiBuildupFilter = "all" | NonNullable<WeeklyRecommendation["oi"]["aggregate_signal"]> | "none";
type FundamentalsBiasFilter = "all" | NonNullable<WeeklyRecommendation["fundamentals"]["bias"]> | "none";

const OI_BUILDUP_LABELS: Record<NonNullable<WeeklyRecommendation["oi"]["aggregate_signal"]>, string> = {
  long_buildup: "Long buildup",
  short_buildup: "Short buildup",
  short_covering: "Short covering",
  long_unwinding: "Long unwinding",
};

// _zone_vote (regime_engine.py) votes bullish/bearish only when price is
// within 2% of a support/resistance zone, direction=null otherwise - now
// a real field to check (regime.signals, added 2026-09-16) instead of the
// text-match against _zone_vote's exact "no zone test in play" wording
// this used to be.
function isTestingZone(rec: WeeklyRecommendation): boolean {
  return rec.regime.signals.some((s) => s.category === "structure" && s.direction !== null);
}

function RunTab() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState("");
  const [symbolsInput, setSymbolsInput] = useState(DEFAULT_SYMBOLS);
  const [recommendations, setRecommendations] = useState<WeeklyRecommendation[]>([]);
  const [skipped, setSkipped] = useState<WeeklyAdvisorSkipped[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Client-side only - filters the already-fetched batch, doesn't re-run
  // the pipeline. confidence is stored/compared as a whole-percent (0-100)
  // to match what the card itself displays, not the raw 0-1 fraction.
  const [biasFilter, setBiasFilter] = useState<BiasFilter>("all");
  const [minConfidence, setMinConfidence] = useState(0);
  const [maxConfidence, setMaxConfidence] = useState(100);
  const [zoneFilter, setZoneFilter] = useState<ZoneFilter>("all");
  const [trendFilter, setTrendFilter] = useState<TrendFilter>("all");
  const [oiBuildupFilter, setOiBuildupFilter] = useState<OiBuildupFilter>("all");
  const [fundamentalsBiasFilter, setFundamentalsBiasFilter] = useState<FundamentalsBiasFilter>("all");
  // Same whole-percent convention as minConfidence/maxConfidence above -
  // fundamentals.confidence is a separate 0-1 fraction from regime.confidence
  // (this module's OWN overall call, folding fundamentals in as just one of
  // several weighted votes - see regime_engine.py's _fundamental_vote), not
  // a duplicate of the existing Confidence % filter.
  const [minFundamentalsConfidence, setMinFundamentalsConfidence] = useState(0);
  const [maxFundamentalsConfidence, setMaxFundamentalsConfidence] = useState(100);

  const filteredRecommendations = recommendations.filter((rec) => {
    if (biasFilter !== "all" && rec.regime.bias !== biasFilter) return false;
    const confidencePct = Math.round(rec.regime.confidence * 100);
    if (confidencePct < minConfidence || confidencePct > maxConfidence) return false;
    if (zoneFilter === "testing" && !isTestingZone(rec)) return false;
    if (zoneFilter === "mid-range" && isTestingZone(rec)) return false;
    if (trendFilter !== "all" && rec.regime.trend_strength !== trendFilter) return false;
    // "none" checks the nullable field itself, not just .available - OI can
    // be available=true yet still have no clear buildup call (aggregate_signal's
    // own "mixed, no >50% plurality" case, see oi_classifier.aggregate_signal),
    // which should read the same as "no OI data" for this filter's purposes.
    if (oiBuildupFilter === "none" && rec.oi.aggregate_signal !== null) return false;
    if (oiBuildupFilter !== "all" && oiBuildupFilter !== "none" && rec.oi.aggregate_signal !== oiBuildupFilter) return false;
    if (fundamentalsBiasFilter === "none" && rec.fundamentals.bias !== null) return false;
    if (fundamentalsBiasFilter !== "all" && fundamentalsBiasFilter !== "none" && rec.fundamentals.bias !== fundamentalsBiasFilter) return false;
    if (minFundamentalsConfidence > 0 || maxFundamentalsConfidence < 100) {
      if (rec.fundamentals.confidence == null) return false;
      const fundamentalsConfidencePct = Math.round(rec.fundamentals.confidence * 100);
      if (fundamentalsConfidencePct < minFundamentalsConfidence || fundamentalsConfidencePct > maxFundamentalsConfidence) return false;
    }
    return true;
  });

  useEffect(() => {
    fetchWatchlists()
      .then(setWatchlists)
      .catch(() => {
        // keep the picker empty rather than blocking this tab on a blip
      });
  }, []);

  function handleWatchlistChange(id: string) {
    setSelectedWatchlistId(id);
    const w = watchlists.find((x) => x.id === id);
    if (w) setSymbolsInput(w.symbols.toUpperCase());
  }

  async function handleRun() {
    const symbols = symbolsInput
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length === 0) return;

    setLoading(true);
    setError(null);
    setRecommendations([]);
    setSkipped([]);
    setProgress({ done: 0, total: symbols.length });

    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += RUN_CHUNK_SIZE) chunks.push(symbols.slice(i, i + RUN_CHUNK_SIZE));

    try {
      // Sequential, not Promise.all - each chunk already runs 5-wide on
      // the backend (see weekly_advisor.py's _BATCH_CONCURRENCY); firing
      // every chunk at once too would multiply that concurrency by the
      // chunk count against the same Yahoo Finance endpoint underneath.
      for (const chunk of chunks) {
        const data = await fetchWeeklyAdvisorRecommendations(chunk);
        setRecommendations((prev) => [...prev, ...data.recommendations]);
        setSkipped((prev) => [...prev, ...data.skipped]);
        setProgress((prev) => (prev ? { done: Math.min(prev.done + chunk.length, prev.total), total: prev.total } : prev));
      }
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load weekly recommendations");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <>
      <div className="settings-row weekly-advisor-run-row">
        <label>
          Watchlist
          <select value={selectedWatchlistId} onChange={(e) => handleWatchlistChange(e.target.value)}>
            <option value="">Custom list below</option>
            {watchlists.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.symbol_count})
              </option>
            ))}
          </select>
        </label>
        <label>
          Symbols
          <input
            value={symbolsInput}
            onChange={(e) => {
              setSymbolsInput(e.target.value);
              setSelectedWatchlistId("");
            }}
            placeholder={DEFAULT_SYMBOLS}
            title="Comma-separated NSE symbols"
            style={{ minWidth: "22rem" }}
          />
        </label>
        <button type="button" onClick={handleRun} disabled={loading}>
          {loading ? "Running..." : "Run"}
        </button>
        {lastUpdated && <span className="muted weekly-advisor-last-run">Last run {lastUpdated.toLocaleTimeString()}</span>}
      </div>

      {progress && (
        <div className="weekly-advisor-progress">
          <div className="weekly-advisor-progress-track">
            <div className="weekly-advisor-progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <span className="muted">
            {progress.done}/{progress.total} symbols
          </span>
        </div>
      )}

      {error && <p className="error">Could not reach the backend: {error}</p>}

      {skipped.length > 0 && (
        <p className="hint">
          Skipped: {skipped.map((s) => `${s.symbol} (${s.reason})`).join("; ")}
        </p>
      )}

      {recommendations.length === 0 && !loading && !error && (
        <p className="empty">No recommendations yet - pick a watchlist or type symbols, then click Run.</p>
      )}

      {recommendations.length > 0 && (
        <div className="settings-row weekly-advisor-filter-row">
          <label>
            Bias
            <select value={biasFilter} onChange={(e) => setBiasFilter(e.target.value as BiasFilter)}>
              <option value="all">All</option>
              <option value="bullish">Bullish</option>
              <option value="bearish">Bearish</option>
              <option value="neutral">Neutral</option>
            </select>
          </label>
          <label>
            Confidence %
            <span className="weekly-advisor-confidence-range">
              <input
                type="number" min={0} max={100} step={5} value={minConfidence} title="Minimum confidence"
                onChange={(e) => setMinConfidence(Math.min(Number(e.target.value), maxConfidence))}
                style={{ width: "4rem" }}
              />
              <span className="muted">–</span>
              <input
                type="number" min={0} max={100} step={5} value={maxConfidence} title="Maximum confidence"
                onChange={(e) => setMaxConfidence(Math.max(Number(e.target.value), minConfidence))}
                style={{ width: "4rem" }}
              />
            </span>
          </label>
          <label>
            Zone
            <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value as ZoneFilter)}>
              <option value="all">All</option>
              <option value="testing">Testing a zone</option>
              <option value="mid-range">Mid-range (no zone)</option>
            </select>
          </label>
          <label>
            Trend
            <select value={trendFilter} onChange={(e) => setTrendFilter(e.target.value as TrendFilter)}>
              <option value="all">All</option>
              <option value="trending">Trending</option>
              <option value="decelerating">Decelerating</option>
              <option value="ranging">Ranging</option>
            </select>
          </label>
          <label>
            OI buildup
            <select value={oiBuildupFilter} onChange={(e) => setOiBuildupFilter(e.target.value as OiBuildupFilter)}>
              <option value="all">All</option>
              {(Object.keys(OI_BUILDUP_LABELS) as (keyof typeof OI_BUILDUP_LABELS)[]).map((k) => (
                <option key={k} value={k}>
                  {OI_BUILDUP_LABELS[k]}
                </option>
              ))}
              <option value="none">No OI data</option>
            </select>
          </label>
          <label>
            Fundamentals bias
            <select value={fundamentalsBiasFilter} onChange={(e) => setFundamentalsBiasFilter(e.target.value as FundamentalsBiasFilter)}>
              <option value="all">All</option>
              <option value="bullish">Bullish</option>
              <option value="bearish">Bearish</option>
              <option value="neutral">Neutral</option>
              <option value="none">No fundamentals data</option>
            </select>
          </label>
          <label>
            Fundamentals confidence %
            <span className="weekly-advisor-confidence-range">
              <input
                type="number" min={0} max={100} step={5} value={minFundamentalsConfidence} title="Minimum fundamentals confidence"
                onChange={(e) => setMinFundamentalsConfidence(Math.min(Number(e.target.value), maxFundamentalsConfidence))}
                style={{ width: "4rem" }}
              />
              <span className="muted">–</span>
              <input
                type="number" min={0} max={100} step={5} value={maxFundamentalsConfidence} title="Maximum fundamentals confidence"
                onChange={(e) => setMaxFundamentalsConfidence(Math.max(Number(e.target.value), minFundamentalsConfidence))}
                style={{ width: "4rem" }}
              />
            </span>
          </label>
          {(biasFilter !== "all" ||
            minConfidence > 0 ||
            maxConfidence < 100 ||
            zoneFilter !== "all" ||
            trendFilter !== "all" ||
            oiBuildupFilter !== "all" ||
            fundamentalsBiasFilter !== "all" ||
            minFundamentalsConfidence > 0 ||
            maxFundamentalsConfidence < 100) && (
            <button
              type="button"
              className="secondary tiny"
              onClick={() => {
                setBiasFilter("all");
                setMinConfidence(0);
                setMaxConfidence(100);
                setZoneFilter("all");
                setTrendFilter("all");
                setOiBuildupFilter("all");
                setFundamentalsBiasFilter("all");
                setMinFundamentalsConfidence(0);
                setMaxFundamentalsConfidence(100);
              }}
            >
              Clear filter
            </button>
          )}
          <span className="muted">
            Showing {filteredRecommendations.length} of {recommendations.length}
          </span>
        </div>
      )}

      {recommendations.length > 0 && filteredRecommendations.length === 0 && (
        <p className="empty">No recommendations match this filter.</p>
      )}

      <div className="weekly-advisor-grid">
        {filteredRecommendations.map((rec) => (
          <RecommendationCard key={rec.symbol} rec={rec} footer={<SaveControl rec={rec} />} />
        ))}
      </div>
    </>
  );
}

function HistoryTab({ active }: { active: boolean }) {
  const [symbolFilter, setSymbolFilter] = useState("");
  const [rows, setRows] = useState<SavedWeeklyRecommendation[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // Which saved recommendations already have a trade journaled against
  // them, and that trade's own data - unlike SaveControl's own local
  // `trade` state, HistoryTab lists rows loaded fresh from the API with
  // no such field on them, so it's derived here from the trades list
  // itself (by recommendation_id), and handed to DecisionForm so
  // reopening "Change decision" can show what was actually journaled
  // instead of just hiding those fields.
  const [tradesByRecommendation, setTradesByRecommendation] = useState<Map<string, WeeklyAdvisorTrade>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [historyRows, trades] = await Promise.all([fetchWeeklyAdvisorHistory(symbolFilter || undefined), fetchWeeklyAdvisorTrades()]);
      setRows(historyRows);
      setTradesByRecommendation(new Map(trades.map((t) => [t.recommendation_id, t])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }

  // This tab stays permanently mounted (see WeeklyAdvisorPage's `hidden`
  // wrapper - switching away from it must not lose RunTab's own in-memory
  // batch results), so a plain mount-only effect would only ever show a
  // point-in-time snapshot from whenever the page first loaded. Reload
  // every time the tab is actually switched to instead, so a decision/
  // trade just saved in the Run tab shows up here without a manual Filter
  // click.
  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <>
      <p className="subtitle">Every saved recommendation snapshot, newest first - a frozen point-in-time record, not a live re-query.</p>
      <div className="settings-row">
        <label>
          Symbol
          <input value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())} placeholder="e.g. TCS" />
        </label>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? "Loading..." : "Filter"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {rows.length === 0 && !loading && !error && <p className="empty">No saved recommendations yet - save one from the Run tab.</p>}

      <table>
        <thead>
          <tr>
            <th>Saved</th>
            <th>Symbol</th>
            <th>As of</th>
            <th>Action</th>
            <th>Decision</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.id}>
              <tr>
                <td>{formatDateTime(row.saved_at)}</td>
                <td className="symbol">{row.symbol}</td>
                <td>{formatDate(row.as_of)}</td>
                <td>{actionLabel(row.action, row.payload.strategy.legs.length)}</td>
                <td>
                  {row.decision ? (
                    <span className={`badge-mini ${DECISION_BADGE[row.decision]}`} title={row.decision_comments ?? ""}>
                      {DECISION_LABELS[row.decision]}
                      {row.confidence != null ? ` ${row.confidence}/5` : ""}
                    </span>
                  ) : (
                    "-"
                  )}
                </td>
                <td>
                  <button type="button" className="secondary tiny" onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}>
                    {expandedId === row.id ? "Hide" : "Details"}
                  </button>
                </td>
              </tr>
              {expandedId === row.id && (
                <tr>
                  <td colSpan={6}>
                    <RecommendationCard
                      rec={row.payload}
                      footer={
                        <>
                          {decidingId === row.id ? (
                            <DecisionForm
                              rec={row.payload}
                              recommendationId={row.id}
                              alreadyTaken={tradesByRecommendation.has(row.id)}
                              existingDecision={row.decision}
                              existingConfidence={row.confidence}
                              existingComments={row.decision_comments}
                              existingTrade={tradesByRecommendation.get(row.id) ?? null}
                              onDone={() => {
                                setDecidingId(null);
                                load();
                              }}
                              onTradeUpdated={(updated) => setTradesByRecommendation((prev) => new Map(prev).set(row.id, updated))}
                              onCancel={() => setDecidingId(null)}
                            />
                          ) : (
                            <>
                              <button type="button" className="secondary tiny" onClick={() => setDecidingId(row.id)}>
                                {row.decision ? "Change decision" : "Log decision"}
                              </button>
                              {row.decision === "execute" && tradesByRecommendation.has(row.id) && <span className="hint"> - marked as taken</span>}
                            </>
                          )}
                        </>
                      }
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

const STATUS_BADGE: Record<WeeklyAdvisorTradeStatus, string> = { open: "badge-mini-buy", expired: "badge-mini-sell", closed: "badge-mini-muted" };

function PerformanceTab() {
  const [summary, setSummary] = useState<WeeklyAdvisorPerformanceSummary | null>(null);
  const [trades, setTrades] = useState<WeeklyAdvisorTrade[]>([]);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [s, t] = await Promise.all([fetchWeeklyAdvisorPerformance(), fetchWeeklyAdvisorTrades()]);
      setSummary(s);
      setTrades(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load performance");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <header className="header-row">
        <p className="subtitle">Performance is computed off the manual trade journal below, not a real execution-opened position.</p>
        <button type="button" className="secondary tiny" onClick={load} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </header>
      {error && <p className="error">{error}</p>}

      {summary && (
        <div className="weekly-advisor-perf-summary">
          <span>Open <strong>{summary.open_count}</strong></span>
          {summary.expired_count > 0 && (
            <span className="pnl-negative">Expired - needs review <strong>{summary.expired_count}</strong></span>
          )}
          <span>Closed <strong>{summary.closed_count}</strong></span>
          <span>Win rate <strong>{summary.win_rate != null ? `${Math.round(summary.win_rate * 100)}%` : "-"}</strong></span>
          <span>
            Total P&amp;L{" "}
            <strong className={summary.total_realized_pnl >= 0 ? "pnl-positive" : "pnl-negative"}>
              {summary.total_realized_pnl.toFixed(2)}
            </strong>
          </span>
        </div>
      )}

      {trades.length === 0 && !loading && !error && <p className="empty">No journaled trades yet - mark a saved recommendation as taken.</p>}

      <table>
        <thead>
          <tr>
            <th>Taken</th>
            <th>Symbol</th>
            <th>Action</th>
            <th>Status</th>
            <th>DTE</th>
            <th>Qty</th>
            <th>Credit</th>
            <th>P&amp;L</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <Fragment key={t.id}>
              <tr>
                <td>{formatDateTime(t.taken_at)}</td>
                <td className="symbol">{t.symbol}</td>
                <td>{actionLabel(t.action, t.legs?.length ?? 0)}</td>
                <td>
                  <span className={`badge-mini ${STATUS_BADGE[t.status]}`}>{t.status}</span>
                </td>
                <td className="num">{t.days_to_expiry_at_entry ?? "-"}</td>
                <td className="num">{t.quantity ?? "-"}</td>
                <td className="num">{t.entry_credit ?? "-"}</td>
                <td className={`num ${t.realized_pnl != null ? (t.realized_pnl >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}>
                  {t.status === "closed" ? (
                    t.realized_pnl ?? "-"
                  ) : (
                    (() => {
                      const unrealized = weeklyAdvisorUnrealizedPnl(t);
                      return unrealized != null ? (
                        <span className={unrealized >= 0 ? "pnl-positive" : "pnl-negative"} title="Unrealized - last leg refresh">
                          {unrealized} (live)
                        </span>
                      ) : (
                        "-"
                      );
                    })()
                  )}
                </td>
                <td>
                  <button type="button" className="secondary tiny" onClick={() => setDetailsId(detailsId === t.id ? null : t.id)}>
                    {detailsId === t.id ? "Hide" : "Details"}
                  </button>{" "}
                  {(t.status === "open" || t.status === "expired") && (
                    <button type="button" className="secondary tiny" onClick={() => setClosingId(closingId === t.id ? null : t.id)}>
                      {closingId === t.id ? "Cancel" : "Close"}
                    </button>
                  )}
                </td>
              </tr>
              {detailsId === t.id && (
                <tr>
                  <td colSpan={9}>
                    <div className="weekly-advisor-technicals">
                      <span>Your bias {t.actual_bias ?? "-"}</span>
                      <span>Your strategy {t.actual_strategy ?? "-"}</span>
                      <span>Funds needed {t.funds_needed ?? "-"}</span>
                      <span>Margin needed {t.margin_needed ?? "-"}</span>
                      <span>POP {t.pop != null ? `${t.pop}%` : "-"}</span>
                      <span>Max profit {t.max_profit ?? "-"}</span>
                      <span>Max loss {t.max_loss ?? "-"}</span>
                      <span>Target {t.target_pct_of_max_profit != null ? `${t.target_pct_of_max_profit}% of max profit` : "-"}</span>
                      <span>Stop-loss {t.stop_loss_pct_of_max_loss != null ? `${t.stop_loss_pct_of_max_loss}% of max loss` : "-"}</span>
                      {t.exit_debit != null && <span>Debit paid to close {t.exit_debit}</span>}
                      {t.expiry_date && <span>Expiry {formatDate(t.expiry_date)}</span>}
                      {t.prices_updated_at && <span className="muted">Prices as of {formatDateTime(t.prices_updated_at)}</span>}
                    </div>
                    {t.legs && t.legs.length > 0 && (
                      <div className="weekly-advisor-technicals">
                        {t.legs.map((leg, i) => (
                          <span key={i}>
                            {leg.side.toUpperCase()} {leg.option_type} {leg.strike}
                            {leg.entry_price != null ? ` @ ${leg.entry_price}` : " (not filled yet)"}
                            {leg.current_price != null && ` -> now ${leg.current_price}`}
                          </span>
                        ))}
                      </div>
                    )}
                    {(t.entry_notes || t.exit_notes) && (
                      <p className="hint">
                        {t.entry_notes && <>Entry: {t.entry_notes} </>}
                        {t.exit_notes && <>Exit: {t.exit_notes}</>}
                      </p>
                    )}
                  </td>
                </tr>
              )}
              {closingId === t.id && (
                <tr>
                  <td colSpan={9}>
                    <CloseTradeForm
                      trade={t}
                      onDone={() => {
                        setClosingId(null);
                        load();
                      }}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

// Free-text OpenRouter model slug for the fundamentals screenshot read
// (screener_fetch.py needs a vision-capable model) - not a fixed dropdown,
// same reasoning as market-data's NewsAiSettingsPanel.
function SettingsTab() {
  const [current, setCurrent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchWeeklyAdvisorSettings()
      .then((s) => {
        setCurrent(s.openrouter_vision_model);
        setDraft(s.openrouter_vision_model);
      })
      .catch(() => {
        // Same "don't block the rest of the tab" reasoning as elsewhere.
      });
  }, []);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await updateWeeklyAdvisorSettings(trimmed);
      setCurrent(updated.openrouter_vision_model);
      setDraft(updated.openrouter_vision_model);
      setMessage("Saved - takes effect on the next fundamentals fetch.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel weekly-advisor-card">
      <h3>Fundamentals AI model</h3>
      <p className="subtitle">
        OpenRouter model slug (see openrouter.ai/models) used to read each symbol's screener.in screenshot - must
        support image input. No restart needed, but reverts to .env's OPENROUTER_VISION_MODEL on one. Already-cached
        fundamentals (see weekly_advisor_fundamentals_cache_days, default 90d) keep whatever model produced them
        until their own cache expires.
      </p>
      <div className="settings-row">
        <input
          type="text"
          autoComplete="off"
          placeholder="e.g. anthropic/claude-haiku-4.5"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" onClick={handleSave} disabled={saving || !draft.trim() || draft.trim() === current}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      {message && <p className="hint">{message}</p>}
      {current && <p className="hint">Currently: {current}</p>}
    </div>
  );
}

export default function WeeklyAdvisorPage() {
  const [subTab, setSubTab] = useState<SubTab>("run");

  return (
    <>
      <nav className="tabs weekly-advisor-subtabs">
        <button className={subTab === "run" ? "active" : ""} onClick={() => setSubTab("run")}>
          Run
        </button>
        <button className={subTab === "history" ? "active" : ""} onClick={() => setSubTab("history")}>
          History
        </button>
        <button className={subTab === "performance" ? "active" : ""} onClick={() => setSubTab("performance")}>
          Performance
        </button>
        <button className={subTab === "settings" ? "active" : ""} onClick={() => setSubTab("settings")}>
          Settings
        </button>
      </nav>
      {/* All four stay mounted permanently (hidden via the `hidden` attribute,
          not conditional rendering) - Run's batch results (and its filters) used
          to reset every time a subtab switch unmounted it, losing an expensive
          multi-minute run just from clicking over to History and back. */}
      <div hidden={subTab !== "run"}>
        <RunTab />
      </div>
      <div hidden={subTab !== "history"}>
        <HistoryTab active={subTab === "history"} />
      </div>
      <div hidden={subTab !== "performance"}>
        <PerformanceTab />
      </div>
      <div hidden={subTab !== "settings"}>
        <SettingsTab />
      </div>
    </>
  );
}
