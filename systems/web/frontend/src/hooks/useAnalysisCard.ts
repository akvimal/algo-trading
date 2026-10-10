import { useEffect, useRef, useState } from "react";
import type { IdeaAnalysis } from "../api/ideas";
import { composeAnalysisCard } from "../chart/analysisCard";

export type AnalysisCardState = {
  /** The finished card as a PNG data URL. */
  card: string | null;
  /** True once the card has been built or has failed to be (so a post need not wait on it any longer). */
  settled: boolean;
  /** Why there is no card, when the browser could not draw it. */
  problem: string | null;
};

const NONE: AnalysisCardState = { card: null, settled: false, problem: null };

/** The picture a published analysis goes out as (the chart with the verdict, the two reads and the price levels), built once the analysis is in.
 * `getChart` supplies the chart picture to put on top: the saved note's, or the live chart's. It may return null (no chart is available) and the
 * card is then made without one. If the browser cannot draw it at all, `problem` says so and the post goes out as text. */
export function useAnalysisCard({ enabled, analysis, title, getChart }: { enabled: boolean; analysis: IdeaAnalysis | null; title: string; getChart: () => Promise<string | null> }): AnalysisCardState {
  const [state, setState] = useState<AnalysisCardState>(NONE);
  const chartSource = useRef(getChart);
  chartSource.current = getChart;

  useEffect(() => {
    if (!enabled || !analysis) {
      setState(NONE);
      return;
    }
    let live = true;
    setState(NONE);
    (async () => {
      try {
        const chart = await chartSource.current().catch(() => null);
        const card = await composeAnalysisCard({ analysis, title, chart });
        if (live) setState(card ? { card, settled: true, problem: null } : { card: null, settled: true, problem: "this browser could not draw the picture, so the analysis goes out as text" });
      } catch {
        if (live) setState({ card: null, settled: true, problem: "the picture could not be built, so the analysis goes out as text" });
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, analysis, title]);

  return state;
}
