import { useState } from "react";
import { api } from "../api/http";
import type { MarketSentiment } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import { MarketsPanel, SEGMENT_LABEL, type MarketSegment } from "../components/MarketsPanel";
import { useResource } from "../hooks/useResource";
import { defaultMarket } from "./premarketModel";

/** Markets: the same reports as the Trade page's Markets chip (pre-market bias, headlines, calendar, open interest), opening on the market that is
 * trading now, with the open-interest read for the chosen market beside the heading. Context, never a recommendation. */
export function MarketsPage() {
  const { markets } = useProfile();
  const [view, setView] = useState<MarketSegment>(() => defaultMarket(markets));
  // The OI read loads on its own: its failure never blocks (or replaces) anything else on the page.
  const pulse = useResource(() => api<MarketSentiment>("marketData", "/options/sentiment"), [], { pollMs: 60_000 });
  const read = pulse.data?.exchanges[view];

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Markets</h1>
        {read ? (
          <span className="pill" title={`Open-interest reading for ${SEGMENT_LABEL[view]}, for context only`}>
            OI {read.direction} · {read.strength}
          </span>
        ) : pulse.error ? (
          <span className="faint" style={{ fontSize: 12 }}>OI read unavailable</span>
        ) : null}
      </div>
      {markets.length > 0 ? (
        <section className="card stack markets-card" aria-label="Markets">
          <MarketsPanel segment={view} markets={markets} onViewChange={setView} />
          <span className="faint" style={{ fontSize: 12 }}>Context only, not a recommendation.</span>
        </section>
      ) : (
        <p className="dim">Pick the markets you practise in More to see their reports here.</p>
      )}
    </div>
  );
}
