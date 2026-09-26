import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { placeOrder, type PlaceResult } from "../api/trade";
import { useProfile } from "../auth/ProfileContext";
import { formatInr, formatPrice } from "../format";
import { SETUP_TAGS } from "../pages/journalModel";
import {
  ACTION_WORD, analyzeTicket, buildOrder, checkList, favorable, optionsAvailable,
  type Action, type BuildMeta, type DayBudget, type Moneyness, type RegimeRead, type Ticket, type TicketContext,
} from "../pages/tradeModel";
import { TextField } from "./Field";

const MONEYNESS: { value: Moneyness; label: string }[] = [
  { value: "ITM2", label: "2 strikes in the money" },
  { value: "ITM1", label: "1 strike in the money" },
  { value: "ATM", label: "At the money" },
  { value: "OTM1", label: "1 strike out of the money" },
  { value: "OTM2", label: "2 strikes out of the money" },
];

const STATUS_MARK = { good: "✓", warn: "!", bad: "✕", na: "–" } as const;
const STATUS_WORD = { good: "In favour", warn: "Caution", bad: "Against", na: "Not applicable" } as const;

type Props = {
  ticket: Ticket;
  onChange: (t: Ticket) => void;
  ctx: TicketContext;
  meta: BuildMeta;
  regime: RegimeRead | null;
  budget: DayBudget;
  onPlaced: () => void;
};

/** The guided ticket: plan first (side, entry, stop, target), see the risk in rupees and what the
 * setup has going for it, then place. Everything here is a paper order: a live account never
 * reaches this component. */
