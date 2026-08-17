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
  // Non-null means this row is one LEG of a multi-leg option order - it's
  // rendered/closed as part of its OptionGroup instead of as a standalone
  // row, see PositionsPage's leg filtering.
  option_group_id: string | null;
};

// One leg of a multi-leg option order - see OptionGroup below. Strike/
// expiry aren't broken out separately here (not returned by GET
// /option-groups) - `symbol` is the full trading symbol (e.g.
// NIFTY24AUG24500CE), same as any other Position's symbol.
export type OptionLeg = {
  id: string;
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number | null;
  entry_price: number;
  exit_price: number | null;
  pnl: number | null;
  status: "OPEN" | "CLOSED" | "REJECTED";
  // Only set when the group's own sl_scope='individual' - null (as for
  // 'combined') the same way OptionGroup.combined_stop_loss_price is null
  // in individual mode.
  stop_loss_price: number | null;
  target_price: number | null;
  // Only populated when fetchOptionGroups({ withLivePnl: true }) - this
  // LEG's own live premium/P&L, not just the group's combined figure.
  live_price: number | null;
  unrealized_pnl: number | null;
};

// Multi-leg option order (naked/spread) - execution.option_position_groups,
// see docs/architecture.md Phase 4d. Combined P&L/SL/target are computed
// off the NET DEBIT (long leg premium - short leg premium, 0 for a naked
// position's absent short leg) as a single "BUY" position throughout - see
// option_position_manager.py's module docstring for the identity this
// relies on.
export type OptionGroup = {
  id: string;
  signal_id: string;
  strategy_id: string | null; // null = opened from the Manual tab
  underlying_symbol: string;
  exchange: string;
  segment: "NSE" | "MCX" | "CRYPTO";
  strategy_type: string; // e.g. "bull_call_spread", "naked_call"
  action: "BUY" | "SELL"; // the ORIGINAL signal direction, for reporting only
  horizon: string;
  entry_time: string;
  exit_time: string | null;
  quantity: number | null; // lots
  net_debit: number | null; // combined entry price, always positive
  combined_stop_loss_price: number | null; // only set when sl_scope='combined'
  combined_target_price: number | null;
  sl_scope: "combined" | "individual";
  // Underlying's own LTP at open (best-effort, may be null even for an
  // OPEN group) and an optional stop expressed on THAT price instead of
  // the combined premium - independent of sl_scope/combined_stop_loss_price
  // above, see option_position_manager.py's module-level comment on
  // spot_stop_loss_price. null spot_stop_loss_price = no spot-based stop
  // armed (never auto-set, only via updateOptionGroupSpotStopLoss).
  entry_spot_price: number | null;
  spot_stop_loss_price: number | null;
  // Only populated when fetchOptionGroups({ withLivePnl: true }).
  live_combined_price: number | null;
  // Fresh underlying LTP - distinct from entry_spot_price (frozen at
  // open) - lets the UI show how far spot is from spot_stop_loss_price.
  live_spot_price: number | null;
  unrealized_pnl: number | null;
  status: "OPEN" | "CLOSED" | "REJECTED";
  rejection_reason: string | null;
  exit_reason: string | null;
  pnl: number | null; // realized, once CLOSED
  square_off_time: string | null;
  legs: OptionLeg[];
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

// ---------------------------------------------------------------------
// Data provider (Dhan) credentials - market-data's own backend, read/
// written directly from the browser (CORS-enabled), same direct-from-
// browser cross-system pattern signal-generation's frontend already uses
// for its own market-data calls (fetchLtp etc. there) - NOT execution's
// own /api proxy convention above, since this isn't execution's data.
// ---------------------------------------------------------------------

const MARKET_DATA_PORT = import.meta.env.VITE_MARKET_DATA_PORT ?? "8001";
const MARKET_DATA_BASE_URL = `http://${location.hostname}:${MARKET_DATA_PORT}`;

export type DhanStatus = {
  renewed: boolean;
  last_renewed_at: string | null;
  expiry_time: string | null;
  dhan_client_name: string | null;
  create_time: string | null;
  dhan_client_id: string;
  has_access_token: boolean;
};

export async function fetchDhanStatus(): Promise<DhanStatus> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/dhan/token-status`);
  return asJson(res, "GET /dhan/token-status");
}

// Sets both the Dhan client ID and access token at runtime - in-memory
// only on market-data's side (see set_manual_credentials' own docstring),
// no restart needed, but also doesn't survive one.
export async function updateDhanCredentials(clientId: string, accessToken: string): Promise<DhanStatus> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/dhan/credentials`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, access_token: accessToken }),
  });
  return asJson(res, "PUT /dhan/credentials");
}

