import { describe, expect, it } from "vitest";
import type { Account, Credentials } from "../api/types";
import { buildAccountPatch, buildCredentialsPatch, buildLiveOnPatch, draftFrom, hasErrors, liveStatus } from "./settingsModel";

const account = (over: Partial<Account> = {}): Account => ({
  segment: "NSE", starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 0, capital_per_trade: 10000,
  max_daily_loss: null, live_trading_enabled: false, apply_charges: false, require_stop_loss: false, square_off_time: "15:15:00",
  risk_per_trade_pct: 1, min_reward_risk_ratio: 2, enforce_risk_based_lots: false, slippage_bps: 5, max_order_value: null,
  live_trading_consent_at: null, ...over,
});

describe("buildAccountPatch", () => {
  it("sends nothing for an untouched form", () => {
    const a = account();
    const { patch, errors } = buildAccountPatch(a, draftFrom(a));
    expect(patch).toEqual({});
    expect(hasErrors(errors)).toBe(false);
  });

  it("sends only what changed, as numbers", () => {
    const a = account();
    const d = { ...draftFrom(a), capital_per_trade: "25000", require_stop_loss: true, slippage_bps: "5" };
    expect(buildAccountPatch(a, d).patch).toEqual({ capital_per_trade: 25000, require_stop_loss: true });
  });

  it("rejects values the server would refuse, per field", () => {
    const a = account();
    const d = { ...draftFrom(a), capital_per_trade: "0", risk_per_trade_pct: "150", min_reward_risk_ratio: "abc", slippage_bps: "600", max_daily_loss: "-5" };
    const { patch, errors } = buildAccountPatch(a, d);
    expect(Object.keys(errors).sort()).toEqual(["capital_per_trade", "max_daily_loss", "min_reward_risk_ratio", "risk_per_trade_pct", "slippage_bps"]);
    expect(patch).toEqual({}); // nothing invalid is sent
  });

  it("treats a blank required field as an error, not as zero", () => {
    const a = account();
    expect(buildAccountPatch(a, { ...draftFrom(a), capital_per_trade: "  " }).errors.capital_per_trade).toBeDefined();
  });

  it("clears the daily loss limit with an explicit null, and sets it with a number", () => {
    const a = account({ max_daily_loss: 3000 });
    expect(buildAccountPatch(a, { ...draftFrom(a), max_daily_loss: "" }).patch).toEqual({ max_daily_loss: null });
    expect(buildAccountPatch(account(), { ...draftFrom(account()), max_daily_loss: "4000" }).patch).toEqual({ max_daily_loss: 4000 });
    expect("max_daily_loss" in buildAccountPatch(a, draftFrom(a)).patch).toBe(false); // unchanged is not sent
  });

  it("handles the square-off time: shown as HH:MM, blank means never, bad text is an error", () => {
    const a = account({ square_off_time: "15:15:00" });
    expect(draftFrom(a).square_off_time).toBe("15:15");
    expect(buildAccountPatch(a, draftFrom(a)).patch).toEqual({}); // "15:15:00" vs "15:15" is not a change
    expect(buildAccountPatch(a, { ...draftFrom(a), square_off_time: "" }).patch).toEqual({ square_off_time: null });
    expect(buildAccountPatch(a, { ...draftFrom(a), square_off_time: "15:30" }).patch).toEqual({ square_off_time: "15:30" });
    expect(buildAccountPatch(a, { ...draftFrom(a), square_off_time: "25:00" }).errors.square_off_time).toBeDefined();
    expect(buildAccountPatch(a, { ...draftFrom(a), square_off_time: "3pm" }).errors.square_off_time).toBeDefined();
  });
});

describe("buildLiveOnPatch", () => {
  const ok = { maxOrderValue: "50000", maxDailyLoss: "5000", consent: true };

  it("sends the caps and the acknowledgement together", () => {
    expect(buildLiveOnPatch(ok).patch).toEqual({ live_trading_enabled: true, max_order_value: 50000, max_daily_loss: 5000, live_trading_consent: true });
  });

  it("refuses without both caps or without consent, and says which", () => {
    expect(buildLiveOnPatch({ ...ok, maxOrderValue: "" }).error).toMatch(/single order/);
    expect(buildLiveOnPatch({ ...ok, maxDailyLoss: "0" }).error).toMatch(/lose in a day/);
    expect(buildLiveOnPatch({ ...ok, consent: false }).error).toMatch(/real money/);
    expect(buildLiveOnPatch({ ...ok, consent: false }).patch).toBeNull();
  });
});

describe("buildCredentialsPatch", () => {
  const none: Credentials = { has_dhan: false, has_delta: false, has_openrouter: false, dhan_client_id_masked: null };
  const connected: Credentials = { ...none, has_dhan: true, dhan_client_id_masked: "****1234" };

  it("needs both Dhan fields the first time", () => {
    expect(buildCredentialsPatch({ dhan_access_token: "tok" }, none).error).toMatch(/both/);
    expect(buildCredentialsPatch({ dhan_client_id: "id", dhan_access_token: "tok" }, none).error).toBeNull();
  });

  it("lets the daily token be renewed on its own once connected, sending nothing else", () => {
    const r = buildCredentialsPatch({ dhan_client_id: "  ", dhan_access_token: " newtok " }, connected);
    expect(r.error).toBeNull();
    expect(r.patch).toEqual({ dhan_access_token: "newtok" });
  });

  it("errors on an empty form rather than sending nothing silently", () => {
    expect(buildCredentialsPatch({ dhan_client_id: "", dhan_access_token: "" }, connected).error).toMatch(/Enter a value/);
  });

  it("needs both Delta fields the first time, and one key alone for OpenRouter", () => {
    expect(buildCredentialsPatch({ delta_api_key: "k" }, none).error).toMatch(/both/);
    expect(buildCredentialsPatch({ openrouter_api_key: "sk" }, none).error).toBeNull();
  });
});

describe("liveStatus", () => {
  it("is unavailable for crypto, otherwise follows the flag", () => {
    expect(liveStatus(account({ segment: "CRYPTO" }))).toBe("unavailable");
    expect(liveStatus(account({ live_trading_enabled: true }))).toBe("live");
    expect(liveStatus(account())).toBe("paper");
  });
});
