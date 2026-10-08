import { api } from "./http";
import type { NewsDigest } from "./types";

/** The AI-read headline digest for one symbol. `segment` lets a stock outside the desk's fixed chart symbols fall back to a generic NSE feed. */
export const getNews = (underlying: string, segment: string) =>
  api<NewsDigest>("marketData", `/news?underlying=${encodeURIComponent(underlying)}&segment=${encodeURIComponent(segment)}`);
