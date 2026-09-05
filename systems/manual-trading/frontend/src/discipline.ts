// Discipline score - a single 0-100 read on trading HABITS (not just
// outcomes), computed entirely client-side from data every consumer
// already has: closed manual positions/groups (trend_followed,
// risk_managed, pnl, stop_loss_price, entry_interval) and each segment's
// own max_daily_loss/default_interval/default_higher_interval. No new
// backend endpoint - see docs/architecture.md § "Discipline score" /
// "Timeframe consistency" for the full design + why.
//
// Deliberately duplicated in shell/index.html (vanilla JS, for the header
// badge) rather than shared - shell is a separate static app with no
// build step of its own, same "small enough that copying beats adding a
// cross-system frontend dependency" precedent as SignalNotifier. Keep the
// two in sync if the formula changes.

import type { Account, ChartInterval, Segment } from "./api";

export type DisciplineTrade = {
  segment: Segment;
  pnl: number | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  quantity: number | null;
  exit_time: string;
  trend_followed: boolean | null;
  risk_managed: boolean | null;
  // The chart interval this trade was placed on - null for a
  // Strategy-driven trade or one placed before this field existed.
  entry_interval: ChartInterval | null;
};

export type DisciplineComponent = {
  // 0-1. null = not enough tracked data to judge this dimension at all
  // (excluded from the overall average rather than counted as 0 - an
  // untracked dimension isn't a discipline FAILURE, it's just unknown).
  rate: number | null;
  trades: number; // how many trades this rate is based on
};

export type DisciplineScore = {
  score: number | null; // 0-100, null if too few trades in the window
  windowDays: number;
  windowStart: string | null; // YYYY-MM-DD, the earliest day counted
  tradeCount: number; // trades actually inside the window
  trend: DisciplineComponent;
  riskManaged: DisciplineComponent;
  lossDiscipline: DisciplineComponent & { days: number };
  outcome: DisciplineComponent & { winRate: number | null; avgR: number | null };
  // Rate of trades placed on the segment's own declared default_interval
  // OR its paired default_higher_interval (trading either leg of your own
  // declared pair counts as consistent - only an undeclared third
  // timeframe counts as drift). null (excluded) whenever the segment has
  // no default configured, or the trade predates entry_interval.
  timeframe: DisciplineComponent;
};

// Minimum trades before a score is considered meaningful - a 1-trade
// "100%" is noise, not a habit.
const MIN_TRADES_FOR_SCORE = 5;

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

// Walk backward from the most recent trade, collecting whole calendar
// days that actually had a trade, until `days` distinct such days are
// found (or trades run out) - per the user's own framing: a rolling
// window measured in days-with-activity, not calendar days, so a quiet
// stretch (weekend, a week off) doesn't dilute or stall the window.
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

function rateOf(flags: (boolean | null)[]): DisciplineComponent {
  const known = flags.filter((f): f is boolean => f != null);
  if (known.length === 0) return { rate: null, trades: 0 };
  return { rate: known.filter(Boolean).length / known.length, trades: known.length };
}

// Realized R-multiple for one trade - same calc ManualStatsPage's own
// `breakdown()` uses (pnl / (|entry-stop| * qty)). Only meaningful for
// spot/future (options carry no stop_loss_price here - see ClosedTrade's
// own comment in ManualStatsPage.tsx).
function realizedR(t: DisciplineTrade): number | null {
  if (t.pnl == null || t.entry_price == null || t.stop_loss_price == null || t.quantity == null) return null;
  if (t.entry_price === t.stop_loss_price) return null;
  const risk = Math.abs(t.entry_price - t.stop_loss_price) * t.quantity;
  return risk > 0 ? t.pnl / risk : null;
}

