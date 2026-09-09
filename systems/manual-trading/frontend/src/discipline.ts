// Discipline score - a single 0-100 read on trading HABITS (not just
// outcomes), computed entirely client-side from closed manual
// positions/groups. No new backend endpoint - see docs/architecture.md
// § "Discipline score" for the full design.
//
// Redesigned 2026-09-09 around the plan: it now scores exactly four
// things, and drops the earlier trend / timeframe / loss-budget mix.
//   1. planned          (weight 1) - was this a Limit order with a stop?
//   2. plan adherence   (weight 2) - given a plan, did you let it run
//                                    (stop / target / square-off) rather
//                                    than bailing manually? No plan (a
//                                    market order, or a limit with no
//                                    stop) scores 0 here.
//   3. plan review      (weight 2) - setup + confidence declared BEFORE
//                                    (entry snapshot) and confirmed AFTER
//                                    (still set + a note / formal review).
//   4. outcome          (weight 1) - win rate blended with realized R.
// Overall = weighted mean of the components that have data.
//
// Auto-trader fills (auto_traded) are excluded entirely - they're not a
// discretionary decision.
//
// Deliberately duplicated in shell/index.html (vanilla JS, for the header
// badge). Keep the two in sync if the formula changes.

import type { Account, Segment } from "./api";

export type DisciplineTrade = {
  segment: Segment;
  pnl: number | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  target_price: number | null;
  quantity: number | null;
  exit_time: string;
  exit_reason: string | null;
  order_type: "market" | "limit" | null;
  // Immutable snapshot of setup_tag/confidence at order time.
  entry_setup_tag: string | null;
  entry_confidence: number | null;
  // Current (editable) journal + whether the trade was reviewed after
  // close (reviewed_at set, or a free-text note left).
  setup_tag: string | null;
  confidence: number | null;
  reviewed: boolean;
  auto_traded: boolean;
};

export type DisciplineComponent = {
  // 0-1. null = no data at all for this dimension in the window (excluded
  // from the overall mean rather than counted as 0).
  rate: number | null;
  trades: number;
};

// Component weights - plan adherence and plan review are the habits most
// worth reinforcing, so they count double.
export const DISCIPLINE_WEIGHTS = { planned: 1, planAdherence: 2, planReview: 2, outcome: 1 } as const;

export type DisciplineScore = {
  score: number | null; // 0-100, null if too few trades in the window
  windowDays: number;
  windowStart: string | null; // YYYY-MM-DD, the earliest day counted
  tradeCount: number; // discretionary trades inside the window
  planned: DisciplineComponent;
  planAdherence: DisciplineComponent;
  planReview: DisciplineComponent & { beforeRate: number | null; afterRate: number | null };
  outcome: DisciplineComponent & { winRate: number | null; avgR: number | null };
};

// Minimum trades before a score is considered meaningful.
const MIN_TRADES_FOR_SCORE = 5;

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

// Walk backward from the most recent trade, collecting whole calendar
// days that actually had a trade, until `days` distinct such days are
// found - a rolling window measured in days-with-activity, so a quiet
// stretch doesn't dilute or stall it.
function windowTrades<T extends { exit_time: string }>(trades: T[], days: number): { trades: T[]; windowStart: string | null } {
  if (trades.length === 0) return { trades: [], windowStart: null };
  const sorted = [...trades].sort((a, b) => b.exit_time.localeCompare(a.exit_time));
  const activeDays: string[] = [];
  const seen = new Set<string>();
  for (const t of sorted) {
    const k = dayKey(t.exit_time);
    if (!seen.has(k)) {
      seen.add(k);
      activeDays.push(k);
      if (activeDays.length >= days) break;
    }
  }
  const cutoff = new Set(activeDays);
  return { trades: sorted.filter((t) => cutoff.has(dayKey(t.exit_time))), windowStart: activeDays[activeDays.length - 1] ?? null };
}

function meanOf(values: number[]): DisciplineComponent {
  if (values.length === 0) return { rate: null, trades: 0 };
  return { rate: values.reduce((s, v) => s + v, 0) / values.length, trades: values.length };
}

// Realized R-multiple for one trade (pnl / (|entry-stop| * qty)) - only
// meaningful for spot/future (options carry no stop_loss_price here).
function realizedR(t: DisciplineTrade): number | null {
  if (t.pnl == null || t.entry_price == null || t.stop_loss_price == null || t.quantity == null) return null;
  if (t.entry_price === t.stop_loss_price) return null;
  const risk = Math.abs(t.entry_price - t.stop_loss_price) * t.quantity;
  return risk > 0 ? t.pnl / risk : null;
}

