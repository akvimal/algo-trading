import { useMemo, useRef } from "react";
import { getExpiries, getOiSummary, getSentimentHistory } from "../api/trade";
import type { OiSummary, SentimentHistoryPoint } from "../api/types";
import { hasOiChain, oiLevelLines, type OiLevelLine } from "../chart/oiLevels";
import { useResource } from "../hooks/useResource";
import type { PaneData } from "./usePaneData";

const POLL_MS = 60_000;
const NONE_LEVELS: OiLevelLine[] = [];
const NONE_POINTS: SentimentHistoryPoint[] = [];

export type OiData = { summary: OiSummary | null; sentiment: SentimentHistoryPoint[]; levels: OiLevelLine[] };

/** The option-chain read for one chart's instrument: the raw summary and today's sentiment history (for
 * the always-on OI strip under the chart), plus the derived support/resistance lines (only drawn on the
 * chart itself when the person has switched that layer on — see chart/oiLevels.ts). Both refresh every
 * minute. An instrument with no option chain costs no requests at all.
 *
 * The expiry is looked up once and kept between refreshes (that lookup can be slow and must not hold up
 * every reading); it is looked up again only after a failed reading. The two fetches (chain, sentiment)
 * run independently, so a slow or failing sentiment poll never takes the chain reading down with it. */
export function useOiData(pane: PaneData, base: string, wanted = true): OiData {
  // `wanted` is false when neither the strip nor the on-chart levels are showing: nothing reads the chain, so it is not polled.
  const on = wanted && pane.exchange != null && pane.symbol != null && hasOiChain(base);
  const cached = useRef<{ key: string; expiry: string } | null>(null);
  const summary = useResource(
    async () => {
      const key = `${pane.exchange}:${pane.symbol}`;
      try {
        if (cached.current?.key !== key) {
          const expiries = await getExpiries(pane.exchange!, pane.symbol!);
          if (expiries.length === 0) return null;
          cached.current = { key, expiry: expiries[0] };
        }
        return await getOiSummary(pane.exchange!, pane.symbol!, cached.current.expiry);
      } catch (e) {
        cached.current = null;
        throw e;
      }
    },
    [pane.exchange, pane.symbol],
    { pollMs: POLL_MS, enabled: on },
  );
  const sentiment = useResource(() => getSentimentHistory(base).then((d) => d.points), [base], { pollMs: POLL_MS, enabled: on });
  return {
    summary: on ? (summary.data ?? null) : null,
    sentiment: on ? (sentiment.data ?? NONE_POINTS) : NONE_POINTS,
    levels: useMemo(() => (on && summary.data ? oiLevelLines(summary.data) : NONE_LEVELS), [on, summary.data]),
  };
}
