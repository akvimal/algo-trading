import { useMemo, useRef } from "react";
import { getExpiries, getOiSummary } from "../api/trade";
import { hasOiChain, oiLevelLines, type OiLevelLine } from "../chart/oiLevels";
import { useResource } from "../hooks/useResource";
import type { PaneData } from "./usePaneData";

const POLL_MS = 60_000;
const NONE: OiLevelLine[] = [];

/** The support and resistance lines for one chart, read from its option chain, refreshed every minute
 * while the layer is on. The expiry is looked up once and kept between refreshes (the lookup can be slow
 * and must not hold up every reading); it is looked up again only after a failed reading. An instrument
 * with no option chain, or the layer being off, costs no requests. */
export function useOiLevels(pane: PaneData, base: string, enabled: boolean): OiLevelLine[] {
  const on = enabled && pane.exchange != null && pane.symbol != null && hasOiChain(base);
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
  return useMemo(() => (on && summary.data ? oiLevelLines(summary.data) : NONE), [on, summary.data]);
}