// A "plan" = a Limit entry protected by a stop. A market order, or a
// limit with no stop, is not a plan.
function hasPlan(t: DisciplineTrade): boolean {
  return t.order_type === "limit" && t.stop_loss_price != null;
}

// Declared the setup + confidence up front (the immutable entry snapshot).
function declaredBefore(t: DisciplineTrade): boolean {
  return t.entry_setup_tag != null && t.entry_setup_tag !== "" && t.entry_confidence != null;
}

// Reviewed it afterwards: the (editable) journal is filled in AND the
// trade was actually revisited (a note left, or the formal review done).
function reviewedAfter(t: DisciplineTrade): boolean {
  return t.reviewed && t.setup_tag != null && t.setup_tag !== "" && t.confidence != null;
}

export function computeDisciplineScore(
  allTrades: DisciplineTrade[],
  _accounts: Account[],
  days: number,
): DisciplineScore {
  const trades = allTrades.filter((t) => !t.auto_traded);
  const { trades: windowed, windowStart } = windowTrades(trades, days);

  // 1. Planned: rate of Limit-with-a-stop entries.
  const planned = meanOf(windowed.map((t) => (hasPlan(t) ? 1 : 0)));

  // 2. Plan adherence: no plan -> 0; a plan you bailed on (closed manually
  //    before the stop/target could) -> 0.4; a plan you let run -> 1.
  const planAdherence = meanOf(
    windowed.map((t) => {
      if (!hasPlan(t)) return 0;
      return t.exit_reason === "manual" ? 0.4 : 1;
    }),
  );

  // 3. Plan review: half for a before, half for an after.
  const beforeFlags: number[] = windowed.map((t) => (declaredBefore(t) ? 1 : 0));
  const afterFlags: number[] = windowed.map((t) => (reviewedAfter(t) ? 1 : 0));
  const beforeRate = beforeFlags.length ? beforeFlags.reduce((s, v) => s + v, 0) / beforeFlags.length : null;
  const afterRate = afterFlags.length ? afterFlags.reduce((s, v) => s + v, 0) / afterFlags.length : null;
  const planReview = {
    ...meanOf(windowed.map((t) => 0.5 * (declaredBefore(t) ? 1 : 0) + 0.5 * (reviewedAfter(t) ? 1 : 0))),
    beforeRate,
    afterRate,
  };

  // 4. Outcome: win rate blended with realized R (avgR/2 clamped to
  //    0..1 - "2R average" maxes that half out).
  const withPnl = windowed.filter((t) => t.pnl != null);
  const winRate = withPnl.length > 0 ? withPnl.filter((t) => (t.pnl as number) > 0).length / withPnl.length : null;
  const rValues = windowed.map(realizedR).filter((r): r is number => r != null);
  const avgR = rValues.length > 0 ? rValues.reduce((s, r) => s + r, 0) / rValues.length : null;
  let outcomeRate: number | null = null;
  if (winRate != null && avgR != null) {
    outcomeRate = 0.5 * winRate + 0.5 * Math.max(0, Math.min(1, avgR / 2));
  } else if (winRate != null) {
    outcomeRate = winRate;
  }
  const outcome = { rate: outcomeRate, trades: withPnl.length, winRate, avgR };

  const parts: { rate: number; w: number }[] = [];
  if (planned.rate != null) parts.push({ rate: planned.rate, w: DISCIPLINE_WEIGHTS.planned });
  if (planAdherence.rate != null) parts.push({ rate: planAdherence.rate, w: DISCIPLINE_WEIGHTS.planAdherence });
  if (planReview.rate != null) parts.push({ rate: planReview.rate, w: DISCIPLINE_WEIGHTS.planReview });
  if (outcome.rate != null) parts.push({ rate: outcome.rate, w: DISCIPLINE_WEIGHTS.outcome });
  const totalW = parts.reduce((s, p) => s + p.w, 0);
  const score =
    windowed.length >= MIN_TRADES_FOR_SCORE && totalW > 0
      ? Math.round((parts.reduce((s, p) => s + p.rate * p.w, 0) / totalW) * 100)
      : null;

  return { score, windowDays: days, windowStart, tradeCount: windowed.length, planned, planAdherence, planReview, outcome };
}

// Colour band for a score - shared by the header badge and the gauge.
export function disciplineColor(score: number | null): string {
  if (score == null) return "dim";
  if (score >= 75) return "good";
  if (score >= 50) return "warn";
  return "bad";
}
