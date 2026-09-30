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
