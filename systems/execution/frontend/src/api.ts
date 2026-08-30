import { clearAuthToken, getAuthToken } from "./auth";

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
  exit_reason: "square_off" | "stop_loss" | "target" | "manual" | "counter_signal" | "liquidation" | null;
  // This position's segment's own square-off time (Account.square_off_time
  // below), copied at open time - null means never force-closed (e.g.
  // CRYPTO), same as null for REJECTED rows that never got this far.
  square_off_time: string | null; // "HH:MM:SS"
  // Non-null means this row is one LEG of a multi-leg option order - it's
  // rendered/closed as part of its OptionGroup instead of as a standalone
  // row, see PositionsPage's leg filtering.
  option_group_id: string | null;
  // Delta Exchange fee/liquidation simulation - CRYPTO + instrument_type=
  // 'future' only, null for every other position. margin_posted/
  // liquidation_price are computed once at open time off the account's
  // leverage at that moment.
  open_fee: number | null;
  close_fee: number | null;
  margin_posted: number | null;
  liquidation_price: number | null;
  // Live-broker-adapter (see docs/architecture.md) - true only if this
  // position's entry actually cleared through a real Dhan order, never a
  // paper fill. false for every position opened before this existed.
  is_live_broker_order: boolean;
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
  // Non-null only for an auto-computed (stop_loss_method='indicator')
  // spot_stop_loss_price - see option_position_manager.py's
  // open_option_group/_evaluate_option_group_exits. A user-set one (PUT
  // /option-groups/{id}/stop-loss) leaves all three null and stays checked
  // against the underlying's own spot LTP instead of a future contract's.
  spot_stop_loss_trailing_enabled: boolean;
  spot_stop_loss_indicator_type: string | null;
  stop_loss_future_symbol: string | null;
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
  // Delta Exchange option trading-fee simulation (app/domain/delta_fees.py)
  // - CRYPTO only, null for NSE/MCX groups. No liquidation fields here at
  // all - CRYPTO options never carry liquidation risk in this platform.
  open_fee: number | null;
  close_fee: number | null;
  legs: OptionLeg[];
};

export type Account = {
  segment: "NSE" | "MCX" | "CRYPTO";
  starting_balance: number;
  current_balance: number;
  capital_per_trade: number;
  risk_per_trade_pct: number;
  // Manual tab only (WorkspacePage.tsx's own computeRR) - minimum
  // reward:risk a manual order's Limit(or LTP)/Target/SL Limit must clear
  // before the Add/Update button will place/update it.
  min_reward_risk_ratio: number;
  // Manual tab only, spot/future rows only - when true, WorkspacePage.tsx
  // auto-computes and locks the Lot field from risk_per_trade_pct/
  // capital_per_trade instead of leaving it free-typed.
  enforce_risk_based_lots: boolean;
  // CRYPTO and NSE (both MTF positional spot AND intraday MIS margin, same
  // field for both) - a margin multiplier applied before sizing (Delta
  // Exchange India trades perpetual futures on margin; Dhan's MTF borrows
  // cash against NSE spot equity held overnight; intraday MIS carries no
  // interest at all). Defaults to 1 - present but unused for MCX. The
  // PLATFORM account's own leverage (edited via fetchPlatformAccounts/
  // updatePlatformAccount below) is what the automated Strategy-driven
  // flow reads; THIS row is the caller's own, read by their own Manual tab
  // orders - see position_manager.open_position/open_manual_position.
  leverage: number;
  // NSE MTF only - the manually configured annualized interest rate
  // charged on the borrowed portion of a leverage>1 NSE positional
  // position. null until set - such an order is rejected rather than
  // opened with unmodeled interest cost. Platform-account only (see
  // leverage above) - present here only because GET /accounts returns
  // every field on the row.
  mtf_annual_interest_rate_pct: number | null;
  // The one segment-wide square-off cutoff - any intraday position still
  // OPEN past this local time-of-day gets forcefully closed. null means
  // never force-closed (CRYPTO's default - crypto trades 24/7).
  square_off_time: string | null; // "HH:MM:SS"
  // Live-broker-adapter (see docs/architecture.md) - opts THIS account
  // into real Dhan order submission on the Manual tab's spot/future path.
  // Still gated by the platform-wide kill switch on top. Only meaningful
  // for NSE/MCX - CRYPTO can never go live (a different broker with no
  // order API yet).
  live_trading_enabled: boolean;
  max_order_value: number | null;
  max_daily_loss: number | null;
  updated_at: string;
};

