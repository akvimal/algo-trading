import { getUpcomingCalendar } from "../api/calendar";
import { ErrorNotice, Skeleton } from "../components/bits";
import { InfoFoot, InfoGroup, InfoHead, InfoLead, InfoList, InfoRow } from "../components/InfoShell";
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
  const total = cal.data.events.length;
  const high = cal.data.events.filter((e) => e.impact === "high").length;
  return (
    <div className="stack info-section" data-testid="calendar-report">
      <InfoHead
        title={`Next 7 days · ${segment === "CRYPTO" ? "Crypto" : segment}`}
        status={high > 0 ? <span className="pill warn">{high} high impact</span> : total > 0 ? <span className="pill">{total} scheduled</span> : null}
        onRefresh={cal.reload}
        busy={cal.refreshing}
        refreshLabel="Refresh the calendar"
      />
      {groups.length === 0 ? (
        <InfoLead>Nothing scheduled in the next 7 days.</InfoLead>
      ) : (
        <InfoLead>
          {total} item{total === 1 ? "" : "s"} over the next 7 days{high > 0 ? `, ${high} of them high impact` : ""}. Times are IST.
        </InfoLead>
      )}
      <InfoList label="Calendar">
        {groups.map((g) => (
          <InfoGroup key={g.date} title={g.label} label={g.label}>
            {g.events.map((e) => (
              <InfoRow
                key={`${e.time}-${e.title}`}
                lead={e.time ?? "All day"}
                primary={e.title}
                secondary={[KIND_LABEL[e.kind], e.detail, figures(e)].filter(Boolean).join(" · ")}
                aside={<span className={e.impact === "high" ? "pill warn" : "pill"} title={`${IMPACT_LABEL[e.impact]} impact`}>{IMPACT_LABEL[e.impact]}</span>}
              />
            ))}
          </InfoGroup>
        ))}
      </InfoList>
      {cal.data.notes.map((n) => (
        <InfoFoot key={n}>{n}</InfoFoot>
      ))}
      <InfoFoot>Times are IST. Scheduled dates can change; context, not a recommendation.</InfoFoot>
    </div>
  );
}
