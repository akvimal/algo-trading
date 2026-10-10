import { SERVICE_URLS } from "../config";
import { api } from "./http";

export type Bias = "bullish" | "bearish" | "neutral";
export type Agreement = "aligned" | "mixed" | "conflicting" | "technical_only";

export type Level = { low: number; high: number; basis: string; timeframe: "weekly" | "daily"; distance_pct: number };

/** One stock's combined read (GET /analysis/{symbol}): its chart and its business side by side, and one verdict over both. */
export type StockAnalysis = {
  symbol: string;
  as_of: string;
  price: number;
  verdict: { bias: Bias; confidence: number; agreement: Agreement; headline: string; reading: string };
  technical: { bias: Bias; confidence: number; trend_strength: "trending" | "decelerating" | "ranging"; points: string[]; support: Level[]; resistance: Level[] };
  fundamental: {
    available: boolean;
    bias: Bias | null;
    confidence: number | null;
    summary: string | null;
    pros: string[];
    cons: string[];
    reasons: string[];
    fetched_at: string | null;
    /** Why there is no business read, in words. */
    note: string | null;
    /** True when the only thing missing is the person's OpenRouter key. */
    needs_key: boolean;
  };
  signals: { category: string; direction: Bias | null; text: string }[];
};

/** On demand. The chart half is instant; the business half is the shared AI read of the company's screener.in page, which for a stock nobody
 * has looked at before takes about ten seconds to a minute (and uses the person's own OpenRouter key). `refresh` asks for a new capture of
 * that page, which the server only makes when the stored one is over a day old. */
export const getAnalysis = (symbol: string, refresh = false) => api<StockAnalysis>("signalEngine", `/analysis/${encodeURIComponent(symbol)}${refresh ? "?refresh=true" : ""}`);

/** The picture the AI read, for checking it (public: the browser loads it as a plain link). */
export const screenshotUrl = (symbol: string) => `${SERVICE_URLS.signalEngine}/weekly-advisor/fundamentals/${encodeURIComponent(symbol)}/screenshot`;
