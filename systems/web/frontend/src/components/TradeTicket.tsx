import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { placeOrder, type PlaceResult } from "../api/trade";
import { useProfile } from "../auth/ProfileContext";
import { formatInr, formatPrice } from "../format";
import { NOTES_MAX, SETUP_TAGS } from "../pages/journalModel";
import {
  ACTION_WORD, analyzeTicket, buildOrder, checkList, favorable, optionsAvailable,
  type Action, type BuildMeta, type DayBudget, type Moneyness, type RegimeRead, type Ticket, type TicketContext,
} from "../pages/tradeModel";
import type { PriceField } from "../chart/ChartPane";
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
  /** Which field the person is picking a price for on the chart, if any. */
  pickField?: PriceField | null;
  onPickField?: (f: PriceField | null) => void;
  /** Put a starting line for this field on the chart, to drag to the right price. */
  onAddLine?: (f: PriceField) => void;
  /** What the person already holds open on this instrument (e.g. "1 open NIFTY position"), if anything:
   * the ticket warns before a second order is placed on top of it. */
  holding?: string | null;
  onPlaced: () => void;
  /** Overrides the usual optionsAvailable(symbol) check (which only knows about the handful of
   * index/commodity/crypto PRESETS) for a caller that already knows options exist for this symbol
   * some other way - e.g. the Scan page's embedded ticket, whose rows come from the OI-buildup
   * feed and so are guaranteed to have an option chain even though they are not a PRESETS entry. */
  optionsForced?: boolean;
  /** Hides the "What to trade" (Future/Option/Option spread) chips, and, once the ticket is
   * already in an option strategy, the "Side" (Buy/Sell) chips too - for a caller that drives
   * both itself through some other UI instead (the Scan page's bias-driven option panel picks
   * Bullish/Bearish, which sets the same action/strategy fields this component already reads).
   * The Side chips stay for a plain spot/future order (isOption false) - nothing else replaces
   * them there. */
  hideStrategyChips?: boolean;
  /** Hides the "Strike" moneyness dropdown too - for a caller whose own strategy panel (the
   * Scan page's bias-driven leg table) already exposes a strike stepper wired to the same
   * ticket.moneyness field, so the two controls never fight for the same line. */
  hideMoneynessField?: boolean;
  /** Drops Order type (Market/"Wait for a price"), Stop-loss, Target, Lots, the Entry/Size/risk
   * summary, "Before you place" and Confidence for an OPTION order only (a plain spot/future
   * order keeps all of them, and "Why this trade?" stays for options too) - the Scan page's own
   * leg table already shows what's being bought/sold, its live price, the real max profit/loss/
   * margin, and its own combined stop-loss %/target % (see ScanOptionBias.tsx), all more specific
   * to an option position than this spot/future-shaped chrome (a limit order waiting for the
   * underlying, a stop-loss on the underlying's own price) would be. analyzeTicket never requires
   * a stop-loss for an option regardless of this flag - every option position here is already
   * risk-capped by construction (premium paid, or strike width), unlike a spot/future position. */
  hideOptionExtras?: boolean;
  /** Hides the "Side" (Buy/Sell) chips outright, regardless of hideStrategyChips/isOption, and
   * forces the caller to keep ticket.action at "BUY" itself (nothing here changes it back) - for a
   * plain NSE stock with no F&O, which cannot be shorted without margin/derivatives: only a long
   * (BUY) position is ever placeable there, so offering Sell would just invite a rejection later. */
  hideSideChips?: boolean;
};

/** The guided ticket: plan first (side, entry, stop, target), see the risk in rupees and what the
 * setup has going for it, then place. Everything here is a paper order: a live account never
 * reaches this component. */