// Optional per-strategy override of a segment's shared Account above - see
// execution.strategy_accounts / position_manager.load_capital_account. A
// strategy with a row here sizes/tracks P&L against IT instead of its
// segment's shared account; a strategy with no row here keeps sharing the
// segment account exactly as before this existed. Deliberately no
// leverage/square_off_time fields - those stay segment-only always, see
// docs/architecture.md.
export type StrategyAccount = {
  strategy_id: string;
  segment: "NSE" | "MCX" | "CRYPTO";
  starting_balance: number;
  current_balance: number;
  capital_per_trade: number;
  risk_per_trade_pct: number;
  // Live-broker-adapter P3 item 14 (see docs/architecture.md) - the ONLY
  // way an automated Strategy-driven signal can ever place a real order.
  // live_trading_user_id is whose own BYO Dhan credentials execute this
  // strategy's real orders - null until explicitly set. Only meaningful
  // for NSE/MCX (segment above) - a CRYPTO strategy can never go live.
  live_trading_user_id: string | null;
  live_trading_enabled: boolean;
  max_order_value: number | null;
  max_daily_loss: number | null;
  updated_at: string;
};

// GET /live-trading/status (admin-only) - "is X actually live right now,
// and if not, why not" across every account and strategy_accounts row -
// see position_manager.get_live_trading_status's own docstring.
export type LiveTradingAccountStatus = {
  user_id: string | null;
  segment: "NSE" | "MCX" | "CRYPTO";
  live_trading_enabled: boolean;
  max_order_value: number | null;
  max_daily_loss: number | null;
  today_realized_pnl: number | null;
  effectively_live: boolean;
  reason: string | null;
};

export type LiveTradingStrategyStatus = {
  strategy_id: string;
  segment: "NSE" | "MCX" | "CRYPTO";
  live_trading_user_id: string | null;
  live_trading_enabled: boolean;
  max_order_value: number | null;
  max_daily_loss: number | null;
  today_realized_pnl: number | null;
  effectively_live: boolean;
  reason: string | null;
};

export type LiveTradingStatus = {
  kill_switch: boolean;
  accounts: LiveTradingAccountStatus[];
  strategy_accounts: LiveTradingStrategyStatus[];
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

// Every execution route requires a Bearer token as of the multi-tenant SaaS
// migration (Phase 2, see docs/architecture.md) - this wrapper layers the
// stored token onto an otherwise-identical fetch() call. A 401 only ever
// means "token missing/expired/invalid" here (execution never uses 401 for
// a domain error), so it's safe to treat any 401 as "session expired" and
// force back to the login screen - the reload re-mounts AuthGate, which
// picks up the now-empty token and renders LoginPage, matching this
// frontend's existing full-reload nav convention (Nav.tsx's <a href>).
function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401) {
      clearAuthToken();
      window.location.reload();
    }
    return res;
  });
}

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

  const res = await authFetch(`${API_BASE}/positions?${params}`);
  return asJson(res, "GET /positions");
}

// The platform-wide (user_id IS NULL) positions GET /positions can never
// return - the automated Strategy-driven flow (Chartink webhooks, in-house
// engine) opens these, and a Strategy isn't owned by any SaaS user. Every
// caller of this frontend is already admin-gated end-to-end (AuthGate.tsx),
// same reasoning as fetchPlatformAccounts below.
export async function fetchPlatformPositions(
  opts: { limit?: number; signalId?: string; withLivePnl?: boolean } = {},
): Promise<Position[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.signalId) params.set("signal_id", opts.signalId);
  if (opts.withLivePnl) params.set("with_live_pnl", "true");

  const res = await authFetch(`${API_BASE}/positions/platform?${params}`);
  return asJson(res, "GET /positions/platform");
}

