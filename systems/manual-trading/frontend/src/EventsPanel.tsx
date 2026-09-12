import { useEffect, useState } from "react";

import { type EconomicEvent, fetchCalendar } from "./api";
import { formatCompact } from "./manualOrder";

// Events tab inside ChartTradePanel - the week's medium/high-impact
// economic calendar (server-side cache in market-data's
// app/providers/calendar.py, sourced from Forex Factory's public feed).
// Every underlying currently maps to USD (see that module's comment), so
// this list is the same across every chart symbol - still fetched per
// underlying for a consistent shape with News, in case that changes later.
const POLL_MS = 5 * 60 * 1000;

const IMPACT_LABEL: Record<EconomicEvent["impact"], string> = {
  high: "High",
  medium: "Med",
  low: "Low",
  holiday: "Holiday",
};

export default function EventsPanel({ underlying }: { underlying: string }) {
  const [events, setEvents] = useState<EconomicEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const rows = await fetchCalendar(underlying);
        if (!cancelled) {
          setEvents(rows);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    setEvents(null);
    setError(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [underlying]);

  if (error) return <p className="ctp-events-error muted">Couldn't load the calendar: {error}</p>;
  if (events === null) return <p className="muted">Loading calendar…</p>;
  if (events.length === 0) return <p className="muted">No medium/high-impact events this week.</p>;

  const now = Date.now();

  return (
    <div className="ctp-events">
      {events.map((e, i) => {
        const past = Date.parse(e.timestamp) < now;
        return (
          <div key={`${e.title}-${e.timestamp}-${i}`} className={`ctp-events-row${past ? " ctp-events-past" : ""}`}>
            <div className="ctp-events-title">
              <span className={`ctp-events-impact ctp-events-impact-${e.impact}`}>{IMPACT_LABEL[e.impact]}</span>
              {e.title}
            </div>
            <div className="ctp-events-meta muted">
              {e.currency} · {formatCompact(e.timestamp)}
              {(e.forecast || e.previous) && (
                <>
                  {" · "}
                  {e.forecast && <>fcst {e.forecast}</>}
                  {e.forecast && e.previous && " / "}
                  {e.previous && <>prev {e.previous}</>}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