export function TradeTicket({ ticket: t, onChange, ctx, meta, regime, budget, pickField = null, onPickField, onAddLine, holding = null, onPlaced, optionsForced, hideStrategyChips, hideMoneynessField, hideOptionExtras, hideSideChips }: Props) {
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
  const fieldValue: Record<PriceField, string> = { entry: t.entry, stop: t.stop, target: t.target };
  const pickAction = (f: PriceField) =>
    onPickField ? (
      <span className="field-actions">
        {onAddLine && fieldValue[f].trim() === "" && ctx.price != null && (
          <button className="link-btn" aria-label={`Add ${f} line`} title="Put a starting line on the chart, then drag it" onClick={() => onAddLine(f)}>
            Add line
          </button>
        )}
        {fieldValue[f].trim() !== "" && pickField !== f && (
          <button className="link-btn" aria-label={`Reset ${f}`} title="Clear this price and take its line off the chart" onClick={() => set(f, "")}>
            Reset
          </button>
        )}
        <button className="link-btn" aria-pressed={pickField === f} onClick={() => onPickField(pickField === f ? null : f)}>
          {pickField === f ? "Click the chart…" : "Pick on chart"}
        </button>
      </span>
    ) : undefined;
  const fav = favorable(checks);
  const stock = meta.instrument === "spot";
  const options = optionsForced ?? optionsAvailable(ctx.symbol);
  const isOption = t.strategy !== "future";
  const limit = t.orderType === "limit";
  const simplifiedOption = Boolean(hideOptionExtras) && isOption;

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

      {!hideSideChips && !(hideStrategyChips && isOption) && (
        <div className="chips seg" role="group" aria-label="Side" style={{ margin: "12px 0" }}>
          {(["BUY", "SELL"] as Action[]).map((s) => (
            <button key={s} className={s === "BUY" ? "buy" : "sell"} aria-pressed={t.action === s} onClick={() => set("action", s)}>
              {ACTION_WORD(s)}
            </button>
          ))}
        </div>
      )}

      {options && !hideStrategyChips && (
        <div className="chips" role="group" aria-label="What to trade" style={{ marginBottom: 12 }}>
          <button aria-pressed={t.strategy === "future"} onClick={() => set("strategy", "future")}>
            {stock ? "Spot" : "Future"}
          </button>
          <button aria-pressed={t.strategy === "naked"} onClick={() => set("strategy", "naked")}>
            Option
          </button>
          <button aria-pressed={t.strategy === "spread"} onClick={() => set("strategy", "spread")}>
            Option spread
          </button>
        </div>
      )}
      {isOption && !hideMoneynessField && (
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

      {/* Market/"Wait for a price" and the spot-based Stop-loss/Target below are a spot/future
          concept (a limit order waits for the underlying to reach a level; a spot stop-loss
          protects against the underlying moving further than expected) - for a simplified option
          order in Scan, the leg table's own Debit/Credit-aware combined stop-loss %/target %
          (ScanOptionBias.tsx) already covers this, more precisely (as a fraction of the position's
          own bounded max loss/profit, not an arbitrary underlying level). TradePage's own option
          ticket (hideOptionExtras not set there) still gets all of this, unchanged. */}
      {!simplifiedOption && (
        <div className="chips" role="group" aria-label="Order type" style={{ marginBottom: 12 }}>
          <button aria-pressed={!limit} onClick={() => set("orderType", "market")}>
            Market
          </button>
          {/* Credit spreads (bull_put_spread/bear_call_spread) can't wait for a price yet - the
              pending-order watcher (app/domain/pending_orders.py) only knows how to build a naked/
              debit-spread leg once triggered, not a credit one. Market-only until that's built. */}
          <button aria-pressed={limit} disabled={t.strategy === "credit_spread"} title={t.strategy === "credit_spread" ? "Not yet supported for a credit spread - place at the market price instead." : undefined} onClick={() => set("orderType", "limit")}>
            Wait for a price
          </button>
        </div>
      )}

      {holding && (
        <div className="stack-notice" role="note" data-testid="stacking-notice">
          <b>You already hold {holding}.</b>{" "}
          {limit ? "This waiting order will be skipped when its price is hit, unless you allow adding." : "This order opens a second position on top of it."}
          {limit && (
            <label className="check-row">
              <input type="checkbox" checked={t.allowStacking} onChange={(e) => set("allowStacking", e.target.checked)} /> Allow adding to my open position
            </label>
          )}
        </div>
      )}

      {limit && (
        <TextField id="t-entry" label="Enter when the price reaches" action={pickAction("entry")} value={t.entry} onChange={(v) => set("entry", v)} hint={guided ? `It fires the first time the price crosses this level${isOption ? " (the option is priced then)" : ""}. Watched on our servers, so it works with the app closed.` : undefined} />
      )}
      {/* Stop-loss and Target share a row - both carry the same pick-on-chart/add-line actions, so
          a two-up row gives each enough width for them (a three-up row, tried first, left too
          little for those actions next to a label - see base.css's .field-head/.field-actions
          wrap comment for the overlap that caused). Lots has no such action and a longer
          placeholder ("Auto from your risk"/"Sized for you"), so it gets the full row below
          instead of a cramped third column. No hints here (unlike Entry above): the label and
          placeholder already say what is needed, and dropping them is what kept this compact. */}
      {!simplifiedOption && (
        <div className="field-row">
          <TextField id="t-stop" label={ctx.requireStop ? "Stop-loss (required)" : "Stop-loss"} action={pickAction("stop")} value={t.stop} onChange={(v) => set("stop", v)} />
          <TextField id="t-target" label="Target" action={pickAction("target")} value={t.target} onChange={(v) => set("target", v)} />
        </div>
      )}
      {!simplifiedOption && (
        <TextField
          id="t-lots"
          // An option order is always lot-based, whatever the underlying is - stock vs index only
          // matters for a spot/future order's own units. Previously always true together (only
          // PRESETS symbols - all index/commodity/crypto - ever reached the option chips, and none
          // of those are "stock"), so this only started to matter once optionsForced (the Scan
          // page's ticket) let a stock's own option order through.
          label={isOption ? "Number of lots" : stock ? "Number of shares" : "Number of lots"}
          value={t.lots}
          onChange={(v) => set("lots", v)}
          placeholder={isOption || ctx.segment === "CRYPTO" ? "Sized for you" : "Auto from your risk"}
        />
      )}

      {!simplifiedOption && (
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
      )}

      {!simplifiedOption && (
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
      )}

      {/* Kept even in the simplified option ticket, unlike the rest of the journal prompts below
          it (Confidence) - a person asked for this back specifically: unlike Confidence, it's the
          one place to leave an actual note on WHY, not just how sure, and that's worth keeping
          even in a quick trade. */}
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
      <label className="field" style={{ marginBottom: 12 }}>
        <span className="dim">Reason (optional)</span>
        <textarea
          className="textarea"
          value={t.reason}
          maxLength={NOTES_MAX}
          rows={2}
          onChange={(e) => set("reason", e.target.value)}
          placeholder="What made you take this trade?"
        />
      </label>
      {!simplifiedOption && (
        <>
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
        </>
      )}

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
