export type Position = {
  id: string;
  signal_id: string;
  strategy_id: string;
  symbol: string;
  exchange: string;
  segment: "NSE" | "MCX" | "CRYPTO";
  action: "BUY" | "SELL";
  horizon: string;
  instrument_type: string;
  quantity: number | null; // null for REJECTED - never sized
  entry_price: number;
  entry_time: string;
  exit_price: number | null;
  exit_time: string | null;
  pnl: number | null;
  // Only populated when fetchPositions({ withLivePnl: true }) - a fresh
  // mark-to-market for OPEN positions, not stored, recomputed every call.
  live_price: number | null;
  unrealized_pnl: number | null;
  status: "OPEN" | "CLOSED" | "REJECTED";
  rejection_reason: string | null;
  // Set only for positions whose Strategy configured a stop-loss/target -
  // plain capital-sized positions have both null and aren't monitored.
  stop_loss_price: number | null;
  target_price: number | null;
  trailing_stop_enabled: boolean;
  // Why a CLOSED position closed - null for OPEN/REJECTED. counter_signal:
  // closed ahead of its own SL/target/square-off because an
  // opposite-direction signal arrived and its Strategy's
  // counter_signal_policy='close_and_flip'.
  exit_reason: "square_off" | "stop_loss" | "target" | "manual" | "counter_signal" | null;
  // This position's segment's own square-off time (Account.square_off_time
  // below), copied at open time - null means never force-closed (e.g.
  // CRYPTO), same as null for REJECTED rows that never got this far.
  square_off_time: string | null; // "HH:MM:SS"
};

export type Account = {
  segment: "NSE" | "MCX" | "CRYPTO";
  starting_balance: number;
  current_balance: number;
  capital_per_trade: number;
  risk_per_trade_pct: number;
  // CRYPTO only - a margin multiplier applied before sizing (Delta
  // Exchange India trades perpetual futures on margin). Defaults to 1 -
  // present but unused for NSE/MCX.
  leverage: number;
  // The one segment-wide square-off cutoff - any intraday position still
  // OPEN past this local time-of-day gets forcefully closed. null means
  // never force-closed (CRYPTO's default - crypto trades 24/7).
  square_off_time: string | null; // "HH:MM:SS"
  updated_at: string;
};

export type Settings = {
  timezone: string;
  // CRYPTO only - a manually configured INR-per-USD rate used to convert
  // capital_per_trade/current_balance into USD-equivalent before sizing a
  // CRYPTO position (Delta Exchange India prices everything in raw USD).
  // null until set - CRYPTO positions reject cleanly rather than sizing
  // against an unconverted number until then.
  usdinr_rate: number | null;
};

export type SquareOffResult = {
  closed: number;
  failed: number;
  total_open: number;
};

export type SquareOffDueResult = {
  closed: number;
  failed: number;
  checked: number;
};

export type CheckExitsResult = {
  closed_stop_loss: number;
  closed_target: number;
  trailed: number;
  checked: number;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function asJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchPositions(
  opts: { limit?: number; signalId?: string; withLivePnl?: boolean } = {},
): Promise<Position[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.signalId) params.set("signal_id", opts.signalId);
  if (opts.withLivePnl) params.set("with_live_pnl", "true");

  const res = await fetch(`${API_BASE}/positions?${params}`);
  return asJson(res, "GET /positions");
}

export async function fetchAccounts(): Promise<Account[]> {
  const res = await fetch(`${API_BASE}/accounts`);
  return asJson(res, "GET /accounts");
}

export async function updateAccount(
  segment: Account["segment"],
  update: Pick<Account, "capital_per_trade" | "risk_per_trade_pct" | "leverage" | "square_off_time">,
): Promise<Account> {
  const res = await fetch(`${API_BASE}/accounts/${segment}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, `PUT /accounts/${segment}`);
}

export async function resetAccount(segment: Account["segment"]): Promise<Account> {
  const res = await fetch(`${API_BASE}/accounts/${segment}/reset`, { method: "POST" });
  return asJson(res, `POST /accounts/${segment}/reset`);
}

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`);
  return asJson(res, "GET /settings");
}

export async function updateSettings(update: { usdinr_rate: number }): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, "PUT /settings");
}

export async function squareOffNow(): Promise<SquareOffResult> {
  const res = await fetch(`${API_BASE}/positions/square-off`, { method: "POST" });
  return asJson(res, "POST /positions/square-off");
}

export async function squareOffDueNow(): Promise<SquareOffDueResult> {
  const res = await fetch(`${API_BASE}/positions/square-off-due`, { method: "POST" });
  return asJson(res, "POST /positions/square-off-due");
}

export async function checkExitsNow(): Promise<CheckExitsResult> {
  const res = await fetch(`${API_BASE}/positions/check-exits`, { method: "POST" });
  return asJson(res, "POST /positions/check-exits");
}

export type ClearPositionsResult = {
  positions_deleted: number;
};

export async function clearPositions(): Promise<ClearPositionsResult> {
  const res = await fetch(`${API_BASE}/positions`, { method: "DELETE" });
  return asJson(res, "DELETE /positions");
}

export type SquareOffOneResult = {
  status: string;
  position_id: string;
  symbol: string;
  exit_price: number;
  pnl: number;
};

export async function squareOffPosition(id: string): Promise<SquareOffOneResult> {
  const res = await fetch(`${API_BASE}/positions/${id}/square-off`, { method: "POST" });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).detail ?? "";
    } catch {
      // ignore - use the generic message below
    }
    throw new Error(detail || `POST /positions/${id}/square-off failed: ${res.status}`);
  }
  return res.json();
}
