import { useEffect, useState } from "react";
import { getAnalysis } from "../api/analysis";
import { ApiError } from "../api/http";
import type { IdeaAnalysis } from "../api/ideas";
import { toIdeaAnalysis } from "../pages/ideasModel";

export type IdeaAnalysisState = { analysis: IdeaAnalysis | null; loading: boolean; error: string | null };

// A stock's analysis is kept for a few minutes, so ticking, unticking and ticking again (or opening the same stock's note twice) does not read it again.
const KEEP_MS = 10 * 60_000;
const kept = new Map<string, { at: number; analysis: IdeaAnalysis }>();

/** The AI analysis of one stock in the form a post carries it, read once `enabled` is true (the person ticked "include the AI analysis").
 * The first read of a stock can take up to a minute; until it is in, `analysis` is null and `loading` is true. A failure is reported in
 * `error` and the post simply cannot include it: it is never dropped silently. */
export function useIdeaAnalysis(symbol: string, enabled: boolean): IdeaAnalysisState {
  const [state, setState] = useState<IdeaAnalysisState>({ analysis: null, loading: false, error: null });

  useEffect(() => {
    if (!enabled) {
      setState({ analysis: null, loading: false, error: null });
      return;
    }
    const hit = kept.get(symbol);
    if (hit && Date.now() - hit.at < KEEP_MS) {
      setState({ analysis: hit.analysis, loading: false, error: null });
      return;
    }
    let live = true;
    setState({ analysis: null, loading: true, error: null });
    getAnalysis(symbol)
      .then((a) => {
        const analysis = toIdeaAnalysis(a);
        kept.set(symbol, { at: Date.now(), analysis });
        if (live) setState({ analysis, loading: false, error: null });
      })
      .catch((e) => live && setState({ analysis: null, loading: false, error: e instanceof ApiError ? e.message : "Could not read the AI analysis." }));
    return () => {
      live = false;
    };
  }, [symbol, enabled]);

  return state;
}

/** Forgets what was kept (for tests). */
export const clearIdeaAnalysisCache = () => kept.clear();