// ---------------------------------------------------------------------
// Strategy names - signal-generation's own backend, read directly from
// the browser (CORS-enabled), same direct-from-browser cross-system
// pattern as the Dhan credentials block above. Used only for the
// derivatives Orders grid's "Signal" column (OptionGroup.strategy_id ->
// name, "Manual" when null) - execution itself only ever stores the id.
// ---------------------------------------------------------------------

const SIGNAL_GENERATION_PORT = import.meta.env.VITE_SIGNAL_GENERATION_PORT ?? "8003";
const SIGNAL_GENERATION_BASE_URL = `http://${location.hostname}:${SIGNAL_GENERATION_PORT}`;

export type StrategySummary = {
  id: string;
  name: string;
};

export async function fetchStrategyNames(): Promise<StrategySummary[]> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/strategies`);
  return asJson(res, "GET /strategies");
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
  option_groups_deleted: number;
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

// ---------------------------------------------------------------------
// Multi-leg option groups - see docs/architecture.md Phase 4d.
// ---------------------------------------------------------------------

// Mirrors squareOffNow/checkExitsNow above, but for option groups
// (POST /positions/square-off and /positions/check-exits only ever touch
// plain spot/future positions - a group is not a Position row itself).
export async function squareOffOptionGroupsNow(): Promise<SquareOffResult> {
  const res = await fetch(`${API_BASE}/option-groups/square-off`, { method: "POST" });
  return asJson(res, "POST /option-groups/square-off");
}

export async function checkOptionGroupExitsNow(): Promise<{ closed_stop_loss: number; closed_target: number; checked: number }> {
  const res = await fetch(`${API_BASE}/option-groups/check-exits`, { method: "POST" });
  return asJson(res, "POST /option-groups/check-exits");
}

// spotStopLossPrice: an absolute underlying price - independent of
// updateOptionGroupStopLoss above (that one moves the PREMIUM stop). A
// %-based edit in the UI converts to price client-side first, using
// entry_spot_price and the group's action (same BUY/SELL direction
// convention compute_stop_loss_percent_price uses).
export async function updateOptionGroupSpotStopLoss(id: string, spotStopLossPrice: number): Promise<OptionGroup> {
  const res = await fetch(`${API_BASE}/option-groups/${id}/spot-stop-loss`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spot_stop_loss_price: spotStopLossPrice }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).detail ?? "";
    } catch {
      // ignore - use the generic message below
    }
    throw new Error(detail || `PUT /option-groups/${id}/spot-stop-loss failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchOptionGroups(
  opts: { limit?: number; signalId?: string; withLivePnl?: boolean } = {},
): Promise<OptionGroup[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.signalId) params.set("signal_id", opts.signalId);
  if (opts.withLivePnl) params.set("with_live_pnl", "true");

  const res = await fetch(`${API_BASE}/option-groups?${params}`);
  return asJson(res, "GET /option-groups");
}

export type SquareOffGroupResult = {
  status: string;
  group_id: string;
  underlying_symbol: string;
  pnl: number;
};

export async function squareOffOptionGroup(id: string): Promise<SquareOffGroupResult> {
  const res = await fetch(`${API_BASE}/option-groups/${id}/square-off`, { method: "POST" });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).detail ?? "";
    } catch {
      // ignore - use the generic message below
    }
    throw new Error(detail || `POST /option-groups/${id}/square-off failed: ${res.status}`);
  }
  return res.json();
}

// stopLossPrice: an absolute combined price - PUT /option-groups/{id}/
// stop-loss only accepts stop_loss_price (no stop_loss_method for options,
// see option_groups.py) - a %-based edit in the UI converts to price
// client-side before calling this, same formula open_option_group itself
// uses (net_debit * (1 - pct/100), the combined position is always "BUY"-
// direction - see option_position_manager.py's module docstring).
export async function updateOptionGroupStopLoss(id: string, stopLossPrice: number): Promise<OptionGroup> {
  const res = await fetch(`${API_BASE}/option-groups/${id}/stop-loss`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stop_loss_price: stopLossPrice }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).detail ?? "";
    } catch {
      // ignore - use the generic message below
    }
    throw new Error(detail || `PUT /option-groups/${id}/stop-loss failed: ${res.status}`);
  }
  return res.json();
}
