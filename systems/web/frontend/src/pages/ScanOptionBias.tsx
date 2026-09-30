import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/http";
import { getComboMargin, getExpiries, getLotSizeForSecurity, getOptionChain } from "../api/trade";
import type { OptionChainStrike, OptionLegQuote } from "../api/types";
import { formatDay, formatInr, formatPct } from "../format";
import { useResource } from "../hooks/useResource";
import type { Action, Strategy, Ticket } from "./tradeModel";

const STRATEGY_LABEL: Record<string, string> = {
  bull_call_spread: "Bull Call Spread",
  bear_put_spread: "Bear Put Spread",
  bull_put_spread: "Bull Put Spread",
  bear_call_spread: "Bear Call Spread",
  naked_call: "Buy Call",
  naked_put: "Buy Put",
};

type Style = "naked" | "spread" | "credit_spread";
type LegPlan = { primaryAction: "BUY" | "SELL"; secondAction: "BUY" | "SELL" | null; optionType: "CE" | "PE" };

/** Which leg is BUY/SELL and CE/PE for a given view+style - the same dispatch table
 * open_manual_option_group itself uses (bull_call_spread BUY-primary/SELL-second,
 * bull_put_spread SELL-primary/BUY-second, ...), just in JS. Stable and trivial (a lookup
 * table on two enums, not chain-dependent math) - unlike strike selection, which never
 * duplicates backend logic here at all: every strike shown comes straight from a real fetched
 * chain, and the person picks directly from it, so there's nothing to derive or drift. */
function legPlanFor(action: Action, style: Style): LegPlan {
  if (style === "naked") return { primaryAction: "BUY", secondAction: null, optionType: action === "BUY" ? "CE" : "PE" };
  if (style === "credit_spread") return { primaryAction: "SELL", secondAction: "BUY", optionType: action === "BUY" ? "PE" : "CE" };
  return { primaryAction: "BUY", secondAction: "SELL", optionType: action === "BUY" ? "CE" : "PE" };
}

const strategyTypeFor = (action: Action, style: Style): string =>
  style === "naked"
    ? action === "BUY"
      ? "naked_call"
      : "naked_put"
    : style === "credit_spread"
      ? action === "BUY"
        ? "bull_put_spread"
        : "bear_call_spread"
      : action === "BUY"
        ? "bull_call_spread"
        : "bear_put_spread";

const legQuote = (s: OptionChainStrike, legKey: "ce" | "pe"): OptionLegQuote | null => (legKey === "ce" ? s.ce : s.pe);

/** The index of the strike closest to the underlying's own price - only used if the chain
 * somehow carries no strike flagged ATM at all (shouldn't happen; market-data's own moneyness
 * classification always picks exactly one per side), so this never leaves the picker empty. */
