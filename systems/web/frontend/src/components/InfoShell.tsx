import type { ReactNode } from "react";
import { RefreshIcon } from "../chart/icons";

/** The one anatomy every market report shares (Pre-market / Brief / Pulse, News, Calendar), so they read as one family:
 *   head   - the title on the left; on the right the verdict or count, the age, and a refresh button
 *   lead   - one or two lines that say the point before any list
 *   rows   - a list in a single row style: optional time or figure, the main line, a muted line under it, a pill on the right
 *   foot   - one muted line of caveats
 * It reflows by itself: the head wraps on a phone, and on a wide screen the lists run in two columns (see .info-* in base.css). */
export function InfoHead({ title, status, onRefresh, busy, refreshLabel }: { title: ReactNode; status?: ReactNode; onRefresh?: () => void; busy?: boolean; refreshLabel?: string }) {
  return (
    <div className="info-head">
      <h2 className="section-title info-title">{title}</h2>
      <div className="info-status">
        {status}
        {onRefresh && (
          <button className={`tool ${busy ? "spin" : ""}`} onClick={onRefresh} disabled={busy} title={busy ? "Refreshing…" : "Refresh"} aria-label={refreshLabel ?? "Refresh"}>
            <RefreshIcon />
          </button>
        )}
      </div>
    </div>
  );
}

export function InfoLead({ children }: { children: ReactNode }) {
  return <p className="info-lead">{children}</p>;
}

export function InfoList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="info-list" role="list" aria-label={label}>
      {children}
    </div>
  );
}

/** A list heading (a day, a group of figures): small and muted, kept with the rows under it. */
export function InfoGroup({ title, children, label }: { title: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="info-group" aria-label={label}>
      <div className="info-group-title">{title}</div>
      {children}
    </section>
  );
}

export function InfoRow({ lead, primary, secondary, tertiary, aside }: { lead?: ReactNode; primary: ReactNode; secondary?: ReactNode; tertiary?: ReactNode; aside?: ReactNode }) {
  return (
    <div className={`info-row${lead != null ? " with-lead" : ""}`} role="listitem">
      {lead != null && <span className="info-row-lead num">{lead}</span>}
      <span className="info-row-main">
        <span className="info-row-primary">{primary}</span>
        {secondary && <span className="info-row-secondary">{secondary}</span>}
        {tertiary && <span className="info-row-tertiary">{tertiary}</span>}
      </span>
      {aside != null && <span className="info-row-aside">{aside}</span>}
    </div>
  );
}

export function InfoFoot({ children }: { children: ReactNode }) {
  return <p className="info-foot">{children}</p>;
}
