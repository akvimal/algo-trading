import { getOptionLegPreview } from "../api/trade";
import { formatDay } from "../format";
import { useResource } from "../hooks/useResource";
import type { Ticket } from "./tradeModel";

const STRATEGY_LABEL: Record<string, string> = {
  bull_call_spread: "Bull Call Spread",
  bear_put_spread: "Bear Put Spread",
  naked_call: "Buy Call",
  naked_put: "Buy Put",
};

type Props = { exchange: string; symbol: string; ticket: Ticket; onChange: (t: Ticket) => void };

/** The Scan page's own entry point into an option order - not the Trade page's Future/Option/
 * Option spread chips (see TradeTicket's hideStrategyChips): the OI-buildup card already puts the
 * put/call-buildup and PCR the person would use to form a view right above this, so what is
 * actually missing is turning "I think this goes up" into real legs, not another round of jargon
 * (naked vs spread, which moneyness) before anything concrete shows up. Picking a view sets the
 * same ticket.action a plain spot order already uses (BUY=bullish, SELL=bearish - the same field
 * a real option order carries, see execution's choose the call side vs the put side); the style
 * toggle below it is genuinely a second, independent choice (defined-risk vs simplicity), not
 * jargon on its own. The legs shown are the real ones a placed order would resolve to - this
 * calls the same route (as a preview, nothing is placed) so the two can never disagree. */
export function ScanOptionBias({ exchange, symbol, ticket: t, onChange }: Props) {
  const style: "naked" | "spread" = t.strategy === "naked" ? "naked" : "spread";
  const preview = useResource(() => getOptionLegPreview(exchange, symbol, t.action, style, t.moneyness), [exchange, symbol, t.action, style, t.moneyness]);

  return (
    <div style={{ marginBottom: 12 }}>
      <label className="dim" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
        Your view on {symbol}
      </label>
      <div className="chips" role="group" aria-label="Your view">
        <button aria-pressed={t.action === "BUY"} onClick={() => onChange({ ...t, action: "BUY" })}>
          Bullish
        </button>
        <button aria-pressed={t.action === "SELL"} onClick={() => onChange({ ...t, action: "SELL" })}>
          Bearish
        </button>
      </div>
      <div className="chips" role="group" aria-label="Strategy style" style={{ margin: "8px 0" }}>
        <button aria-pressed={style === "spread"} onClick={() => onChange({ ...t, strategy: "spread" })}>
          Defined-risk spread
        </button>
        <button aria-pressed={style === "naked"} onClick={() => onChange({ ...t, strategy: "naked" })}>
          Just buy the option
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
      {preview.data && (
        <p className="dim" style={{ fontSize: 13, margin: 0 }} data-testid="option-leg-preview">
          <strong style={{ color: "var(--text)" }}>{STRATEGY_LABEL[preview.data.strategy_type] ?? preview.data.strategy_type}</strong>
          {`, exp ${formatDay(preview.data.expiry)} — `}
          {preview.data.legs.map((l) => `${l.action === "BUY" ? "Buy" : "Sell"} ${l.strike} ${l.option_type}`).join(", ")}
        </p>
      )}
    </div>
  );
}
