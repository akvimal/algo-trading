import { getUpcomingCalendar } from "../api/calendar";
import { ErrorNotice, Skeleton } from "../components/bits";
import { useResource } from "../hooks/useResource";
import { IMPACT_LABEL, KIND_LABEL, figures, groupByDay } from "../pages/calendarModel";

type Segment = "NSE" | "MCX" | "CRYPTO";

/** What is scheduled for the market on show over the next week: global macro releases, India's RBI decision and MoSPI releases,
 * exchange holidays, and expiry days. Times are IST; a row without one is an all-day or untimed item. Anything the list could
 * not include is named underneath, so a missing row is never mistaken for "nothing is scheduled". */
export function CalendarTab({ segment }: { segment: Segment }) {
  const cal = useResource(() => getUpcomingCalendar(segment), [segment], { pollMs: 10 * 60_000 });
  if (cal.loading) return <Skeleton lines={4} />;
  if (cal.error && !cal.data) return <ErrorNotice error={cal.error} onRetry={cal.reload} />;
  if (!cal.data) return null;
  const groups = groupByDay(cal.data.events);
  return (
    <div className="stack">
      <h2 className="section-title" style={{ margin: 0 }}>
        Next 7 days · {segment === "CRYPTO" ? "Crypto" : segment}
      </h2>
      {groups.length === 0 && <p className="dim">Nothing scheduled in the next 7 days.</p>}
      {groups.map((g) => (
        <section key={g.date} className="calendar-day" aria-label={g.label}>
          <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
            {g.label}
          </div>
          {g.events.map((e) => (
            <div className="calendar-row" key={`${e.time}-${e.title}`}>
              <span className="calendar-time num">{e.time ?? "All day"}</span>
              <span className="calendar-what">
                {e.title}
                <span className="faint" style={{ display: "block", fontSize: 12 }}>
                  {[KIND_LABEL[e.kind], e.detail, figures(e)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className={e.impact === "high" ? "pill warn" : "pill"} title={`${IMPACT_LABEL[e.impact]} impact`}>
                {IMPACT_LABEL[e.impact]}
              </span>
            </div>
          ))}
        </section>
      ))}
      {cal.data.notes.map((n) => (
        <span className="faint" style={{ fontSize: 12, display: "block" }} key={n}>
          {n}
        </span>
      ))}
      <span className="faint" style={{ fontSize: 12, display: "block" }}>Times are IST. Scheduled dates can change; context, not a recommendation.</span>
    </div>
  );
}
