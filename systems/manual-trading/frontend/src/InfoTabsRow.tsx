import { useState } from "react";
import EventsPanel from "./EventsPanel";
import NewsPanel from "./NewsPanel";

// Full-width News / Events panel below the Live Chart (LiveChartPage renders
// it under .live-chart-layout), following the active chart instrument.
export default function InfoTabsRow({ segment, symbol }: { segment: string; symbol: string }) {
  const [tab, setTab] = useState<"news" | "events">("news");
  const sym = symbol.trim().toUpperCase();
  return (
    <div className="setup-card-row">
      <div className="setup-card-row-head">
        <div className="ctp-tabs" role="tablist">
          {(["news", "events"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t === "news" ? "News" : "Events"}
            </button>
          ))}
        </div>
        <span className="setup-card-row-hint muted">{sym}</span>
      </div>
      {tab === "news" ? <NewsPanel underlying={sym} segment={segment} /> : <EventsPanel underlying={sym} />}
    </div>
  );
}