function nearestIndex(strikes: OptionChainStrike[], price: number): number {
  let best = 0;
  let bestDist = Infinity;
  strikes.forEach((s, i) => {
    const dist = Math.abs(s.strike - price);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  return best;
}

type Props = { exchange: string; symbol: string; ticket: Ticket; onChange: (t: Ticket) => void };

/** The Scan page's own entry point into an option order - not the Trade page's Future/Option/
 * Option spread chips (see TradeTicket's hideStrategyChips): the OI-buildup card already puts the
 * put/call-buildup and PCR the person would use to form a view right above this, so what is
 * actually missing is turning "I think this goes up" into real legs, not another round of jargon
 * (naked vs spread, which moneyness) before anything concrete shows up. Picking a view sets the
 * same ticket.action a plain spot order already uses (BUY=bullish, SELL=bearish).
 *
 * The leg table works off a REAL option chain (market-data's GET /options/chain), fetched once
 * per (symbol, expiry) - not a preview-legs round trip on every click. Strike is a real dropdown
 * of every strike the chain actually has; Expiry is a real dropdown too (own loading state);
 * Lots is editable right in the table, defaulting to 1 on first entering an option view. Only
 * Type/Side stay derived, not editable - see legPlanFor.
 *
 * A Debit/Credit choice appears once a second leg is added: Debit (bull_call_spread/
 * bear_put_spread - pays a net premium) or Credit (bull_put_spread/bear_call_spread - receives
 * one, sized by max loss instead of cost - see execution's _spread_sizing_basis).
 *
 * Below the table: Max profit/Max loss (pure arithmetic from the chosen strikes/premiums/lots -
 * see maxProfitPerUnit/maxLossPerUnit) and a "Check margin" button (Dhan's real combo margin
 * calculator - market-data's GET /dhan/margin/combo, the same one weekly_advisor's own decision
 * form already uses, read-only - nothing is placed by this call). Once a margin figure comes back,
 * Max profit/Max loss also show what that is as a % of the real capital actually locked up (not
 * the naive per-unit fund figure PositionCard's own spreadMetrics uses post-entry, which has no
 * margin call to draw on) - cleared the moment anything the figure depended on changes (see the
 * effect right above checkMargin), same as the margin figure itself. For a two-leg position, a
 * Stop-loss %/Target % pair (defaults 50/70) lets the combined premium's own stop/target be set
 * as a fraction of that bounded max loss/profit - "close at 70% of max profit" - translated here
 * into a real combined_stop_loss_price/combined_target_price and attached right after the order
 * opens (ticket.combinedStopLossPrice/combinedTargetPrice, see tradeModel.ts's buildOrder). Not
 * offered for a naked position: max profit is unbounded for a naked call and only nominally
 * bounded (at the strike) for a naked put, so "% of max profit" doesn't mean the same thing. */
export function ScanOptionBias({ exchange, symbol, ticket: t, onChange }: Props) {
  const style: Style = t.strategy === "naked" ? "naked" : t.strategy === "credit_spread" ? "credit_spread" : "spread";
  const hasSecondLeg = style !== "naked";
  const plan = legPlanFor(t.action, style);
  const legKey: "ce" | "pe" = plan.optionType === "CE" ? "ce" : "pe";

  const expiries = useResource(() => getExpiries(exchange, symbol), [exchange, symbol]);
  const chainExpiry = t.expiry ?? expiries.data?.[0] ?? null;
  const chain = useResource(() => getOptionChain(exchange, symbol, chainExpiry ?? ""), [exchange, symbol, chainExpiry], { enabled: chainExpiry != null });

  const strikesForType = (chain.data?.strikes ?? []).filter((s) => legQuote(s, legKey) != null);

  // Set the instant a reset below issues its own onChange, cleared once `t` actually reflects it
  // (see the settle effect right after). Guards the combined stop-loss/target-% effect further
  // down: React runs every effect for a commit off the SAME (still-stale) `t` prop, and none of
  // these onChange calls merge - each is a plain setTicket(nextValue), so whichever one commits
  // last simply replaces the whole ticket, silently discarding any other effect's delta from that
  // same pass. Without this guard, flipping Debit<->Credit reproducibly reverted the freshly
  // reset strikes back to the OLD side's numbers: the reset effect below computed the correct new
  // primaryStrike/secondStrike and called onChange, but the stop/target effect (also scheduled
  // this pass, since netDebit/maxLoss/maxProfit derive from primaryQuote/secondQuote and so also
  // "changed" the moment legKey flipped) fired right after, computed its own combinedStopLossPrice/
  // combinedTargetPrice from that SAME stale `t`, and its onChange({...t, ...}) - built from the
  // pre-reset t.primaryStrike/secondStrike - won the race, reverting the strike pick and (since it
  // derived from mismatched strike+legKey premiums) baking in a wrong stop/target too. Reproduced
  // live 2026-09-30: a Bullish credit spread kept showing the prior debit view's CE strikes
  // relabelled PE (Sell 415/Buy 425 instead of Sell 415/Buy 405), with "Net debit" instead of
  // "Net credit". See docs/architecture.md if this needs revisiting - the underlying issue (several
  // sibling effects each spreading a shared, non-ref `t` prop) can resurface anywhere a similar
  // pair of effects both react to the same legKey/style change in one commit.
  const resetPendingRef = useRef(false);

  // A fresh chain, or a flip between CE and PE (Bullish<->Bearish, or Debit<->Credit - both
  // change which side each leg trades), always gets fresh ATM/width-2 defaults for BOTH legs - a
  // strike price carried over from the OTHER side means something completely different (what was
  // 2 strikes OTM is now 2 strikes ITM), so there's nothing worth preserving across that flip,
  // even if the same strike NUMBER happens to still exist on the new side.
  useEffect(() => {
    if (strikesForType.length === 0) return;
    const atmIndex = strikesForType.findIndex((s) => legQuote(s, legKey)!.moneyness === "ATM");
    const primaryIndex = atmIndex >= 0 ? atmIndex : nearestIndex(strikesForType, chain.data!.underlying_last_price);
    const direction = plan.optionType === "CE" ? 1 : -1;
    const secondIndex = Math.max(0, Math.min(strikesForType.length - 1, primaryIndex + direction * 2));
    resetPendingRef.current = true;
    onChange({ ...t, expiry: chain.data!.expiry, primaryStrike: strikesForType[primaryIndex].strike, secondStrike: strikesForType[secondIndex].strike });
    // Re-runs only when the chain's own expiry or which side (CE/PE) we're reading changes - not
    // on every ticket edit (typing Lots, picking a different strike by hand, ...), which would
    // fight the person's own picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.data?.expiry, legKey]);

  // Clears resetPendingRef once `t` actually reflects a landed change (the reset above, or any
  // other edit to these fields) - always declared, and runs, before the stop/target effect below
  // in source order, so by the time that effect's guard checks the ref on a settled render, it is
  // already clear.
  useEffect(() => {
    resetPendingRef.current = false;
  }, [t.primaryStrike, t.secondStrike, t.expiry]);

  // Adding a second leg (naked -> spread/credit_spread) fills in ONLY its own strike, keeping
  // whatever primary strike was already chosen - unlike a CE/PE flip above, gaining a second leg
  // doesn't change what the primary leg's own strike means, so there's nothing to reset there.
  useEffect(() => {
    if (!hasSecondLeg || t.secondStrike != null || strikesForType.length === 0) return;
    const primaryIndex = t.primaryStrike != null ? strikesForType.findIndex((s) => s.strike === t.primaryStrike) : -1;
    if (primaryIndex < 0) return; // the effect above will populate a primary strike too, in this same pass
    const direction = plan.optionType === "CE" ? 1 : -1;
    const secondIndex = Math.max(0, Math.min(strikesForType.length - 1, primaryIndex + direction * 2));
    onChange({ ...t, secondStrike: strikesForType[secondIndex].strike });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSecondLeg]);

  const primaryQuote = t.primaryStrike != null ? strikesForType.find((s) => s.strike === t.primaryStrike) : undefined;
  const secondQuote = t.secondStrike != null ? strikesForType.find((s) => s.strike === t.secondStrike) : undefined;
  const primaryLeg = primaryQuote ? legQuote(primaryQuote, legKey) : null;
  const secondLeg = secondQuote ? legQuote(secondQuote, legKey) : null;
  const primaryPremium = primaryLeg?.last_price ?? null;
  const secondPremium = secondLeg?.last_price ?? null;
  const buyPremium = plan.primaryAction === "BUY" ? primaryPremium : secondPremium;
  const sellPremium = plan.primaryAction === "SELL" ? primaryPremium : secondPremium;
  const netDebit = buyPremium != null && (plan.secondAction == null || sellPremium != null) ? buyPremium - (sellPremium ?? 0) : null;
  const strikeWidth = hasSecondLeg && t.primaryStrike != null && t.secondStrike != null ? Math.abs(t.primaryStrike - t.secondStrike) : null;

  // Per-unit (one share's worth) max loss/profit - bounded and knowable up front for anything
  // with a defined risk (a spread, or a naked put); "Unlimited" for a naked call, the one case
  // with no ceiling at all.
  const maxLossPerUnit = netDebit != null ? (netDebit >= 0 ? netDebit : strikeWidth != null ? strikeWidth - Math.abs(netDebit) : null) : null;
  const unlimitedProfit = style === "naked" && plan.optionType === "CE";
  const maxProfitPerUnit = unlimitedProfit
    ? null
    : style === "naked"
      ? primaryPremium != null && t.primaryStrike != null
        ? t.primaryStrike - primaryPremium // a naked put's max gain is capped at the underlying going to zero
        : null
      : netDebit != null && strikeWidth != null
        ? netDebit >= 0
          ? strikeWidth - netDebit // debit spread: width minus what was paid
          : Math.abs(netDebit) // credit spread: the credit received IS the max profit
        : null;

  // The real, current lot size for this contract (NOT the underlying's own lot-size concept -
  // see getLotSizeForSecurity) - needed for both the rupee totals below and a valid Dhan margin
  // request. Keyed on the primary leg's security_id only: lot size doesn't vary by strike within
  // one contract series.
  const lotSize = useResource(
    () => getLotSizeForSecurity(primaryLeg!.security_id, exchange),
    [primaryLeg?.security_id, exchange],
    { enabled: primaryLeg != null },
  );
  const lots = Number(t.lots) || 0;
  const quantity = lotSize.data != null && lots > 0 ? lots * lotSize.data : null;
  const maxLossTotal = maxLossPerUnit != null && quantity != null ? maxLossPerUnit * quantity : null;
  const maxProfitTotal = maxProfitPerUnit != null && quantity != null ? maxProfitPerUnit * quantity : null;

  const [margin, setMargin] = useState<number | null>(null);
  const [marginBusy, setMarginBusy] = useState(false);
  const [marginError, setMarginError] = useState<string | null>(null);
  // A margin figure for a different set of legs/quantity would be misleading - clear it the
  // moment anything it depended on changes, rather than leaving a stale number on screen.
  useEffect(() => {
    setMargin(null);
    setMarginError(null);
  }, [t.primaryStrike, t.secondStrike, hasSecondLeg, quantity, style, t.action]);

  async function checkMargin() {
    if (!primaryLeg || quantity == null) return;
    setMarginBusy(true);
    setMarginError(null);
    try {
      const legs = [{ security_id: primaryLeg.security_id, action: plan.primaryAction, price: primaryPremium ?? 0, quantity }];
      if (hasSecondLeg && secondLeg && plan.secondAction) legs.push({ security_id: secondLeg.security_id, action: plan.secondAction, price: secondPremium ?? 0, quantity });
      const res = await getComboMargin(exchange, legs);
      const total = res.raw.totalMargin;
      if (typeof total === "number") setMargin(total);
      else setMarginError("Dhan didn't return a margin figure.");
    } catch (e) {
      setMarginError(e instanceof ApiError ? e.message : "Could not check margin.");
    } finally {
      setMarginBusy(false);
    }
  }

  // Stop-loss %/Target % of max loss/profit, for a two-leg position only (see this component's
  // own docstring for why naked is excluded) - defaults 50/70, editable. Translated into a real
  // combined price and written onto the ticket whenever the percentages or the underlying
  // economics change, so it's always in sync with the strikes/lots actually chosen.
  const [stopPct, setStopPct] = useState(50);
  const [targetPct, setTargetPct] = useState(70);
  useEffect(() => {
    // A strike reset is in flight this same pass (see resetPendingRef's own comment) - netDebit/
    // maxLoss/maxProfit above were just computed from a strike+legKey pairing that's about to be
    // superseded, so any stop/target derived from them right now would be wrong, and writing them
    // via onChange({...t, ...}) would revert the reset's own not-yet-landed strike change (both
    // calls build off the same stale `t`, and only the LAST one survives). Skip - this effect
    // re-fires on its own once the reset lands and netDebit/maxLoss/maxProfit update to match.
    if (resetPendingRef.current) return;
    if (!hasSecondLeg || netDebit == null || maxLossPerUnit == null || maxProfitPerUnit == null) {
      if (t.combinedStopLossPrice != null || t.combinedTargetPrice != null) onChange({ ...t, combinedStopLossPrice: null, combinedTargetPrice: null });
      return;
    }
    const stopPrice = netDebit - (stopPct / 100) * maxLossPerUnit;
    const targetPrice = netDebit + (targetPct / 100) * maxProfitPerUnit;
    if (stopPrice !== t.combinedStopLossPrice || targetPrice !== t.combinedTargetPrice) onChange({ ...t, combinedStopLossPrice: stopPrice, combinedTargetPrice: targetPrice });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSecondLeg, netDebit, maxLossPerUnit, maxProfitPerUnit, stopPct, targetPct]);

  const setStyle = (next: Style) => onChange({ ...t, strategy: next as Strategy });
  const setLots = (v: string) => onChange({ ...t, lots: v });

  return (
    <div style={{ marginBottom: 12 }}>
      <label className="dim" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
        Your view on {symbol}
      </label>
      <div className="row" style={{ marginBottom: 12, alignItems: "flex-end" }}>
        <div className="chips" role="group" aria-label="Your view">
          <button aria-pressed={t.action === "BUY"} onClick={() => onChange({ ...t, action: "BUY" })}>
            Bullish
          </button>
          <button aria-pressed={t.action === "SELL"} onClick={() => onChange({ ...t, action: "SELL" })}>
            Bearish
          </button>
        </div>
        <label className="select-field" style={{ flex: "0 0 auto" }}>
          <span className="dim">Expiry</span>
          <select
            style={{ width: "max-content" }}
            value={chainExpiry ?? ""}
            disabled={!expiries.data || expiries.data.length === 0}
            onChange={(e) => onChange({ ...t, expiry: e.target.value, primaryStrike: null, secondStrike: null })}
          >
            {expiries.data?.map((exp) => (
              <option key={exp} value={exp}>
                {formatDay(exp)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {expiries.error && (
        <p className="dn" style={{ fontSize: 13, margin: "0 0 12px" }} role="alert">
          Couldn't load expiries: {expiries.error.message}
        </p>
      )}

      {(expiries.loading || (chainExpiry != null && chain.loading)) && (
        <p className="dim" style={{ fontSize: 13, margin: 0 }}>
          Loading the option chain…
        </p>
      )}
      {chain.error && (
        <p className="dn" style={{ fontSize: 13, margin: 0 }} role="alert">
          {chain.error.message}
        </p>
      )}
      {chain.data && strikesForType.length > 0 && (
        <div className="card table-scroll" style={{ padding: 0 }}>
          <table className="t" data-testid="option-leg-table">
            <thead>
              <tr>
                <th aria-label="Include leg" />
                <th>Side</th>
                <th>Strike</th>
                <th>Type</th>
                <th>Lots</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <input type="checkbox" checked disabled aria-label="Primary leg, always included" />
                </td>
                <td>
                  <span className={`pill ${plan.primaryAction === "BUY" ? "up" : "dn"}`}>{plan.primaryAction === "BUY" ? "Buy" : "Sell"}</span>
                </td>
                <td className="num">
                  <select aria-label="Primary leg strike" value={t.primaryStrike ?? ""} onChange={(e) => onChange({ ...t, primaryStrike: Number(e.target.value) })}>
                    {strikesForType.map((s) => (
                      <option key={s.strike} value={s.strike}>
                        {s.strike} (₹{legQuote(s, legKey)!.last_price.toFixed(2)})
                      </option>
                    ))}
                  </select>
                </td>
                <td>{plan.optionType}</td>
                <td className="num">
                  <input type="number" min={1} value={t.lots} onChange={(e) => setLots(e.target.value)} placeholder="1" style={{ width: 64 }} />
                </td>
                <td className="num">{formatInr(primaryPremium, 2)}</td>
              </tr>
              <tr>
                <td>
                  <input
                    type="checkbox"
                    checked={hasSecondLeg}
                    aria-label={hasSecondLeg ? "Remove the second leg (buy the option outright)" : "Add a second leg to cap the risk"}
                    onChange={(e) => setStyle(e.target.checked ? "spread" : "naked")}
                  />
                </td>
                {hasSecondLeg ? (
                  <>
                    <td>
                      <span className={`pill ${plan.secondAction === "BUY" ? "up" : "dn"}`}>{plan.secondAction === "BUY" ? "Buy" : "Sell"}</span>
                    </td>
                    <td className="num">
                      <select aria-label="Second leg strike" value={t.secondStrike ?? ""} onChange={(e) => onChange({ ...t, secondStrike: Number(e.target.value) })}>
                        {strikesForType.map((s) => (
                          <option key={s.strike} value={s.strike}>
                            {s.strike} (₹{legQuote(s, legKey)!.last_price.toFixed(2)})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{plan.optionType}</td>
                    <td className="num">
                      <input type="number" min={1} value={t.lots} onChange={(e) => setLots(e.target.value)} placeholder="1" style={{ width: 64 }} />
                    </td>
                    <td className="num">{formatInr(secondPremium, 2)}</td>
                  </>
                ) : (
                  <td colSpan={5} className="dim" style={{ fontSize: 13 }}>
                    Add a second leg to cap the risk (a defined-risk spread) instead of buying the option outright.
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {hasSecondLeg && (
        <div className="chips" role="group" aria-label="Debit or credit" style={{ margin: "8px 0" }}>
          <button aria-pressed={style === "spread"} onClick={() => setStyle("spread")}>
            Pay premium (debit)
          </button>
          <button aria-pressed={style === "credit_spread"} onClick={() => setStyle("credit_spread")}>
            Receive premium (credit)
          </button>
        </div>
      )}
      {chain.data && strikesForType.length > 0 && (
        <div className="row" style={{ marginTop: 8, fontSize: 13 }} data-testid="option-strategy-summary">
          <span className="dim">
            <strong style={{ color: "var(--text)" }}>{STRATEGY_LABEL[strategyTypeFor(t.action, style)]}</strong>
            {netDebit != null && (
              <>
                {" · Net "}
                {netDebit >= 0 ? "debit" : "credit"} {formatInr(Math.abs(netDebit), 2)} per lot
              </>
            )}
          </span>
          <button className="link-btn" onClick={() => chain.reload()} disabled={chain.refreshing}>
            {chain.refreshing ? "Refreshing…" : "Refresh prices"}
          </button>
        </div>
      )}

      {primaryLeg && (
        <dl className="summary" data-testid="option-economics" style={{ marginTop: 8 }}>
          <div>
            <dt>Max profit</dt>
            <dd className="num up">
              {unlimitedProfit ? "Unlimited" : formatInr(maxProfitTotal, 2)}
              {/* Only once a real margin figure is in hand - % of a naive per-unit fund figure
                  would be misleading next to Dhan's actual, possibly-hedged-down requirement. */}
              {!unlimitedProfit && margin != null && margin > 0 && maxProfitTotal != null && (
                <span className="dim" style={{ display: "block", fontSize: 11, fontWeight: 400 }}>
                  {formatPct((maxProfitTotal / margin) * 100, 1, true)} of margin
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Max loss</dt>
            <dd className="num dn">
              {formatInr(maxLossTotal, 2)}
              {margin != null && margin > 0 && maxLossTotal != null && (
                <span className="dim" style={{ display: "block", fontSize: 11, fontWeight: 400 }}>
                  {formatPct((maxLossTotal / margin) * 100, 1, true)} of margin
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Margin needed</dt>
            <dd className="num">{marginBusy ? "Checking…" : margin != null ? formatInr(margin, 2) : "–"}</dd>
          </div>
        </dl>
      )}
      {primaryLeg && (
        <button className="link-btn" onClick={() => void checkMargin()} disabled={marginBusy || quantity == null} style={{ marginBottom: 8 }}>
          {marginBusy ? "Checking margin…" : "Check margin (Dhan)"}
        </button>
      )}
      {marginError && (
        <p className="dn" style={{ fontSize: 13, margin: "0 0 8px" }} role="alert">
          {marginError}
        </p>
      )}

      {hasSecondLeg && primaryLeg && (
        <div className="field-row" style={{ marginBottom: 12 }}>
          <label>
            <span className="dim" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
              Stop-loss (% of max loss)
            </span>
            <input type="number" min={1} max={100} value={stopPct} onChange={(e) => setStopPct(Math.max(1, Math.min(100, Number(e.target.value) || 0)))} />
          </label>
          <label>
            <span className="dim" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
              Target (% of max profit)
            </span>
            <input type="number" min={1} max={100} value={targetPct} onChange={(e) => setTargetPct(Math.max(1, Math.min(100, Number(e.target.value) || 0)))} />
          </label>
        </div>
      )}
    </div>
  );
}
