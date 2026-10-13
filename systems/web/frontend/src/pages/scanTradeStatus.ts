import { listWaitingOrders } from "../api/trade";
import { groupsApi, positionsApi } from "../api/rupees";
import type { OptionGroup, PendingOrder, Position } from "../api/types";
import { useResource } from "../hooks/useResource";

/** What the person already has on one stock: trades that are open, and orders waiting for their price. */
export type TradeStatus = { open: number; waiting: number };
export type TradeFilter = "any" | "none" | "open" | "waiting";

export const TRADE_FILTER_OPTIONS: { value: TradeFilter; label: string }[] = [
  { value: "any", label: "Any stock" },
  { value: "none", label: "No open or waiting trade" },
  { value: "open", label: "Has an open trade" },
  { value: "waiting", label: "Has a waiting order" },
];

/** A future is stored under its contract (RELIANCE-Oct2026-FUT); everything else under the bare symbol. */
const underlyingOf = (symbol: string) => symbol.toUpperCase().replace(/-[A-Z]{3}\d{4}-FUT$/, "");

/** Scan symbol -> its open trades and waiting orders. An option leg is counted through its group, not on its own. */
export function buildTradeStatus(positions: Position[], groups: OptionGroup[], waiting: PendingOrder[]): Map<string, TradeStatus> {
  const map = new Map<string, TradeStatus>();
  const bump = (symbol: string, key: keyof TradeStatus) => {
    const k = underlyingOf(symbol);
    const cur = map.get(k) ?? { open: 0, waiting: 0 };
    cur[key] += 1;
    map.set(k, cur);
  };
  positions.filter((p) => p.option_group_id == null).forEach((p) => bump(p.symbol, "open"));
  groups.forEach((g) => bump(g.underlying_symbol, "open"));
  waiting.filter((o) => o.status === "pending").forEach((o) => bump(o.symbol, "waiting"));
  return map;
}

export const statusOf = (map: Map<string, TradeStatus>, symbol: string): TradeStatus => map.get(symbol.toUpperCase()) ?? { open: 0, waiting: 0 };

export function matchesTradeFilter(s: TradeStatus, f: TradeFilter): boolean {
  if (f === "any") return true;
  if (f === "none") return s.open === 0 && s.waiting === 0;
  return f === "open" ? s.open > 0 : s.waiting > 0;
}

/** One read of the person's open and waiting NSE trades for the whole Scan list. A failed read leaves the cards without a marker rather than hiding them. */
export function useTradeStatus(): { map: Map<string, TradeStatus>; ready: boolean } {
  const res = useResource(async () => {
    const none = <T,>() => [] as T[];
    const [positions, groups, waiting] = await Promise.all([
      positionsApi("/positions?segment=NSE&status=OPEN&limit=200").catch(none<Position>),
      groupsApi("/option-groups?segment=NSE&status=OPEN&limit=200").catch(none<OptionGroup>),
      listWaitingOrders().catch(none<PendingOrder>),
    ]);
    return buildTradeStatus(positions, groups, waiting.filter((o) => o.segment === "NSE"));
  }, []);
  return { map: res.data ?? new Map(), ready: res.data != null };
}