// Oldest-first unrealized-P&L time series recorded by the exit-monitor's
// own 30s tick (execution/backend/app/domain/position_manager.py's
// record_position_pnl_snapshots) - fetched on demand when a Positions-grid
// row is expanded, not prefetched for every row.
export type PositionPnlSnapshot = { recorded_at: string; cmp: number; unrealized_pnl: number };

export async function fetchPositionPnlHistory(positionId: string): Promise<PositionPnlSnapshot[]> {
  const res = await authFetch(`${API_BASE}/positions/${positionId}/pnl-history`);
  return asJson(res, "GET /positions/{id}/pnl-history");
}

export async function fetchAccounts(): Promise<Account[]> {
  const res = await authFetch(`${API_BASE}/accounts`);
  return asJson(res, "GET /accounts");
}

export async function updateAccount(
  segment: Account["segment"],
  update: Partial<
    Pick<
      Account,
      | "capital_per_trade"
      | "risk_per_trade_pct"
      | "min_reward_risk_ratio"
      | "enforce_risk_based_lots"
      | "leverage"
      | "square_off_time"
      | "live_trading_enabled"
      | "max_order_value"
      | "max_daily_loss"
    >
  >,
): Promise<Account> {
  const res = await authFetch(`${API_BASE}/accounts/${segment}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, `PUT /accounts/${segment}`);
}

// The platform-wide (user_id IS NULL) accounts - the rows the automated
// Strategy-driven flow actually reads (see execution backend's load_account
// docstring). Every caller of this frontend is already admin-gated
// end-to-end (AuthGate.tsx), so no separate admin check is needed here -
// these just hit the admin-only GET/PUT /accounts/platform* routes instead
// of the per-caller ones above.
export async function fetchPlatformAccounts(): Promise<Account[]> {
  const res = await authFetch(`${API_BASE}/accounts/platform`);
  return asJson(res, "GET /accounts/platform");
}

export async function updatePlatformAccount(
  segment: Account["segment"],
  update: Partial<Pick<Account, "leverage" | "mtf_annual_interest_rate_pct" | "square_off_time">>,
): Promise<Account> {
  const res = await authFetch(`${API_BASE}/accounts/platform/${segment}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, `PUT /accounts/platform/${segment}`);
}

export async function resetAccount(segment: Account["segment"]): Promise<Account> {
  const res = await authFetch(`${API_BASE}/accounts/${segment}/reset`, { method: "POST" });
  return asJson(res, `POST /accounts/${segment}/reset`);
}

export async function fetchStrategyAccounts(): Promise<StrategyAccount[]> {
  const res = await authFetch(`${API_BASE}/accounts/strategy`);
  return asJson(res, "GET /accounts/strategy");
}

