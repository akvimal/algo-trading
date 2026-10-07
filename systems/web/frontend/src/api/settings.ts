import { api } from "./http";
import type { Account, Credentials, Ltp, Segment } from "./types";
import type { KeyField } from "../pages/settingsModel";

export const getAccounts = () => api<Account[]>("execution", "/accounts");

/** Partial update: only the keys present are changed; an explicit null clears a limit. */
export const updateAccount = (segment: Segment, patch: Record<string, unknown>) =>
  api<Account>("execution", `/accounts/${segment}`, { method: "PUT", json: patch });

/** Sets the balance back to the starting balance and starts a new equity curve. */
export const resetAccount = (segment: Segment) => api<Account>("execution", `/accounts/${segment}/reset`, { method: "POST" });

export const getCredentials = () => api<Credentials>("accounts", "/credentials");

/** The secrets are write-only: the server never sends them back, only whether they are set. */
export const saveCredentials = (patch: Partial<Record<KeyField, string>>) => api<Credentials>("accounts", "/credentials", { method: "PUT", json: patch });

/** "Do live prices work for me?": one real quote, on whichever keys the platform uses for this
 * person. It proves the connection end to end without placing anything. */
export const checkLiveData = () => api<Ltp>("marketData", "/quotes/ltp?exchange=NSE&symbol=RELIANCE");

// ---- the platform's Dhan token (admin only): the one the background jobs, shared feed and option-chain reads use. It comes from the Dhan token the
// owner saved above (the first admin's), is renewed automatically, and the renewed token is saved back, so there is only one copy.

export type PlatformToken = { token_expires_at: string | null; has_access_token: boolean; dhan_client_id: string | null };
export type PlatformTokenResult = { adopted?: boolean; reason?: string; renewed?: boolean; saved_back_to_settings?: boolean; token_expires_at?: string | null };

export const getPlatformToken = () => api<PlatformToken>("marketData", "/dhan/token-status");
/** Use the token saved on this page now, instead of waiting for the periodic check (only if it outlives the one in use). */
export const refreshPlatformToken = () => api<PlatformTokenResult>("marketData", "/dhan/refresh", { method: "POST" });
/** Renew with Dhan for a fresh 24 hours (works only while the token is still valid) and save the renewed token back. */
export const renewPlatformToken = () => api<PlatformTokenResult>("marketData", "/dhan/renew-token", { method: "POST" });
