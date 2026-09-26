import type { EquityPoint, EquityStats, LiveEligibility, OptionGroup, Position, Requirement, Segment } from "../api/types";

export type CurvePoint = { date: string; equity: number };

const DAY_MS = 86_400_000;

function nextDay(ymd: string): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** The equity snapshots are SPARSE (a day with nothing open and no balance change has no
 * row), so the curve carries the last known value forward. Only the current curve counts:
 * anything before `since` (the latest reset) belongs to an earlier account life. */
export function fillEquityCurve(points: EquityPoint[], since?: string | null, through?: string): CurvePoint[] {
  const sorted = [...points]
    .filter((p) => !since || p.snapshot_date >= since)
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  if (sorted.length === 0) return [];
  const byDate = new Map(sorted.map((p) => [p.snapshot_date, p.equity]));
  const last = through && through > sorted[sorted.length - 1].snapshot_date ? through : sorted[sorted.length - 1].snapshot_date;
  const out: CurvePoint[] = [];
  let carry = sorted[0].equity;
  for (let day = sorted[0].snapshot_date; day <= last; day = nextDay(day)) {
    carry = byDate.get(day) ?? carry;
    out.push({ date: day, equity: carry });
  }
  return out;
}

/** Profit or loss of the curve against where it started: the headline number. */
export function curveChange(stats: EquityStats | null): { amount: number; pct: number } | null {
  if (!stats) return null;
  return { amount: stats.latest_equity - stats.baseline, pct: stats.return_pct };
}

export type Trade = {
  id: string;
  kind: "position" | "group";
  symbol: string;
  action: "BUY" | "SELL";
  pnl: number;
  exitTime: string;
  exitReason: string | null;
  setupTag: string | null;
  confidence: number | null;
  notes: string | null;
  reviewed: boolean;
  violation: boolean | null;
  charges: number | null;
  autoTraded: boolean;
  segment: Segment;
  /** Opened by hand (no strategy behind it): only these have a discipline review. */
  manual: boolean;
  reviewNotes: string | null;
};

/** Closed trades as a person thinks of them: an option group is ONE trade (its legs are
 * Position rows too and must never appear alongside it), rejected orders are not trades. */
export function closedTrades(positions: Position[], groups: OptionGroup[], fallbackSegment: Segment = "NSE"): Trade[] {
  const trades: Trade[] = [];
  for (const p of positions) {
    if (p.status !== "CLOSED" || p.option_group_id != null || !p.exit_time) continue;
    trades.push({
      id: p.id, kind: "position", symbol: p.symbol, action: p.action, pnl: p.pnl ?? 0, exitTime: p.exit_time,
      exitReason: p.exit_reason ?? null, setupTag: p.setup_tag ?? null, confidence: p.confidence ?? null, notes: p.notes ?? null,
      reviewed: p.reviewed_at != null, violation: p.review_violation ?? null, charges: p.charges ?? null, autoTraded: Boolean(p.auto_traded),
      segment: p.segment, manual: p.strategy_id == null, reviewNotes: p.review_notes ?? null,
    });
  }
  for (const g of groups) {
    if (g.status !== "CLOSED" || !g.exit_time) continue;
    trades.push({
      id: g.id, kind: "group", symbol: g.underlying_symbol, action: g.action, pnl: g.pnl ?? 0, exitTime: g.exit_time,
      exitReason: g.exit_reason ?? null, setupTag: g.setup_tag ?? null, confidence: g.confidence ?? null, notes: g.notes ?? null,
      reviewed: g.reviewed_at != null, violation: g.review_violation ?? null, charges: g.charges ?? null, autoTraded: Boolean(g.auto_traded),
      segment: g.segment ?? fallbackSegment, manual: g.strategy_id == null, reviewNotes: g.review_notes ?? null,
    });
  }
  return trades.sort((a, b) => b.exitTime.localeCompare(a.exitTime));
}

export type SetupRow = { tag: string; trades: number; winRatePct: number; totalPnl: number; avgPnl: number };

export const UNTAGGED = "Untagged";

/** Performance by the setup tag chosen on the ticket. Most-traded first, so the setup that
 * actually matters is at the top; a tag someone never used simply does not appear. */
export function bySetup(trades: Trade[]): SetupRow[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.setupTag?.trim() || UNTAGGED;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([tag, ts]) => {
      const total = ts.reduce((sum, t) => sum + t.pnl, 0);
      return {
        tag, trades: ts.length, winRatePct: (ts.filter((t) => t.pnl > 0).length / ts.length) * 100, totalPnl: total, avgPnl: total / ts.length,
      };
    })
    .sort((a, b) => b.trades - a.trades || a.tag.localeCompare(b.tag));
}

/** Trades the person should still review. Anything a strategy or the auto-trader opened is
 * not reviewed by hand (the server refuses it), so it never counts as owed. */
export function unreviewed(trades: Trade[]): Trade[] {
  return trades.filter((t) => !t.reviewed && t.manual && !t.autoTraded);
}

export type Graduation = { met: number; total: number; unmet: Requirement[]; eligible: boolean; enforced: boolean };

export function graduation(e: LiveEligibility): Graduation {
  const unmet = e.requirements.filter((r) => !r.met);
  return { met: e.requirements.length - unmet.length, total: e.requirements.length, unmet, eligible: e.eligible, enforced: e.enforced };
}

export type DisciplineBand = "none" | "low" | "fair" | "good";

/** Plain-language band for the 0-100 score; null score (fewer than 5 trades) is "none", not zero. */
export function disciplineBand(score: number | null): DisciplineBand {
  if (score == null) return "none";
  if (score >= 75) return "good";
  if (score >= 50) return "fair";
  return "low";
}
