import { SERVICE_URLS } from "../config";
import { api } from "./http";

/** The server's code for "this needs your OpenRouter key" (a 409 from GET /fundamentals/{symbol}). */
export const OPENROUTER_KEY_REQUIRED = "openrouter_key_required";

/** One stock's fundamentals as the AI read them off its screener.in page. */
export type Fundamentals = {
  symbol: string;
  bias: "bullish" | "bearish" | "neutral";
  /** 0 to 1. */
  confidence: number | null;
  summary: string | null;
  pros: string[];
  cons: string[];
  reasons: string[];
  /** When the page was captured. */
  fetched_at: string | null;
  /** True only when a refresh was asked for and a fresh capture was made. */
  refreshed: boolean;
};

/** On demand: the first read of a stock opens screener.in and asks the AI (up to about a minute); after that it is served from the shared
 * cache. `refresh` asks for a new capture, which the server only does when the read is more than a day old. */
export const getFundamentals = (symbol: string, refresh = false) =>
  api<Fundamentals>("signalEngine", `/fundamentals/${encodeURIComponent(symbol)}${refresh ? "?refresh=true" : ""}`);

/** The picture the AI read, for checking it (public: the browser loads it as a plain link). */
export const fundamentalsScreenshotUrl = (symbol: string) => `${SERVICE_URLS.signalEngine}/weekly-advisor/fundamentals/${encodeURIComponent(symbol)}/screenshot`;
