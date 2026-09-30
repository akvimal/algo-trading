import { useEffect } from "react";
import { getExpiries, getOptionChain } from "../api/trade";
import type { OptionChainStrike, OptionLegQuote } from "../api/types";
import { formatDay, formatInr } from "../format";
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
 * Unlike the first two cuts of this panel, the leg table now works off a REAL option chain
 * (market-data's GET /options/chain), fetched once per (symbol, expiry) - not a preview-legs
 * round trip on every click. That fixes the two real usability problems the stepper-based design
 * had: it couldn't offer more than 5 fixed ITM/OTM points per leg, and every interaction paid a
 * network round trip ("Working out the legs…" on every click). With the chain in hand: Strike is
 * a real dropdown of every strike the chain actually has (any of them, not just ITM2..OTM2);
 * Expiry is a real dropdown too (own loading state, never blocks the rest of the ticket if it's
 * slow - the same reliability concern that got the old expiry dropdown removed in 2026-08-14,
 * just no longer a reason to omit ONE THAT ASKS FOR ITSELF, since nothing else here depends on
 * it); Lots is editable right in the table (one shared quantity - that's how sizing actually
 * works, both legs always trade the same lot count). Only Type/Side stay derived, not editable -
 * see legPlanFor - flipping a leg's call/put or buy/sell independent of the chosen view isn't a
 * strategy any of execution's templates can place.
 *
 * A Debit/Credit choice appears once a second leg is added: Debit (bull_call_spread/
 * bear_put_spread - pays a net premium) or Credit (bull_put_spread/bear_call_spread - receives
 * one, sized by max loss instead of cost - see execution's _spread_sizing_basis). The checkbox on
 * the second leg is the naked/spread toggle (unchecking it drops the second leg, buying the
 * option outright). */
export function ScanOptionBias({ exchange, symbol, ticket: t, onChange }: Props) {
  const style: Style = t.strategy === "naked" ? "naked" : t.strategy === "credit_spread" ? "credit_spread" : "spread";
  const hasSecondLeg = style !== "naked";
  const plan = legPlanFor(t.action, style);
  const legKey: "ce" | "pe" = plan.optionType === "CE" ? "ce" : "pe";

  const expiries = useResource(() => getExpiries(exchange, symbol), [exchange, symbol]);
  const chainExpiry = t.expiry ?? expiries.data?.[0] ?? null;
  const chain = useResource(() => getOptionChain(exchange, symbol, chainExpiry ?? ""), [exchange, symbol, chainExpiry], { enabled: chainExpiry != null });

  const strikesForType = (chain.data?.strikes ?? []).filter((s) => legQuote(s, legKey) != null);

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
    onChange({ ...t, expiry: chain.data!.expiry, primaryStrike: strikesForType[primaryIndex].strike, secondStrike: strikesForType[secondIndex].strike });
    // Re-runs only when the chain's own expiry or which side (CE/PE) we're reading changes - not
    // on every ticket edit (typing Lots, picking a different strike by hand, ...), which would
    // fight the person's own picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.data?.expiry, legKey]);

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
  const primaryPremium = primaryQuote ? legQuote(primaryQuote, legKey)!.last_price : null;
  const secondPremium = secondQuote ? legQuote(secondQuote, legKey)!.last_price : null;
  const buyPremium = plan.primaryAction === "BUY" ? primaryPremium : secondPremium;
  const sellPremium = plan.primaryAction === "SELL" ? primaryPremium : secondPremium;
  const netDebit = buyPremium != null && (plan.secondAction == null || sellPremium != null) ? buyPremium - (sellPremium ?? 0) : null;
  const strikeWidth = hasSecondLeg && t.primaryStrike != null && t.secondStrike != null ? Math.abs(t.primaryStrike - t.secondStrike) : null;
  const maxLoss = netDebit != null && netDebit < 0 && strikeWidth != null ? strikeWidth - Math.abs(netDebit) : null;

  const setStyle = (next: Style) => onChange({ ...t, strategy: next as Strategy });
  const setLots = (v: string) => onChange({ ...t, lots: v });

  return (
    <div style={{ marginBottom: 12 }}>
      <label className="dim" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
        Your view on {symbol}
      </label>
      <div className="chips" role="group" aria-label="Your view" style={{ marginBottom: 12 }}>
        <button aria-pressed={t.action === "BUY"} onClick={() => onChange({ ...t, action: "BUY" })}>
          Bullish
        </button>
        <button aria-pressed={t.action === "SELL"} onClick={() => onChange({ ...t, action: "SELL" })}>
          Bearish
        </button>
      </div>

      <label className="select-field" style={{ marginBottom: 12 }}>
        <span className="dim">Expiry</span>
        <select
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
                  <input type="number" min={1} value={t.lots} onChange={(e) => setLots(e.target.value)} placeholder="Auto" style={{ width: 64 }} />
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
                      <input type="number" min={1} value={t.lots} onChange={(e) => setLots(e.target.value)} placeholder="Auto" style={{ width: 64 }} />
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
                {maxLoss != null && <> · max loss {formatInr(maxLoss, 2)} per lot</>}
              </>
            )}
          </span>
          <button className="link-btn" onClick={() => chain.reload()} disabled={chain.refreshing}>
            {chain.refreshing ? "Refreshing…" : "Refresh prices"}
          </button>
        </div>
      )}
    </div>
  );
}
