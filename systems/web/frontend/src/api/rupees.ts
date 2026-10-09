import { api } from "./http";
import type { OptionGroup, Position } from "./types";

// A crypto trade's prices and P&L are dollars (that is what Delta quotes, and what its stop is checked against), but every total, meter and
// label in this app is rupees. The server sends both: `pnl`/`unrealized_pnl` in the trade's own currency and the `_inr` pair in rupees, plus the
// rate used (`fx`). Rows are normalised once, here, as they arrive: `pnl` and `unrealized_pnl` become rupees for every trade (the dollar
// figures stay in `pnl_native`/`unrealized_pnl_native`), so nothing downstream has to know a trade was in dollars. Prices stay in dollars, and
// anything computed from a price distance multiplies by `fx`.

type Money = {
  pnl: number | null;
  unrealized_pnl?: number | null;
  pnl_inr?: number | null;
  unrealized_pnl_inr?: number | null;
  currency?: string;
};

export function inRupees<T extends Money>(rows: T[]): T[] {
  return rows.map((r) => {
    if (r.currency !== "USD") return r;
    return {
      ...r,
      pnl_native: r.pnl,
      unrealized_pnl_native: r.unrealized_pnl ?? null,
      pnl: r.pnl_inr ?? null,
      unrealized_pnl: r.unrealized_pnl_inr ?? null,
    };
  });
}

export const positionsApi = (path: string) => api<Position[]>("execution", path).then(inRupees);
export const groupsApi = (path: string) => api<OptionGroup[]>("execution", path).then(inRupees);
