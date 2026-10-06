import { ApiError, api } from "./http";
import type { PremarketReport } from "./types";

/** The latest pre-market bias report, or null before the first one has ever been written (a 404, not an error). */
export async function getPremarket(): Promise<PremarketReport | null> {
  try {
    const report = await api<PremarketReport>("marketData", "/premarket");
    // A card on the home screen must never take the page down over a malformed answer.
    return report && report.rules && Array.isArray(report.inputs) ? report : null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Re-run today's report now. Needs a sign-in; the server spaces repeat calls out (429). */
export const refreshPremarket = () => api<PremarketReport>("marketData", "/premarket/refresh", { method: "POST" });