export function computeDisciplineScore(trades: DisciplineTrade[], accounts: Account[], days: number): DisciplineScore {
  const { trades: windowed, windowStart } = windowTrades(trades, days);

  const trend = rateOf(windowed.map((t) => t.trend_followed));
  const riskManaged = rateOf(windowed.map((t) => t.risk_managed));

  // Loss-budget discipline: for each segment with a configured
  // max_daily_loss, group this window's trades by (segment, day) and
  // check whether that day's realized pnl stayed within the cap. Rate =
  // days that held / days with a cap AND at least one trade.
  const capBySegment = new Map(accounts.filter((a) => a.max_daily_loss != null).map((a) => [a.segment, a.max_daily_loss as number]));
  const dailyPnl = new Map<string, number>(); // `${segment}|${day}` -> pnl
  for (const t of windowed) {
    if (t.pnl == null || !capBySegment.has(t.segment)) continue;
    const key = `${t.segment}|${dayKey(t.exit_time)}`;
    dailyPnl.set(key, (dailyPnl.get(key) ?? 0) + t.pnl);
  }
  let daysWithin = 0;
  for (const [key, pnl] of dailyPnl) {
    const segment = key.split("|")[0] as Segment;
    const cap = capBySegment.get(segment)!;
    if (pnl >= -cap) daysWithin += 1;
  }
  const lossDiscipline = {
    rate: dailyPnl.size > 0 ? daysWithin / dailyPnl.size : null,
    trades: windowed.filter((t) => capBySegment.has(t.segment) && t.pnl != null).length,
    days: dailyPnl.size,
  };

  // Outcome: win rate (any closed trade with a pnl), blended with realized
  // R for the subset that has a real stop-loss distance to measure it
  // against. avgR is clamped into 0..1 via /2 (an average of "2R" per
  // trade maxes this half out - a deliberately loose bar, not a
  // universal risk-management standard) so it combines cleanly with the
  // 0..1 win rate; avgR itself (unclamped) is reported separately too.
  const withPnl = windowed.filter((t) => t.pnl != null);
  const winRate = withPnl.length > 0 ? withPnl.filter((t) => (t.pnl as number) > 0).length / withPnl.length : null;
  const rValues = windowed.map(realizedR).filter((r): r is number => r != null);
  const avgR = rValues.length > 0 ? rValues.reduce((s, r) => s + r, 0) / rValues.length : null;
  let outcomeRate: number | null = null;
  if (winRate != null && avgR != null) {
    outcomeRate = 0.5 * winRate + 0.5 * Math.max(0, Math.min(1, avgR / 2));
  } else if (winRate != null) {
    outcomeRate = winRate; // no stop-loss data at all in this window (e.g. all options)
  }
  const outcome = { rate: outcomeRate, trades: withPnl.length, winRate, avgR };

  // Timeframe consistency: did this trade land on the segment's own
  // declared default_interval, or its paired default_higher_interval?
  // Both count as "on plan" - the whole point of suggesting a pair is
  // that trading either leg of it is fine, only an undeclared third
  // interval counts as drift. A segment with no default configured
  // contributes nothing either way (not a failure, just untracked).
  const defaultsBySegment = new Map(
    accounts.filter((a) => a.default_interval != null).map((a) => [a.segment, a]),
  );
  const timeframeFlags = windowed
    .filter((t) => t.entry_interval != null && defaultsBySegment.has(t.segment))
    .map((t) => {
      const acct = defaultsBySegment.get(t.segment)!;
      return t.entry_interval === acct.default_interval || t.entry_interval === acct.default_higher_interval;
    });
  const timeframe = rateOf(timeframeFlags);

  const components = [trend.rate, riskManaged.rate, lossDiscipline.rate, outcome.rate, timeframe.rate].filter(
    (r): r is number => r != null,
  );
  const score =
    windowed.length >= MIN_TRADES_FOR_SCORE && components.length > 0
      ? Math.round((components.reduce((s, r) => s + r, 0) / components.length) * 100)
      : null;

  return { score, windowDays: days, windowStart, tradeCount: windowed.length, trend, riskManaged, lossDiscipline, outcome, timeframe };
}

// Colour band for a score - shared by the header badge and the gauge.
export function disciplineColor(score: number | null): string {
  if (score == null) return "dim";
  if (score >= 75) return "good";
  if (score >= 50) return "warn";
  return "bad";
}
