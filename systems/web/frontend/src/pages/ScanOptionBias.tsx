import { getOptionLegPreview } from "../api/trade";
import { formatDay, formatInr } from "../format";
import { useResource } from "../hooks/useResource";
import type { Moneyness, Ticket } from "./tradeModel";

const STRATEGY_LABEL: Record<string, string> = {
  bull_call_spread: "Bull Call Spread",
  bear_put_spread: "Bear Put Spread",
  naked_call: "Buy Call",
  naked_put: "Buy Put",
};

// _MONEYNESS_OFFSETS' own order (option_templates.py) - ITM2 is furthest in the money, OTM2
// furthest out. The strike stepper below walks this list; it never invents a moneyness the
// backend's own templates don't already support.
const MONEYNESS_ORDER: Moneyness[] = ["ITM2", "ITM1", "ATM", "OTM1", "OTM2"];

type Props = { exchange: string; symbol: string; ticket: Ticket; onChange: (t: Ticket) => void };

/** The Scan page's own entry point into an option order - not the Trade page's Future/Option/
 * Option spread chips (see TradeTicket's hideStrategyChips): the OI-buildup card already puts the
 * put/call-buildup and PCR the person would use to form a view right above this, so what is
 * actually missing is turning "I think this goes up" into real legs, not another round of jargon
 * (naked vs spread, which moneyness) before anything concrete shows up. Picking a view sets the
 * same ticket.action a plain spot order already uses (BUY=bullish, SELL=bearish - the same field
 * a real option order carries, see execution's choose the call side vs the put side).
 *
 * The leg table below (following the classic app's manual-trading leg tables, e.g.
 * WeeklyAdvisorPage's journal-entry rows) shows the real legs a placed order would resolve to -
 * this calls the same route (as a preview, nothing is placed) so the two can never disagree.
 * Unlike that journal table, every field here maps to something this app's constrained 4-template
 * placement API can actually execute: the strike stepper moves the PRIMARY leg's moneyness (the
 * only strike-choice open_manual_option_group's real templates expose - see option_templates.py),
 * the short leg's strike always auto-derives 2 strikes further out and is shown, not editable, and
 * the checkbox on the short leg is really the naked/spread toggle (unchecking it drops the hedge
 * leg entirely) - there is no independent per-leg strike or lot control because the real order
 * genuinely has none. Expiry is deliberately display-only, not a picker - see "The Manual tab" in
 * docs/architecture.md for why an interactive expiry dropdown was removed for manual option
 * orders (GET /options/expiries proved too slow/unreliable as a blocking dependency). */
export function ScanOptionBias({ exchange, symbol, ticket: t, onChange }: Props) {
  const style: "naked" | "spread" = t.strategy === "naked" ? "naked" : "spread";
  const preview = useResource(() => getOptionLegPreview(exchange, symbol, t.action, style, t.moneyness), [exchange, symbol, t.action, style, t.moneyness]);

  const moneynessIndex = MONEYNESS_ORDER.indexOf(t.moneyness);
  const stepMoneyness = (delta: number) => {
    const next = MONEYNESS_ORDER[Math.min(MONEYNESS_ORDER.length - 1, Math.max(0, moneynessIndex + delta))];
    if (next !== t.moneyness) onChange({ ...t, moneyness: next });
  };

  const legs = preview.data?.legs ?? [];
  const primary = legs[0];
  const short = legs[1];
  const netPremium =
    primary?.premium != null && (style === "naked" || short?.premium != null)
      ? primary.premium - (style === "spread" ? (short?.premium ?? 0) : 0)
      : null;

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

      {preview.loading && (
        <p className="dim" style={{ fontSize: 13, margin: 0 }}>
          Working out the legs…
        </p>
      )}
      {preview.error && (
        <p className="dn" style={{ fontSize: 13, margin: 0 }} role="alert">
          {preview.error.message}
        </p>
      )}
      {primary && (
        <div className="card table-scroll" style={{ padding: 0 }}>
          <table className="t" data-testid="option-leg-table">
            <thead>
              <tr>
                <th aria-label="Include leg" />
                <th>Side</th>
                <th>Strike</th>
                <th>Type</th>
                <th>Expiry</th>
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
                  <span className={`pill ${primary.action === "BUY" ? "up" : "dn"}`}>{primary.action === "BUY" ? "Buy" : "Sell"}</span>
                </td>
                <td className="num">
                  <span className="chips" role="group" aria-label="Strike" style={{ display: "inline-flex" }}>
                    <button aria-label="Move strike toward in-the-money" disabled={moneynessIndex <= 0} onClick={() => stepMoneyness(-1)}>
                      −
                    </button>
                    <span style={{ padding: "0 8px" }}>{primary.strike}</span>
                    <button aria-label="Move strike toward out-of-the-money" disabled={moneynessIndex >= MONEYNESS_ORDER.length - 1} onClick={() => stepMoneyness(1)}>
                      +
                    </button>
                  </span>
                </td>
                <td>{primary.option_type}</td>
                <td className="dim">{formatDay(primary.expiry)}</td>
                <td className="num">{t.lots.trim() === "" ? "Auto" : t.lots}</td>
                <td className="num">{formatInr(primary.premium, 2)}</td>
              </tr>
              <tr>
                <td>
                  <input
                    type="checkbox"
                    checked={style === "spread"}
                    aria-label={style === "spread" ? "Remove the hedge leg (buy the option outright)" : "Add a hedge leg (defined-risk spread)"}
                    onChange={(e) => onChange({ ...t, strategy: e.target.checked ? "spread" : "naked" })}
                  />
                </td>
                {style === "spread" && short ? (
                  <>
                    <td>
                      <span className="pill dn">Sell</span>
                    </td>
                    <td className="num">
                      {short.strike} <span className="faint">(auto)</span>
                    </td>
                    <td>{short.option_type}</td>
                    <td className="dim">{formatDay(short.expiry)}</td>
                    <td className="num">{t.lots.trim() === "" ? "Auto" : t.lots}</td>
                    <td className="num">{formatInr(short.premium, 2)}</td>
                  </>
                ) : (
                  <td colSpan={6} className="dim" style={{ fontSize: 13 }}>
                    Add a hedge leg to cap the risk (a defined-risk spread) instead of buying the option outright.
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {primary && (
        <div className="row" style={{ marginTop: 8, fontSize: 13 }} data-testid="option-strategy-summary">
          <span className="dim">
            <strong style={{ color: "var(--text)" }}>{preview.data ? STRATEGY_LABEL[preview.data.strategy_type] ?? preview.data.strategy_type : ""}</strong>
            {netPremium != null && <> · Net {netPremium >= 0 ? "debit" : "credit"} {formatInr(Math.abs(netPremium), 2)} per lot</>}
          </span>
          <button className="link-btn" onClick={() => preview.reload()} disabled={preview.refreshing}>
            {preview.refreshing ? "Refreshing…" : "Refresh prices"}
          </button>
        </div>
      )}
    </div>
  );
}