export function TradeTicket({ ticket: t, onChange, ctx, meta, regime, budget, onPlaced }: Props) {
  const { guided } = useProfile();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlaceResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Ticket>(key: K, value: Ticket[K]) => {
    setResult(null);
    onChange({ ...t, [key]: value });
  };
  const a = analyzeTicket(t, ctx);
  const checks = checkList(t, a, ctx, regime, budget);
  const fav = favorable(checks);
  const stock = meta.instrument === "spot";
  const options = optionsAvailable(ctx.symbol);
  const isOption = t.strategy !== "future";
  const limit = t.orderType === "limit";

  async function submit() {
    // Re-derive from the current ticket: nothing captured from an earlier render is ever sent.
    const now = analyzeTicket(t, ctx);
    if (now.errors.length) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await placeOrder(buildOrder(t, now, ctx, meta));
      if (outcome.ok) onPlaced();
      setResult(outcome);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not place the order. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card ticket" data-testid="ticket">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>
          Paper order
        </h2>
        <span className="pill">Paper</span>
      </div>

      <div className="chips seg" role="group" aria-label="Side" style={{ margin: "12px 0" }}>
        {(["BUY", "SELL"] as Action[]).map((s) => (
          <button key={s} className={s === "BUY" ? "buy" : "sell"} aria-pressed={t.action === s} onClick={() => set("action", s)}>
            {ACTION_WORD(s)}
          </button>
        ))}
      </div>

      {options && (
        <div className="chips" role="group" aria-label="What to trade" style={{ marginBottom: 12 }}>
          <button aria-pressed={t.strategy === "future"} onClick={() => set("strategy", "future")}>
            Future
          </button>
          <button aria-pressed={t.strategy === "naked"} onClick={() => set("strategy", "naked")}>
            Option
          </button>
          <button aria-pressed={t.strategy === "spread"} onClick={() => set("strategy", "spread")}>
            Option spread
          </button>
        </div>
      )}
      {isOption && (
        <label className="select-field" style={{ marginBottom: 12 }}>
          <span className="dim">Strike</span>
          <select value={t.moneyness} onChange={(e) => set("moneyness", e.target.value as Moneyness)}>
            {MONEYNESS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="chips" role="group" aria-label="Order type" style={{ marginBottom: 12 }}>
        <button aria-pressed={!limit} onClick={() => set("orderType", "market")}>
          Market
        </button>
        <button aria-pressed={limit} onClick={() => set("orderType", "limit")}>
          Wait for a price
        </button>
      </div>

      {limit && (
        <TextField id="t-entry" label="Enter when the price reaches" value={t.entry} onChange={(v) => set("entry", v)} hint={guided ? `It fires the first time the price crosses this level${isOption ? " (the option is priced then)" : ""}. Watched on our servers, so it works with the app closed.` : undefined} />
      )}
      <TextField id="t-stop" label={ctx.requireStop ? "Stop-loss (required)" : "Stop-loss"} value={t.stop} onChange={(v) => set("stop", v)} hint={guided ? (isOption ? "A level of the underlying. The trade closes if the price gets there." : "Where you admit you are wrong. The trade closes there.") : undefined} />
      <TextField id="t-target" label="Target" value={t.target} onChange={(v) => set("target", v)} hint={guided ? "Optional. Where you take profit." : undefined} />
      <TextField
        id="t-lots"
        label={stock ? "Number of shares" : "Number of lots"}
        value={t.lots}
        onChange={(v) => set("lots", v)}
        placeholder={isOption || ctx.segment === "CRYPTO" ? "Sized for you" : "Auto from your risk"}
        hint={ctx.lotSize !== 1 ? `One lot is ${ctx.lotSize} units.` : undefined}
      />

      <dl className="summary" data-testid="summary">
        <div>
          <dt>Entry</dt>
          <dd className="num">{a.entry == null ? "–" : formatPrice(a.entry)}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd className="num">{a.lots == null ? "By the server" : `${a.lots}${a.lotsAuto ? " (auto)" : ""}`}</dd>
        </div>
        <div>
          <dt>You risk</dt>
          <dd className="num dn">{a.riskAmount == null ? "–" : formatInr(a.riskAmount)}</dd>
        </div>
        <div>
          <dt>You could make</dt>
          <dd className="num up">{a.rewardAmount == null ? "–" : formatInr(a.rewardAmount)}</dd>
        </div>
        <div>
          <dt>Reward to risk</dt>
          <dd className="num">{a.rr == null ? "–" : `${a.rr.toFixed(1)} : 1`}</dd>
        </div>
      </dl>

      <div className="checks" data-testid="checks">
        <div className="row" style={{ marginBottom: 6 }}>
          <strong>Before you place</strong>
          <span className="dim">
            {fav.good} of {fav.total} in favour
          </span>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {checks.map((c) => (
            <li key={c.key} className="check-item">
              <span className={`mark ${c.status}`} role="img" aria-label={STATUS_WORD[c.status]}>
                {STATUS_MARK[c.status]}
              </span>
              <span>
                {c.label}
                <span className="faint" style={{ display: "block", fontSize: 12 }}>
                  {c.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <label className="select-field" style={{ margin: "12px 0" }}>
        <span className="dim">Why this trade? (helps your review later)</span>
        <select value={t.setupTag ?? ""} onChange={(e) => set("setupTag", e.target.value || null)}>
          <option value="">Not tagged</option>
          {SETUP_TAGS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
        Confidence
      </div>
      <div className="chips" role="group" aria-label="Confidence" style={{ marginBottom: 12 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} aria-pressed={t.confidence === n} onClick={() => set("confidence", t.confidence === n ? null : n)}>
            {n}
          </button>
        ))}
      </div>

      {[...a.errors, ...a.warnings].length > 0 && (
        <ul className="hints" aria-live="polite">
          {a.errors.map((m) => (
            <li key={m} className="dn">
              {m}
            </li>
          ))}
          {a.warnings.map((m) => (
            <li key={m} style={{ color: "var(--warn)" }}>
              {m}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="notice error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {result && (
        <div className={result.ok ? "notice" : "notice error"} role={result.ok ? "status" : "alert"} style={{ marginBottom: 12 }}>
          <strong>{result.ok ? (result.kind === "pending" ? "Waiting" : "Done") : "Not placed"}</strong>
          <p style={{ margin: "4px 0 0" }}>{result.message}</p>
          {result.warning && <p style={{ margin: "4px 0 0", color: "var(--warn)" }}>{result.warning}</p>}
          {result.ok && result.kind !== "pending" && (
            <p style={{ margin: "6px 0 0" }}>
              <Link to="/portfolio?tab=positions">See it in Portfolio</Link>
            </p>
          )}
        </div>
      )}
      <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy || a.errors.length > 0} onClick={() => void submit()}>
        {busy ? "Placing…" : `${ACTION_WORD(t.action)} ${ctx.symbol}${limit ? ", wait for price" : ", paper order"}`}
      </button>
    </div>
  );
}
