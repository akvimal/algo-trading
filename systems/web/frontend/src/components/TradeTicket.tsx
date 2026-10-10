import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { placeOrder, type PlaceResult } from "../api/trade";
import { useProfile } from "../auth/ProfileContext";
import { formatInr, formatPrice } from "../format";
import { NOTES_MAX, SETUP_TAGS, TRIGGERS } from "../pages/journalModel";
import {
  ACTION_WORD, PLAN_KINDS, analyzeTicket, buildOrder, checkList, cryptoLeverage, effectiveTicket, marketStateOf, optionsAvailable, planAvailable, planHint, planNudges, planRows,
  planSide, planStatus,
  type Action, type BuildMeta, type DayBudget, type MarketState, type Moneyness, type PlanKind, type RegimeRead, type Ticket, type TicketContext,
} from "../pages/tradeModel";
import type { PriceField } from "../chart/ChartPane";
import { CrosshairIcon, SparkIcon } from "../chart/icons";
import type { Pretrade } from "../api/types";
import { TextField, type FieldStatus } from "./Field";
import { Popover } from "../chart/Popover";
import { BoltIcon, BreakoutIcon, BuyIcon, ClockIcon, FutureIcon, OptionIcon, PullbackIcon, RangingIcon, ReversalIcon, SellIcon, SpreadIcon, TrendingIcon } from "./BadgeIcons";

const MONEYNESS: { value: Moneyness; label: string }[] = [
  { value: "ITM2", label: "2 strikes in the money" },
  { value: "ITM1", label: "1 strike in the money" },
  { value: "ATM", label: "At the money" },
  { value: "OTM1", label: "1 strike out of the money" },
  { value: "OTM2", label: "2 strikes out of the money" },
];

const STATUS_MARK = { good: "✓", warn: "!", bad: "✕", na: "–", info: "·" } as const;
const PLAN_ICON = { pullback: <PullbackIcon />, breakout: <BreakoutIcon />, reversal: <ReversalIcon /> } as const;
const STATUS_WORD = { good: "In favour", warn: "Caution", bad: "Against", na: "Not applicable", info: "For information" } as const;

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
  /** What today looks like (a cooldown running, trades so far against the cap, room under the loss limit); left out where the page does not load it. */
  today?: Pretrade | null;
  /** The price "Suggest" first put on each field: once the person has changed it, a way back to that suggestion. */
  suggested?: Partial<Record<PriceField, number>>;
  /** What the person already holds open on this instrument (e.g. "1 open NIFTY position"), if anything:
   * the ticket warns before a second order is placed on top of it. */
  holding?: string | null;
  /** A waiting order already on this instrument (a short description, and a way to cancel it): the order button stays off until the person cancels it or says they want a second one. */
  waitingHere?: { text: string; cancel: () => void } | null;
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
  /** Drops Stop-loss and Target (except for a "Wait for a price" order, which needs them as levels of the underlying), Lots, the Entry/Size/risk
   * summary, "Before you place" and Confidence for an OPTION order only. Order type (Market/"Wait for a price") stays: a waiting order is how an
   * option is queued while the market is closed (a plain spot/future
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
  /** Takes a picture of the chart as it is now, for keeping with the trade as its plan at entry: called just before the order is sent, so it shows
   * the person's drawings and indicators and the planned entry, stop and target. Returns a finished PNG data URL, or null when it cannot. */
  capturePlan?: (levels: { entry: number | null; stop: number | null; target: number | null }) => Promise<string | null>;
};

/** The guided ticket: plan first (side, entry, stop, target), see the risk in rupees and what the
 * setup has going for it, then place. Everything here is a paper order: a live account never
 * reaches this component. */
