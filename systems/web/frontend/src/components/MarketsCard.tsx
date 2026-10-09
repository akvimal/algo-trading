import { useState } from "react";
import { api } from "../api/http";
import type { MarketSentiment } from "../api/types";
import { useResource } from "../hooks/useResource";
import { defaultMarket } from "../pages/premarketModel";
import { useMediaQuery, WIDE_QUERY } from "../workstation/useMediaQuery";
import { MarketsPanel, SEGMENT_LABEL, type MarketSegment } from "./MarketsPanel";

/** The Today page's Markets card: the same market reports as the Trade page's "Markets" chip (`MarketsPanel`), opening on the market
 * that is trading now, with the open-interest read for the chosen market in the header. On a phone it starts folded to that header
 * row (nothing else is fetched until it is opened); on a wide screen it starts open. Context, never a recommendation. */
export function MarketsCard({ markets }: { markets: MarketSegment[] }) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [open, setOpen] = useState<boolean | null>(null); // null = not chosen yet, follow the screen width
  const [view, setView] = useState<MarketSegment>(() => defaultMarket(markets));
  // The OI read loads on its own: its failure never blocks (or replaces) anything else on the page.
  const pulse = useResource(() => api<MarketSentiment>("marketData", "/options/sentiment"), [], { pollMs: 60_000 });
  const expanded = open ?? wide;
  const read = pulse.data?.exchanges[view];

  return (
    <section className="card stack markets-card" aria-label="Markets">
      <div className="row" style={{ alignItems: "center" }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Markets
        </h2>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {read ? (
            <span className="pill" title={`Open-interest reading for ${SEGMENT_LABEL[view]}, for context only`}>
              OI {read.direction} · {read.strength}
            </span>
          ) : pulse.error ? (
            <span className="faint" style={{ fontSize: 12 }}>OI read unavailable</span>
          ) : null}
          <button className="btn btn-small" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
            {expanded ? "Hide" : "Show"}
          </button>
        </span>
      </div>
      {!expanded && markets.length > 1 && (
        <div className="chips" role="group" aria-label="Market">
          {markets.map((s) => (
            <button
              key={s}
              aria-pressed={view === s}
              onClick={() => {
                setView(s);
                setOpen(true);
              }}
            >
              {SEGMENT_LABEL[s]}
            </button>
          ))}
        </div>
      )}
      {/* `view` only seeds the panel when it mounts (it opens on the pill tapped while folded); after that the panel owns its own pills. */}
      {expanded && <MarketsPanel segment={view} markets={markets} onViewChange={setView} />}
      <span className="faint" style={{ fontSize: 12 }}>Context only, not a recommendation.</span>
    </section>
  );
}
