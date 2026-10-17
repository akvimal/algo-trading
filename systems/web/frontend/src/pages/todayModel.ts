import { isToday } from "../format";
import type { Account, Book, EquityPoint, OptionGroup, Position, Segment } from "../api/types";

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

// ---- the account cards on the home page

/** Intraday and Options both trade the everyday account; Positional is its own, separate balance. */
export const bookOf = (mode: Mode): Book => (mode === "positional" ? "positional" : "intraday");

const inBook = (horizon: string | null | undefined, book: Book) => ((horizon ?? "intraday") === "positional") === (book === "positional");

/** Today's result for one account card, in the toggle's view: Intraday and Positional count that kind of spot and futures trade, Options counts the option groups. */
export function cardPnl(positions: Position[], groups: OptionGroup[], segment: Segment, mode: Mode, now: Date = new Date()): DayPnl {
  if (mode === "options") return dayPnl([], groups.filter((g) => (g.segment ?? "NSE") === segment), now);
  return dayPnl(positions.filter((p) => p.segment === segment && inMode(p, mode)), [], now);
}

/** Today's result for a whole account (every kind of trade on its balance): what the daily loss limit is measured against. */
export function bookPnl(positions: Position[], groups: OptionGroup[], segment: Segment, book: Book, now: Date = new Date()): DayPnl {
  return dayPnl(
    positions.filter((p) => p.segment === segment && inBook(p.horizon, book)),
    book === "intraday" ? groups.filter((g) => (g.segment ?? "NSE") === segment) : [],
    now,
  );
}

/** How far the live prices have moved one account's open positions since the server last reported them. */
export function liveDeltaFor(original: Position[], live: Position[], segment: Segment, book: Book): number {
  const before = new Map(original.map((p) => [p.id, p.unrealized_pnl ?? 0]));
  return live
    .filter((p) => p.segment === segment && p.status === "OPEN" && inBook(p.horizon, book))
    .reduce((sum, p) => sum + ((p.unrealized_pnl ?? 0) - (before.get(p.id) ?? 0)), 0);
}

/** The last `days` day-end balances plus the balance right now, as the small trend on a card. Fewer than two values means there is no trend yet. */
export function recentTrend(points: EquityPoint[], liveBalance: number, days = 10, now: Date = new Date()): number[] {
  const past = [...points].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const last = past[past.length - 1];
  if (last && isToday(`${last.snapshot_date}T06:00:00Z`, now)) past.pop(); // today's point is the live one
  return [...past.slice(-(days - 1)).map((p) => p.equity), liveBalance];
}