export function TradeTicket({ ticket: raw, onChange, ctx, meta, regime, budget, pickField = null, onPickField, onAddLine, today = null, suggested = {}, holding = null, waitingHere = null, onPlaced, optionsForced, hideStrategyChips, hideMoneynessField, hideOptionExtras, hideSideChips, capturePlan }: Props) {
  const { guided } = useProfile();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlaceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [another, setAnother] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null); // what changing the side just took off the form, until the next edit
  useEffect(() => {
    if (!waitingHere) setAnother(false);
  }, [waitingHere]);

  // The stored ticket is what the person typed; the one everything below works from has its label derived from the plan (see effectiveTicket).
  const t = effectiveTicket(raw, regime);
  const set = <K extends keyof Ticket>(key: K, value: Ticket[K]) => {
    setResult(null);
    setCleared(null);
    onChange({ ...raw, [key]: value });
  };
  // Buy <-> Sell: an entry, stop and target belong to one side (a buy's stop is below its entry, a sell's above), so on the other side they are
  // wrong, and a stop left on the wrong side is refused or, worse, closes the trade at once. Changing the side takes them off the form and says so;
  // `extra` rides along in the same change (a plan that implies the side also sets itself). Choosing the side already chosen changes nothing.
  const setSide = (side: Action, extra: Partial<Ticket> = {}) => {
    setResult(null);
    if (side === raw.action) {
      onChange({ ...raw, ...extra });
      return;
    }
    const had = [
      raw.orderType === "limit" && raw.entry.trim() !== "" ? "the entry price" : null,
      raw.stop.trim() !== "" ? "the stop-loss" : null,
      raw.target.trim() !== "" ? "the target" : null,
    ].filter((x): x is string => x != null);
    onChange({ ...raw, ...extra, action: side, entry: "", stop: "", target: "" });
    setCleared(had.length ? `Cleared ${had.length === 1 ? had[0] : `${had.slice(0, -1).join(", ")} and ${had[had.length - 1]}`}: ${had.length === 1 ? "it was" : "they were"} set for a ${raw.action === "BUY" ? "buy" : "sell"}.` : null);
  };
  const read = marketStateOf(regime); // what the regime badge says; null while it is changing or unavailable
  const state: MarketState | null = raw.planState ?? read;
  // Choosing a market state the plan cannot live in (a pullback in a range) clears the plan; choosing a plan puts the side it implies and, the first
  // time for a pullback or reversal, a "wait for a price" entry (they enter at a zone; a breakout can be taken as it goes), both still the person's to change.
  const chooseState = (s: MarketState) => {
    setResult(null);
    const next = s === read ? null : s; // choosing what the read already says is following it, not a pin
    onChange({ ...raw, planState: next, planKind: raw.planKind && !planAvailable(s, raw.planKind) ? null : raw.planKind });
  };
  // "Trending" on its own: the read's direction if it is a trend, else up (the ↑|↓ switch beside it changes it).
  const chooseTrending = () => chooseState(read === "trending_up" || read === "trending_down" ? read : (raw.planState === "trending_down" ? "trending_down" : "trending_up"));
  const trending = state === "trending_up" || state === "trending_down";
  const choosePlan = (kind: PlanKind) => {
    setResult(null);
    if (raw.planKind === kind) return onChange({ ...raw, planKind: null });
    const side = planSide(state, kind);
    const sideOk = side != null && !(hideSideChips && side === "SELL");
    const extra: Partial<Ticket> = {
      planKind: kind,
      ...(kind !== "breakout" && raw.planKind == null && raw.orderType === "market" && raw.entry.trim() === "" && !(Boolean(hideOptionExtras) && t.strategy !== "future") ? { orderType: "limit" as const } : {}),
    };
    if (sideOk) setSide(side, extra);
    else onChange({ ...raw, ...extra });
  };
  const a = analyzeTicket(t, ctx);
  const lev = ctx.segment === "CRYPTO" ? cryptoLeverage(a.entry, t.action === "BUY", ctx.leverage ?? 1) : null;
  const checks = checkList(t, a, ctx, regime, budget);
  const fieldValue: Record<PriceField, string> = { entry: t.entry, stop: t.stop, target: t.target };
  const pickAction = (f: PriceField) =>
    onPickField ? (
      <span className="field-actions">
        {onAddLine && fieldValue[f].trim() === "" && ctx.price != null && (
          <button className="link-btn with-icon" aria-label={`Add ${f} line`} title="Suggest a price from the chart's typical move and put its line on the chart, then drag it" onClick={() => onAddLine(f)}>
            <SparkIcon />
            Suggest
          </button>
        )}
        {suggested[f] != null && fieldValue[f].trim() !== "" && fieldValue[f] !== String(suggested[f]) && pickField !== f && (
          <button className="link-btn" aria-label={`Back to suggested ${f}`} title={`Put it back to the price first suggested (${formatPrice(suggested[f]!)})`} onClick={() => set(f, String(suggested[f]))}>
            Revert
          </button>
        )}
        {fieldValue[f].trim() !== "" && pickField !== f && (
          <button className="link-btn" aria-label={`Reset ${f}`} title="Clear this price and take its line off the chart" onClick={() => set(f, "")}>
            Reset
          </button>
        )}
        <button className="link-btn with-icon" aria-label={pickField === f ? "Click the chart…" : "Pick on chart"} title="Click the chart to set it there" aria-pressed={pickField === f} onClick={() => onPickField(pickField === f ? null : f)}>
          <CrosshairIcon />
          {pickField === f ? "Click chart…" : "Pick"}
        </button>
      </span>
    ) : undefined;
  const marketRead = checks.filter((c) => c.key === "regime" || c.key === "trend");
  // The plan rows for the three fields (stop, size, reward) now sit on the fields themselves, as a mark beside the label: the same words, the same
  // status, so the plan block below keeps only what is not about a field.
  const allRows = planRows(t, a, ctx, today);
  // The stop and the target carry the mark alone (its tooltip has the words; the plan chip above already says "stop set, reward unplanned" and the
  // R:R against the minimum): no line under their inputs. The size field still says why under it.
  const fieldStatus = (key: "stop" | "size" | "reward"): FieldStatus | undefined => {
    const r = allRows.find((x) => x.key === key);
    return r ? { tone: r.status, text: r.detail, quiet: key !== "size" } : undefined;
  };
  const stock = meta.instrument === "spot";
  const options = optionsForced ?? optionsAvailable(ctx.symbol);
  const instrumentChoices: { value: Ticket["strategy"]; label: string; icon: JSX.Element }[] = [
    { value: "future", label: stock ? "Spot" : "Future", icon: <FutureIcon /> },
    { value: "naked", label: "Option", icon: <OptionIcon /> },
    { value: "spread", label: "Option spread", icon: <SpreadIcon /> },
  ];
  const current = instrumentChoices.find((c) => c.value === t.strategy);
  const instrumentLabel = current?.label ?? "Credit spread";
  const instrumentIcon = current?.icon ?? <SpreadIcon />;
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
      // The chart is photographed BEFORE the order goes: it still shows the plan lines (entry, stop, target) the person drew the trade on.
      let planPicture: string | null = null;
      if (capturePlan) {
        try {
          planPicture = await capturePlan({ entry: now.entry, stop: now.stop, target: now.target });
        } catch {
          planPicture = null; // a picture that cannot be taken never stops the order
        }
      }
      const outcome = await placeOrder(buildOrder(t, now, ctx, meta), { planPicture });
      if (outcome.ok) onPlaced();
      setResult(outcome);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not place the order. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // While an order is waiting on this instrument the form folds away: the waiting order is the plan, and the form only comes back
  // when the person says they really want another.
  if (waitingHere && !another) {
    return (
      <div className="card ticket" data-testid="ticket">
        <div className="row">
          <h2 className="section-title" style={{ margin: 0 }}>
            Paper order
          </h2>
          <span className="pill">Paper</span>
        </div>
        {result && (
          <div className={result.ok ? "notice" : "notice error"} role={result.ok ? "status" : "alert"} style={{ marginTop: 10 }}>
            <strong>{result.ok ? (result.kind === "pending" ? "Waiting" : "Done") : "Not placed"}</strong>
            <p style={{ margin: "4px 0 0" }}>{result.message}</p>
            {result.warning && <p style={{ margin: "4px 0 0", color: "var(--warn)" }}>{result.warning}</p>}
          </div>
        )}
        <div className="stack-notice" role="note" data-testid="waiting-notice" style={{ marginTop: 10 }}>
          <b>{result?.ok && result.kind === "pending" ? "Placed: " : "You already have "}{waitingHere.text}.</b> The form is folded away so it is not a second thought away from the plan.
          <div className="row" style={{ marginTop: 8, gap: 12, justifyContent: "flex-start" }}>
            <button className="btn btn-small" onClick={waitingHere.cancel}>
              Cancel the waiting order
            </button>
            <button className="link-btn" onClick={() => setAnother(true)}>
              Place another order
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card ticket" data-testid="ticket">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>
          Paper order
        </h2>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {/* Future / Option / Option spread: the person's default (More > Experience) is what the ticket opens on, and this badge changes it for the
              one trade. It is a menu in the header instead of a row of its own, and only where options exist. */}
          {options && !hideStrategyChips && (
            <Popover label="What to trade" text={instrumentLabel} icon={instrumentIcon} buttonLabel={`What to trade: ${instrumentLabel}`} align="right">
              {(close) => (
                <div className="chips instrument-menu" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  {instrumentChoices.map((c) => (
                    <button
                      key={c.value}
                      aria-pressed={t.strategy === c.value}
                      onClick={() => {
                        set("strategy", c.value);
                        close();
                      }}
                    >
                      {c.icon}
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
          )}
          <span className="pill">Paper</span>
        </span>
      </div>

      {!simplifiedOption && (
        <div className="plan-pick" data-testid="plan-pick" style={{ margin: "12px 0" }}>
          <div className="chips" role="group" aria-label="Market state">
            {/* Trending | Ranging is one toggle (two joined segments, one pressed); the up/down switch is a second, joined pair that only
                appears beside it while Trending is the one pressed (a range has no direction). */}
            <span className="badge-split">
              <button aria-pressed={trending} onClick={chooseTrending}>
                <TrendingIcon />
                Trending
              </button>
              <button aria-pressed={state === "ranging"} onClick={() => chooseState("ranging")}>
                <RangingIcon />
                Ranging
              </button>
            </span>
            {trending && (
              <span className="badge-split badge-dir" role="group" aria-label="Trend direction">
                <button aria-label="Up" aria-pressed={state === "trending_up"} onClick={() => chooseState("trending_up")}>
                  ↑
                </button>
                <button aria-label="Down" aria-pressed={state === "trending_down"} onClick={() => chooseState("trending_down")}>
                  ↓
                </button>
              </span>
            )}
          </div>
          <div className="faint" style={{ fontSize: 12, margin: "4px 0 8px" }} data-testid="market-state-source">
            {raw.planState != null && raw.planState !== read ? "Your read." : read != null ? `From the regime read${regime ? ` (ADX ${Math.round(regime.adx)})` : ""}. Tap another to change it.` : "No clear read right now: choose what the market is doing."}
          </div>
          <div className="chips" role="group" aria-label="Plan">
            {PLAN_KINDS.map((k) => (
              <button key={k.value} aria-pressed={raw.planKind === k.value} disabled={!planAvailable(state, k.value)} title={!planAvailable(state, k.value) ? "A pullback needs a trend." : undefined} onClick={() => choosePlan(k.value)}>
                {PLAN_ICON[k.value]}
                {k.label}
              </button>
            ))}
          </div>
          {raw.planKind && (
            <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }} data-testid="plan-hint">
              {t.setupTag && state ? <b>{t.setupTag}. </b> : null}
              {planHint(state, raw.planKind)}
            </p>
          )}
        </div>
      )}

      {!hideSideChips && !(hideStrategyChips && isOption) && (
        <div className="chips seg" role="group" aria-label="Side" style={{ margin: "12px 0" }}>
          {(["BUY", "SELL"] as Action[]).map((s) => (
            <button key={s} className={s === "BUY" ? "buy" : "sell"} aria-pressed={t.action === s} onClick={() => setSide(s)}>
              {s === "BUY" ? <BuyIcon /> : <SellIcon />}
              {ACTION_WORD(s)}
            </button>
          ))}
        </div>
      )}
      {cleared && (
        <p className="faint" role="status" style={{ fontSize: 12, margin: "-6px 0 10px" }} data-testid="side-cleared">
          {cleared}
        </p>
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

      {/* Market/"Wait for a price". A simplified option order in Scan (the F&O view) gets the same choice: "Wait for a price" arms the
          order on the server at a level of the underlying, so it can be queued while the market is closed and fires in the next session.
          Its stop-loss and target are levels of the underlying too (shown below only for a waiting order); the leg table's combined
          stop-loss %/target % are taken from the premium once the position exists, so they apply to an order placed now, not a waiting one. */}
      {(
        <div className="chips" role="group" aria-label="Order type" style={{ marginBottom: 12 }}>
          <button aria-pressed={!limit} onClick={() => set("orderType", "market")}>
            <BoltIcon />
            Market
          </button>
          {/* Credit spreads (bull_put_spread/bear_call_spread) can't wait for a price yet - the
              pending-order watcher (app/domain/pending_orders.py) only knows how to build a naked/
              debit-spread leg once triggered, not a credit one. Market-only until that's built. */}
          <button aria-pressed={limit} disabled={t.strategy === "credit_spread"} title={t.strategy === "credit_spread" ? "Not yet supported for a credit spread - place at the market price instead." : undefined} onClick={() => set("orderType", "limit")}>
            <ClockIcon />
            Wait for a price
          </button>
        </div>
      )}

      {waitingHere && (
        <div className="stack-notice" role="note" data-testid="waiting-reminder">
          <b>You still have {waitingHere.text}.</b>{" "}
          <button className="link-btn" onClick={waitingHere.cancel}>
            Cancel it
          </button>{" "}
          <button className="link-btn" onClick={() => setAnother(false)}>
            Fold the form away
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
      {simplifiedOption && limit && (
        <div className="faint" style={{ fontSize: 12, marginBottom: 8 }} data-testid="waiting-option-note">
          A waiting order is placed when the price reaches your level. Set a stop-loss and target here as levels of the {ctx.symbol} price; the leg table's stop-loss and target % apply only to an order placed now.
        </div>
      )}
      {(!simplifiedOption || limit) && (
        <div className="field-row">
          <TextField id="t-stop" label={ctx.requireStop ? "Stop-loss (required)" : "Stop-loss"} action={pickAction("stop")} status={fieldStatus("stop")} value={t.stop} onChange={(v) => set("stop", v)} />
          <TextField id="t-target" label="Target" action={pickAction("target")} status={fieldStatus("reward")} value={t.target} onChange={(v) => set("target", v)} />
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
          status={fieldStatus("size")}
          onChange={(v) => set("lots", v)}
          placeholder={
            isOption || ctx.segment === "CRYPTO"
              ? "Sized for you"
              : a.lots != null && t.lots.trim() === "" ? `${a.lots} · from your ${ctx.riskPct}% risk` : "Auto from your risk"
          }
          action={
            t.lots.trim() !== "" ? (
              <button className="link-btn" title="Go back to the size worked out from your risk" onClick={() => set("lots", "")}>
                Use system size
              </button>
            ) : undefined
          }
          dimmed={t.lots.trim() === ""}
        />
      )}

      {!simplifiedOption && (
        <div className="summary-badges" data-testid="summary">
          <div className="chips">
            <span className="pill dn">
              You risk <b>{a.riskAmount == null ? "–" : formatInr(a.riskAmount)}</b>
            </span>
            <span className="pill up">
              You could make <b>{a.rewardAmount == null ? "–" : formatInr(a.rewardAmount)}</b>
            </span>
            <span className="pill">
              <b>{a.rr == null ? "–" : `${a.rr.toFixed(1)} : 1`}</b>
            </span>
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            Entry at <span className="num">{a.entry == null ? "–" : formatPrice(a.entry)}</span> · Size <span className="num">{a.lots == null ? "by the server" : `${a.lots}${a.lotsAuto ? " (auto)" : ""}`}</span>
          </div>
          {ctx.segment === "CRYPTO" && !isOption && (
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }} data-testid="crypto-note">
              {ctx.usdinr == null ? (
                <>Set the USD/INR rate in Settings: until then crypto orders are refused and the risk cannot be shown in rupees.</>
              ) : (
                <>
                  Priced in dollars, shown in rupees at ₹{ctx.usdinr}/$
                  {lev && <> · {lev.leverage}× leverage, liquidated near <span className="num">${formatPrice(lev.liquidation)}</span> ({lev.awayPct.toFixed(1)}% {t.action === "BUY" ? "below" : "above"} entry)</>}
                  {a.lots != null && a.entry != null && <> · margin about <span className="num">{formatInr(((a.lots * ctx.lotSize * a.entry) / (ctx.leverage ?? 1)) * ctx.usdinr)}</span></>}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!simplifiedOption && (
        <div className="checks plan-block" data-testid="plan-block">
          {(() => {
            const plan = planStatus(t, a, ctx);
            return (
              <div className={`plan-chip plan-head ${plan?.tone ?? ""}`} data-testid="plan-chip" role="status">
                <strong>Your plan</strong>
                <span>{plan?.text ?? ""}</span>
              </div>
            );
          })()}
          {(() => {
            // What needs attention is always shown; the rest (all fine, or only for information) folds into one line.
            const rows = allRows.filter((r) => r.key !== "stop" && r.key !== "size" && r.key !== "reward");
            const flagged = rows.filter((r) => r.status === "warn" || r.status === "bad");
            const calm = rows.filter((r) => r.status !== "warn" && r.status !== "bad");
            const line = (r: (typeof rows)[number]) => (
              <li key={r.key} className="check-item" data-testid={`plan-row-${r.key}`}>
                <span className={`mark ${r.status}`} role="img" aria-label={STATUS_WORD[r.status]}>
                  {STATUS_MARK[r.status]}
                </span>
                <span>
                  {r.label}
                  <span className="faint" style={{ display: "block", fontSize: 12 }}>
                    {r.detail}
                  </span>
                </span>
              </li>
            );
            return (
              <>
                {flagged.length > 0 && <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{flagged.map(line)}</ul>}
                {planNudges(t, a, state).map((n) => (
                  <p key={n} className="check-item" style={{ color: "var(--warn)", fontSize: 13, margin: "4px 0" }} data-testid="plan-nudge">
                    {n}
                  </p>
                ))}
                {calm.length > 0 && (
                  <details style={{ marginTop: 6 }} data-testid="plan-calm">
                    <summary className="faint" style={{ fontSize: 12 }}>
                      {flagged.length > 0 ? `${calm.length} more checks` : `All checks (${calm.length}) are fine`}
                    </summary>
                    <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>{calm.map(line)}</ul>
                  </details>
                )}
              </>
            );
          })()}
          {marketRead.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary className="faint" style={{ fontSize: 12 }}>
                Market read
              </summary>
              <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
                {marketRead.map((c) => (
                  <li key={c.key} className="check-item">
                    <span className="mark info" role="img" aria-label="For information">
                      ·
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
              <p className="faint" style={{ fontSize: 11, margin: "4px 0 0" }}>
                Information only: it is not scored and never blocks an order.
              </p>
            </details>
          )}
        </div>
      )}

      {/* Kept even in the simplified option ticket, unlike the rest of the journal prompts below
          it (Confidence) - a person asked for this back specifically: unlike Confidence, it's the
          one place to leave an actual note on WHY, not just how sure, and that's worth keeping
          even in a quick trade. */}
      {simplifiedOption && (
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
      )}
      {(() => {
        const reasonField = (
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
        );
        if (simplifiedOption) return reasonField;
        return (
          <details className="notes-fold" data-testid="ticket-notes" style={{ marginBottom: 12 }}>
            <summary className="faint" style={{ fontSize: 13, cursor: "pointer" }}>
              Notes (optional){t.trigger || t.reason.trim() || t.confidence != null ? " ·" : ""}
              {t.trigger ? ` ${t.trigger}` : ""}
              {t.confidence != null ? ` · confidence ${t.confidence}` : ""}
            </summary>
            <label className="select-field" style={{ margin: "8px 0" }}>
              <span className="dim">What did you see?</span>
              <select value={t.trigger ?? ""} onChange={(e) => set("trigger", e.target.value || null)}>
                <option value="">Not noted</option>
                {TRIGGERS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            {reasonField}
            <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
              Confidence
            </div>
            <div className="chips" role="group" aria-label="Confidence">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} aria-pressed={t.confidence === n} onClick={() => set("confidence", t.confidence === n ? null : n)}>
                  {n}
                </button>
              ))}
            </div>
          </details>
        );
      })()}

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
