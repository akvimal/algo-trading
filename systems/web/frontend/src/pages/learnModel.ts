import type { MistakeSummary } from "../api/types";
import { FIXED_AT, HABIT_BY_TAG, type Habit } from "./learnCatalog";

export type HabitRow = {
  habit: Habit;
  /** Reviewed trades that carried this mistake, and what they came to. */
  trades: number;
  pnl: number;
  /** Reviewed trades since the last one carrying it (0 = the latest reviewed trade had it). */
  sinceLast: number;
  /** How far through the clean run of FIXED_AT trades the person is. */
  cleanRun: number;
  fixed: boolean;
};

const LEVEL_ORDER = { study: 0, plan: 1, execution: 2 } as const;

/** The person's own mistakes as a repair list: habits still being repeated first (costliest, then most frequent), habits that have gone
 * FIXED_AT clean trades last. A tag the catalog does not know is left out rather than shown without a fix. */
export function habitRows(summary: MistakeSummary | null | undefined): HabitRow[] {
  if (!summary) return [];
  const rows: HabitRow[] = [];
  for (const [tag, cost] of Object.entries(summary.by_tag)) {
    const habit = HABIT_BY_TAG[tag];
    if (!habit) continue;
    const sinceLast = summary.trades_since_last[tag] ?? 0;
    rows.push({ habit, trades: cost.n, pnl: cost.pnl, sinceLast, cleanRun: Math.min(sinceLast, FIXED_AT), fixed: sinceLast >= FIXED_AT });
  }
  return rows.sort((a, b) => Number(a.fixed) - Number(b.fixed) || a.pnl - b.pnl || b.trades - a.trades || LEVEL_ORDER[a.habit.level] - LEVEL_ORDER[b.habit.level]);
}

/** The one habit to work on now: the earliest level among those still being repeated (an earlier failure explains the later ones), costliest first within it. */
export function focusHabit(rows: HabitRow[]): HabitRow | null {
  const open = rows.filter((r) => !r.fixed);
  if (open.length === 0) return null;
  const earliest = Math.min(...open.map((r) => LEVEL_ORDER[r.habit.level]));
  return open.filter((r) => LEVEL_ORDER[r.habit.level] === earliest)[0] ?? null;
}

/** "3 of 10 clean" while working on it, "fixed" at FIXED_AT. */
export function runLabel(r: Pick<HabitRow, "cleanRun" | "fixed">): string {
  return r.fixed ? "Fixed" : `${r.cleanRun} of ${FIXED_AT} clean`;
}