export async function createStrategyAccount(
  strategyId: string,
  create: Pick<StrategyAccount, "segment" | "starting_balance" | "capital_per_trade" | "risk_per_trade_pct">,
): Promise<StrategyAccount> {
  const res = await authFetch(`${API_BASE}/accounts/strategy/${strategyId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(create),
  });
  return asJson(res, `POST /accounts/strategy/${strategyId}`);
}

export async function updateStrategyAccount(
  strategyId: string,
  update: Partial<
    Pick<
      StrategyAccount,
      "capital_per_trade" | "risk_per_trade_pct" | "live_trading_user_id" | "live_trading_enabled" | "max_order_value" | "max_daily_loss"
    >
  >,
): Promise<StrategyAccount> {
  const res = await authFetch(`${API_BASE}/accounts/strategy/${strategyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, `PUT /accounts/strategy/${strategyId}`);
}

export async function deleteStrategyAccount(strategyId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/accounts/strategy/${strategyId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /accounts/strategy/${strategyId} failed: ${res.status}`);
}

export async function resetStrategyAccount(strategyId: string): Promise<StrategyAccount> {
  const res = await authFetch(`${API_BASE}/accounts/strategy/${strategyId}/reset`, { method: "POST" });
  return asJson(res, `POST /accounts/strategy/${strategyId}/reset`);
}

export async function fetchLiveTradingStatus(): Promise<LiveTradingStatus> {
  const res = await authFetch(`${API_BASE}/live-trading/status`);
  return asJson(res, "GET /live-trading/status");
}

export async function fetchSettings(): Promise<Settings> {
  const res = await authFetch(`${API_BASE}/settings`);
  return asJson(res, "GET /settings");
}

export async function updateSettings(update: { usdinr_rate: number }): Promise<Settings> {
  const res = await authFetch(`${API_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, "PUT /settings");
}

// Data provider (Dhan) credentials + live feed used to live here (called
// directly on market-data's backend, CORS-enabled) - moved to market-data's
// own frontend since it's market-data's data, not execution's (see
// docs/architecture.md). See that system's App.tsx (DhanAdminSection) and
// api.ts. NOT the same thing as the BYO credentials block below - that's a
// SaaS user's own personal keys (systems/accounts), this is the platform
// operator's own data-provider config.

// ---------------------------------------------------------------------
// BYO broker credentials (systems/accounts, see docs/architecture.md §
// "Manual Trading SaaS") - a user's own Dhan/Delta keys, so market-data
// resolves and uses THEIR OWN credentials/rate budget instead of the
// platform default (Phase 3), and so the live-broker-adapter's real order
// placement has a real credential to execute against at all (see "Your
// account"'s own Live trading section above). Moved here from
// manual-trading/frontend's former "My Credentials" page (see
// docs/architecture.md) - same reasoning as "Your account" itself: this
// was always accounts' own data with no manual-trading-specific
// dependency, and now sits right next to the Live trading toggle that
// actually needs it. Never returns a decrypted secret back -
// has_dhan/has_delta/dhan_client_id_masked only; the form always starts
// blank and shows this status text instead.
// ---------------------------------------------------------------------

const ACCOUNTS_PORT = import.meta.env.VITE_ACCOUNTS_PORT ?? "8004";
const ACCOUNTS_BASE_URL = `http://${location.hostname}:${ACCOUNTS_PORT}`;

export type CredentialsOut = {
  has_dhan: boolean;
  has_delta: boolean;
  dhan_client_id_masked: string | null;
};

export type CredentialsUpdate = {
  dhan_client_id?: string;
  dhan_access_token?: string;
  delta_api_key?: string;
  delta_api_secret?: string;
};

export async function fetchCredentials(): Promise<CredentialsOut> {
  const res = await authFetch(`${ACCOUNTS_BASE_URL}/credentials`);
  return asJson(res, "GET /credentials");
}

export async function saveCredentials(update: CredentialsUpdate): Promise<CredentialsOut> {
  const res = await authFetch(`${ACCOUNTS_BASE_URL}/credentials`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, "PUT /credentials");
}

// ---------------------------------------------------------------------
// Strategy names - signal-engine's own backend (the 2026-08-28 merger of
// signal-generation/signal-processing, see docs/architecture.md), read
// directly from the browser (CORS-enabled), same direct-from-browser
// cross-system pattern as the Dhan credentials block above. Used only for
// the derivatives Orders grid's "Signal" column (OptionGroup.strategy_id
// -> name, "Manual" when null) - execution itself only ever stores the id.
// ---------------------------------------------------------------------

const SIGNAL_ENGINE_PORT = import.meta.env.VITE_SIGNAL_ENGINE_PORT ?? "8000";
const SIGNAL_ENGINE_BASE_URL = `http://${location.hostname}:${SIGNAL_ENGINE_PORT}`;

export type StrategySummary = {
  id: string;
  name: string;
  // Present on the real /strategies response - only used by the
  // dedicated-account creation form below (AccountsPage) to auto-fill/
  // lock the segment field to whatever the chosen strategy already trades,
  // rather than letting the two be picked independently and mismatched.
  segment: "NSE" | "MCX" | "CRYPTO";
};

export async function fetchStrategyNames(): Promise<StrategySummary[]> {
  const res = await fetch(`${SIGNAL_ENGINE_BASE_URL}/strategies`);
  return asJson(res, "GET /strategies");
}

export async function squareOffNow(): Promise<SquareOffResult> {
  const res = await authFetch(`${API_BASE}/positions/square-off`, { method: "POST" });
  return asJson(res, "POST /positions/square-off");
}

export async function squareOffDueNow(): Promise<SquareOffDueResult> {
  const res = await authFetch(`${API_BASE}/positions/square-off-due`, { method: "POST" });
  return asJson(res, "POST /positions/square-off-due");
}

export async function checkExitsNow(): Promise<CheckExitsResult> {
  const res = await authFetch(`${API_BASE}/positions/check-exits`, { method: "POST" });
  return asJson(res, "POST /positions/check-exits");
}

export type ClearPositionsResult = {
  positions_deleted: number;
  option_groups_deleted: number;
};

export async function clearPositions(): Promise<ClearPositionsResult> {
  const res = await authFetch(`${API_BASE}/positions`, { method: "DELETE" });
  return asJson(res, "DELETE /positions");
}

// Platform-wide (user_id IS NULL) counterpart - the automated Strategy-
// driven flow's own positions/groups, which clearPositions above can never
// touch. See fetchPlatformPositions' own comment for why every caller of
// this frontend is already admin-gated end-to-end.
export async function clearPlatformPositions(): Promise<ClearPositionsResult> {
  const res = await authFetch(`${API_BASE}/positions/platform`, { method: "DELETE" });
  return asJson(res, "DELETE /positions/platform");
}

export type SquareOffOneResult = {
  status: string;
  position_id: string;
  symbol: string;
  exit_price: number;
  pnl: number;
};

export async function squareOffPosition(id: string): Promise<SquareOffOneResult> {
  const res = await authFetch(`${API_BASE}/positions/${id}/square-off`, { method: "POST" });
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
  const res = await authFetch(`${API_BASE}/option-groups/square-off`, { method: "POST" });
  return asJson(res, "POST /option-groups/square-off");
}

export async function checkOptionGroupExitsNow(): Promise<{ closed_stop_loss: number; closed_target: number; checked: number }> {
  const res = await authFetch(`${API_BASE}/option-groups/check-exits`, { method: "POST" });
  return asJson(res, "POST /option-groups/check-exits");
}

// spotStopLossPrice: an absolute underlying price - independent of
// updateOptionGroupStopLoss above (that one moves the PREMIUM stop). A
// %-based edit in the UI converts to price client-side first, using
// entry_spot_price and the group's action (same BUY/SELL direction
// convention compute_stop_loss_percent_price uses).
export async function updateOptionGroupSpotStopLoss(id: string, spotStopLossPrice: number): Promise<OptionGroup> {
  const res = await authFetch(`${API_BASE}/option-groups/${id}/spot-stop-loss`, {
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

  const res = await authFetch(`${API_BASE}/option-groups?${params}`);
  return asJson(res, "GET /option-groups");
}

// Option-group counterpart to fetchPlatformPositions above - see that
// function's own comment.
export async function fetchPlatformOptionGroups(
  opts: { limit?: number; signalId?: string; withLivePnl?: boolean } = {},
): Promise<OptionGroup[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.signalId) params.set("signal_id", opts.signalId);
  if (opts.withLivePnl) params.set("with_live_pnl", "true");

  const res = await authFetch(`${API_BASE}/option-groups/platform?${params}`);
  return asJson(res, "GET /option-groups/platform");
}

export type OptionGroupPnlSnapshot = { recorded_at: string; combined_price: number; unrealized_pnl: number };

export async function fetchOptionGroupPnlHistory(groupId: string): Promise<OptionGroupPnlSnapshot[]> {
  const res = await authFetch(`${API_BASE}/option-groups/${groupId}/pnl-history`);
  return asJson(res, "GET /option-groups/{id}/pnl-history");
}

export type SquareOffGroupResult = {
  status: string;
  group_id: string;
  underlying_symbol: string;
  pnl: number;
};

export async function squareOffOptionGroup(id: string): Promise<SquareOffGroupResult> {
  const res = await authFetch(`${API_BASE}/option-groups/${id}/square-off`, { method: "POST" });
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
  const res = await authFetch(`${API_BASE}/option-groups/${id}/stop-loss`, {
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
