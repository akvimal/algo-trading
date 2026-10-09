import type { Account, Credentials } from "../api/types";

/** The editable fields, as the text the person types. Numbers stay strings until they are
 * validated, so "" (blank) and "0." are representable while typing. */
export type AccountDraft = {
  capital_per_trade: string;
  risk_per_trade_pct: string;
  min_reward_risk_ratio: string;
  max_daily_loss: string; // "" = no limit
  slippage_bps: string;
  square_off_time: string; // "" = never squared off automatically
  require_stop_loss: boolean;
  apply_charges: boolean;
  enforce_risk_based_lots: boolean;
  leverage: string; // crypto only: the margin multiplier
};

export type DraftErrors = Partial<Record<keyof AccountDraft, string>>;

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");

export function draftFrom(a: Account): AccountDraft {
  return {
    capital_per_trade: String(a.capital_per_trade),
    risk_per_trade_pct: String(a.risk_per_trade_pct),
    min_reward_risk_ratio: String(a.min_reward_risk_ratio),
    max_daily_loss: a.max_daily_loss == null ? "" : String(a.max_daily_loss),
    slippage_bps: String(a.slippage_bps),
    square_off_time: hhmm(a.square_off_time),
    require_stop_loss: a.require_stop_loss,
    apply_charges: a.apply_charges,
    enforce_risk_based_lots: a.enforce_risk_based_lots,
    leverage: String(a.leverage ?? 1),
  };
}

function num(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** What to send: only what changed. Mirrors the server's bounds so a mistake is caught while
 * typing; the server still enforces them. An explicit null clears a limit (the server tells
 * "cleared" from "unchanged" by whether the key is present). */
export function buildAccountPatch(a: Account, d: AccountDraft): { patch: Record<string, unknown>; errors: DraftErrors } {
  const patch: Record<string, unknown> = {};
  const errors: DraftErrors = {};

  const required = (key: "capital_per_trade" | "risk_per_trade_pct" | "min_reward_risk_ratio", ok: (n: number) => boolean, msg: string) => {
    const n = num(d[key]);
    if (n === null || Number.isNaN(n) || !ok(n)) errors[key] = msg;
    else if (n !== a[key]) patch[key] = n;
  };
  required("capital_per_trade", (n) => n > 0, "Enter an amount above 0.");
  required("risk_per_trade_pct", (n) => n > 0 && n <= 100, "Enter a percentage above 0 and up to 100.");
  required("min_reward_risk_ratio", (n) => n > 0, "Enter a ratio above 0.");

  const loss = num(d.max_daily_loss);
  if (Number.isNaN(loss) || (loss !== null && loss <= 0)) errors.max_daily_loss = "Enter an amount above 0, or leave blank for no limit.";
  else if (loss !== a.max_daily_loss) patch.max_daily_loss = loss;

  const slip = num(d.slippage_bps);
  if (slip === null || Number.isNaN(slip) || slip < 0 || slip > 500) errors.slippage_bps = "Enter 0 to 500.";
  else if (slip !== a.slippage_bps) patch.slippage_bps = slip;

  if (a.segment === "CRYPTO") {
    const lev = num(d.leverage);
    if (lev === null || Number.isNaN(lev) || lev < 1 || lev > 100) errors.leverage = "Enter 1 to 100 (1 means no leverage).";
    else if (lev !== (a.leverage ?? 1)) patch.leverage = lev;
  }

  const t = d.square_off_time.trim();
  if (t !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) errors.square_off_time = "Use 24-hour time like 15:15, or leave blank.";
  else if (t !== hhmm(a.square_off_time)) patch.square_off_time = t === "" ? null : t;

  for (const key of ["require_stop_loss", "apply_charges", "enforce_risk_based_lots"] as const) {
    if (d[key] !== a[key]) patch[key] = d[key];
  }
  return { patch, errors };
}

/** The USD/INR rate as typed: a number above 0, or null with the problem. */
export function parseUsdInr(text: string): { rate: number | null; error: string | null } {
  const n = num(text);
  if (n === null || Number.isNaN(n) || n <= 0) return { rate: null, error: "Enter the rupees per US dollar, for example 88.5." };
  return { rate: n, error: null };
}

export const hasErrors = (e: DraftErrors) => Object.keys(e).length > 0;

export type LiveDraft = { maxOrderValue: string; maxDailyLoss: string; consent: boolean };

/** Turning live trading ON: the caps and the acknowledgement travel in the same request, and
 * the server judges the result, so nothing here is a substitute for its gate. */
export function buildLiveOnPatch(d: LiveDraft): { patch: Record<string, unknown> | null; error: string | null } {
  const order = num(d.maxOrderValue);
  const loss = num(d.maxDailyLoss);
  if (order === null || Number.isNaN(order) || order <= 0) return { patch: null, error: "Set the most a single order may be worth (above 0)." };
  if (loss === null || Number.isNaN(loss) || loss <= 0) return { patch: null, error: "Set the most you can lose in a day (above 0)." };
  if (!d.consent) return { patch: null, error: "Tick the box to confirm you understand live orders use real money." };
  return { patch: { live_trading_enabled: true, max_order_value: order, max_daily_loss: loss, live_trading_consent: true }, error: null };
}

export type KeyField = "dhan_client_id" | "dhan_access_token" | "delta_api_key" | "delta_api_secret" | "openrouter_api_key";

/** Blank fields are left alone (a partial update), so renewing only the daily Dhan token is
 * one field. A first-time Dhan connection needs both. */
export function buildCredentialsPatch(
  values: Partial<Record<KeyField, string>>,
  current: Credentials | null,
): { patch: Partial<Record<KeyField, string>>; error: string | null } {
  const patch: Partial<Record<KeyField, string>> = {};
  for (const [k, v] of Object.entries(values) as [KeyField, string][]) {
    const t = v.trim();
    if (t) patch[k] = t;
  }
  if (Object.keys(patch).length === 0) return { patch, error: "Enter a value to save." };
  const dhan = patch.dhan_client_id !== undefined || patch.dhan_access_token !== undefined;
  if (dhan && !current?.has_dhan && !(patch.dhan_client_id && patch.dhan_access_token)) {
    return { patch, error: "Enter both your Dhan client ID and access token." };
  }
  const delta = patch.delta_api_key !== undefined || patch.delta_api_secret !== undefined;
  if (delta && !current?.has_delta && !(patch.delta_api_key && patch.delta_api_secret)) {
    return { patch, error: "Enter both the Delta API key and secret." };
  }
  return { patch, error: null };
}

export type LiveStatus = "paper" | "live" | "unavailable";

/** Only NSE and MCX can go live; crypto and options have no real-order path. */
export function liveStatus(a: Account): LiveStatus {
  if (a.segment === "CRYPTO") return "unavailable";
  return a.live_trading_enabled ? "live" : "paper";
}
