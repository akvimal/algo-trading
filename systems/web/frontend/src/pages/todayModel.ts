import { isToday } from "../format";
import type { Account, Book, EquityPoint, OptionGroup, Position, Segment } from "../api/types";


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

/** Whether a trade belongs to a book: a multi-day hold is positional, everything else (every instrument, and every option spread) is the everyday book. */
export function inBook(horizon: string | null | undefined, book: Book): boolean {
  return ((horizon ?? "intraday") === "positional") === (book === "positional");
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

// ---- the day as a tape of trades (replaces the list of open positions on Home)

export type TapeTrade = { id: string; kind: "position" | "group"; symbol: string; action: "BUY" | "SELL"; pnl: number; open: boolean; at: string };

const groupSegment = (g: OptionGroup): Segment => g.segment ?? "NSE";

/** Every trade of the day in a book: what closed today (by exit time) followed by what is open now, one entry per trade (an option group once, never its legs). */
export function tradeTape(positions: Position[], groups: OptionGroup[], book: Book, segments: Segment[], now: Date = new Date()): TapeTrade[] {
  const closed: TapeTrade[] = [];
  const open: TapeTrade[] = [];
  for (const p of standalonePositions(positions)) {
    if (!segments.includes(p.segment) || !inBook(p.horizon, book)) continue;
    if (p.status === "OPEN") open.push({ id: p.id, kind: "position", symbol: p.symbol, action: p.action, pnl: p.unrealized_pnl ?? 0, open: true, at: p.entry_time });
    else if (p.status === "CLOSED" && p.exit_time && isToday(p.exit_time, now)) closed.push({ id: p.id, kind: "position", symbol: p.symbol, action: p.action, pnl: p.pnl ?? 0, open: false, at: p.exit_time });
  }
  if (book === "intraday") {
    for (const g of groups) {
      if (!segments.includes(groupSegment(g))) continue;
      if (g.status === "OPEN") open.push({ id: g.id, kind: "group", symbol: g.underlying_symbol, action: g.action, pnl: g.unrealized_pnl ?? 0, open: true, at: g.entry_time });
      else if (g.status === "CLOSED" && g.exit_time && isToday(g.exit_time, now)) closed.push({ id: g.id, kind: "group", symbol: g.underlying_symbol, action: g.action, pnl: g.pnl ?? 0, open: false, at: g.exit_time });
    }
  }
  const byTime = (a: TapeTrade, b: TapeTrade) => a.at.localeCompare(b.at);
  return [...closed.sort(byTime), ...open.sort(byTime)];
}

export type TapeStats = {
  closed: number;
  open: number;
  wins: number;
  losses: number;
  /** Wins as a share of the trades that won or lost (a flat trade is neither); null before any. */
  winRate: number | null;
  best: number | null;
  worst: number | null;
  /** The run the latest closed trades are on, e.g. 2 wins in a row; null when the latest was flat or there is none. */
  streak: { kind: "win" | "loss"; n: number } | null;
  openPnl: number;
};

export function tapeStats(tape: TapeTrade[]): TapeStats {
  const closed = tape.filter((t) => !t.open);
  const open = tape.filter((t) => t.open);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl < 0).length;
  const latest = closed[closed.length - 1];
  let streak: TapeStats["streak"] = null;
  if (latest && latest.pnl !== 0) {
    const kind = latest.pnl > 0 ? "win" : "loss";
    let n = 0;
    for (let i = closed.length - 1; i >= 0 && Math.sign(closed[i].pnl) === Math.sign(latest.pnl); i--) n++;
    streak = { kind, n };
  }
  return {
    closed: closed.length, open: open.length, wins, losses, winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    best: closed.length ? Math.max(...closed.map((t) => t.pnl)) : null, worst: closed.length ? Math.min(...closed.map((t) => t.pnl)) : null,
    streak, openPnl: open.reduce((n, t) => n + t.pnl, 0),
  };
}

export type OpenSummary = { count: number; pnl: number; noStop: number };

/** What is open in a book, in one line: how many, the live result, and how many have no stop set (a position's own, or an option group's underlying or premium stop). */
export function openSummary(positions: Position[], groups: OptionGroup[], book: Book, segments: Segment[]): OpenSummary {
  const ps = openPositions(positions).filter((p) => segments.includes(p.segment) && inBook(p.horizon, book));
  const gs = book === "intraday" ? openGroups(groups).filter((g) => segments.includes(groupSegment(g))) : [];
  return {
    count: ps.length + gs.length,
    pnl: ps.reduce((n, p) => n + (p.unrealized_pnl ?? 0), 0) + gs.reduce((n, g) => n + (g.unrealized_pnl ?? 0), 0),
    noStop: ps.filter((p) => p.stop_loss_price == null).length + gs.filter((g) => g.spot_stop_loss_price == null && g.combined_stop_loss_price == null).length,
  };
}
