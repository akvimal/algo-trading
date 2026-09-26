import { isToday } from "../format";
import type { Account, OptionGroup, Position } from "../api/types";

export type Mode = "intraday" | "positional" | "options";

/** Legs of an option group are Position rows too; the GROUP is what a person trades, sees
 * and squares off, so legs never appear (or count) on their own. */
export function standalonePositions(positions: Position[]): Position[] {
  return positions.filter((p) => p.option_group_id == null);
}

export function openPositions(positions: Position[]): Position[] {
  return standalonePositions(positions).filter((p) => p.status === "OPEN");
}

export function openGroups(groups: OptionGroup[]): OptionGroup[] {
  return groups.filter((g) => g.status === "OPEN");
}

export function inMode(p: Position, mode: Exclude<Mode, "options">): boolean {
  if (p.instrument_type === "option") return false;
  const intraday = (p.horizon ?? "intraday") === "intraday";
  return mode === "intraday" ? intraday : !intraday;
}

export type DayPnl = {
  realized: number;
  unrealized: number;
  total: number;
  /** Closed trades today, standalone positions and option groups together. */
  closedToday: number;
};

/** Today's profit or loss on the IST trading day: what closed today (realized) plus what
 * the open positions are worth right now (unrealized). Costs are already inside `pnl`. */
export function dayPnl(positions: Position[], groups: OptionGroup[], now: Date = new Date()): DayPnl {
  let realized = 0;
  let closedToday = 0;
  for (const p of standalonePositions(positions)) {
    if (p.status === "CLOSED" && isToday(p.exit_time, now)) {
      realized += p.pnl ?? 0;
      closedToday += 1;
    }
  }
  for (const g of groups) {
    if (g.status === "CLOSED" && isToday(g.exit_time, now)) {
      realized += g.pnl ?? 0;
      closedToday += 1;
    }
  }
  let unrealized = 0;
  for (const p of openPositions(positions)) unrealized += p.unrealized_pnl ?? 0;
  for (const g of openGroups(groups)) unrealized += g.unrealized_pnl ?? 0;
  return { realized, unrealized, total: realized + unrealized, closedToday };
}

export type LossBudget = { limit: number; used: number; fraction: number } | null;

/** How much of the day's loss allowance is used. Sums the per-segment daily-loss limits the
 * person has set; null when none is set (then nothing is shown rather than a made-up number). */
export function lossBudget(accounts: Account[], total: number): LossBudget {
  const limit = accounts.reduce((sum, a) => sum + (a.max_daily_loss ?? 0), 0);
  if (limit <= 0) return null;
  const used = Math.max(0, -total);
  return { limit, used, fraction: Math.min(1, used / limit) };
}

export function paperBalance(accounts: Account[]): number {
  return accounts.reduce((sum, a) => sum + a.current_balance + a.unrealized_pnl, 0);
}
