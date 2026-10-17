import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/http";
import type { BotSession, GridBand, ManualSession, SessionGrids as SessionGridsData } from "../api/types";
import { formatPnl } from "../format";
import { useResource } from "../hooks/useResource";

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayParts = (iso: string) => ({ month: MONTH[Number(iso.slice(5, 7)) - 1], day: String(Number(iso.slice(8, 10))) });

type Row = { key: string; label: string; band: (i: number) => GridBand; title: (i: number) => string; hatched?: (i: number) => boolean };

/** The shape shared by both grids: sessions across (newest first), a row per question, a coloured cell per answer. */
function Grid({ title, dates, rows, footer, legend, testId }: {
  title: string; dates: string[]; rows: Row[]; footer?: (i: number) => ReactNode; legend: ReactNode; testId: string;
}) {
  return (
    <div className="card sgrid" data-testid={testId}>
      <h2 className="section-title" style={{ margin: "0 0 8px" }}>{title}</h2>
      <div className="sgrid-table" style={{ gridTemplateColumns: `52px repeat(${dates.length}, minmax(0, 1fr))` }} role="table" aria-label={title}>
        <span />
        {dates.map((d) => {
          const p = dayParts(d);
          return (
            <span key={d} className="sgrid-head" role="columnheader">
              <span className="faint">{p.month}</span>
              <strong>{p.day}</strong>
            </span>
          );
        })}
        {rows.map((r) => (
          <div key={r.key} className="sgrid-row" role="row">
            <span className="sgrid-label">{r.label}</span>
            {dates.map((d, i) => (
              <span key={d} role="cell" className={`sgrid-cell ${r.band(i)}${r.hatched?.(i) ? " hatched" : ""}`} title={r.title(i)} aria-label={`${r.label}, ${d}: ${r.title(i)}`} />
            ))}
          </div>
        ))}
        {footer && (
          <>
            <span className="sgrid-label faint" style={{ fontSize: 11 }}>To review</span>
            {dates.map((d, i) => <span key={d} className="sgrid-foot">{footer(i)}</span>)}
          </>
        )}
      </div>
      <div className="sgrid-legend">{legend}</div>
    </div>
  );
}

const Swatch = ({ band, children }: { band: GridBand; children: ReactNode }) => (
  <span className="sgrid-key"><i className={`sgrid-cell ${band}`} /> {children}</span>
);

export function ManualGrid({ sessions }: { sessions: ManualSession[] }) {
  const cell = (k: "study" | "plan" | "trade", noun: string): Pick<Row, "band" | "title" | "hatched"> => ({
    band: (i) => sessions[i][k].band,
    title: (i) => {
      const s = sessions[i];
      const c = s[k];
      if (c.of === 0) return `${s.unreviewed} of ${s.trades} not reviewed yet: no verdict`;
      const base = `${c.ok} of ${c.of} reviewed trades ${noun}`;
      return s.unreviewed > 0 ? `${base} (${s.unreviewed} not reviewed yet)` : base;
    },
    hatched: (i) => sessions[i][k].of === 0,
  });
  const rows: Row[] = [
    { key: "study", label: "Study", ...cell("study", "were analysed before entry") },
    { key: "plan", label: "Plan", ...cell("plan", "were defined before entry") },
    { key: "trade", label: "Trade", ...cell("trade", "followed the plan") },
  ];
  return (
    <Grid
      testId="manual-grid"
      title="Your last sessions"
      dates={sessions.map((s) => s.date)}
      rows={rows}
      footer={(i) =>
        sessions[i].unreviewed > 0 ? (
          <Link to="/performance?tab=review&section=journal" className="pill warn" title={`${sessions[i].unreviewed} not reviewed yet`} aria-label={`${sessions[i].unreviewed} not reviewed, ${sessions[i].date}`}>
            {sessions[i].unreviewed}
          </Link>
        ) : null
      }
      legend={
        <>
          <Swatch band="good">above 80%</Swatch>
          <Swatch band="mid">50 to 80%</Swatch>
          <Swatch band="poor">below 50%</Swatch>
          <span className="sgrid-key"><i className="sgrid-cell none hatched" /> not reviewed</span>
        </>
      }
    />
  );
}

export function BotGrid({ sessions }: { sessions: BotSession[] }) {
  const rows: Row[] = [
    { key: "result", label: "Result", band: (i) => sessions[i].result, title: (i) => `${formatPnl(sessions[i].pnl)} from ${sessions[i].trades} trade${sessions[i].trades === 1 ? "" : "s"}` },
    { key: "wins", label: "Wins", band: (i) => sessions[i].wins_band, title: (i) => `${sessions[i].wins} of ${sessions[i].trades} won` },
    {
      key: "clean", label: "Clean run", band: (i) => sessions[i].clean,
      title: (i) => {
        const s = sessions[i];
        if (s.failed) return `${s.failed} decision${s.failed === 1 ? "" : "s"} failed`;
        if (s.no_stop) return `${s.no_stop} trade${s.no_stop === 1 ? "" : "s"} had no stop at entry`;
        return "Every trade had a stop at entry and nothing failed";
      },
    },
  ];
  return (
    <Grid
      testId="bot-grid"
      title="Bot, last sessions"
      dates={sessions.map((s) => s.date)}
      rows={rows}
      legend={
        <>
          <Swatch band="good">profit, clean</Swatch>
          <Swatch band="mid">flat, a stop missing</Swatch>
          <Swatch band="poor">loss, something failed</Swatch>
        </>
      }
    />
  );
}

/** The last ten sessions, for the home page. `useSessionGrids` is separate so the page can choose between this and the first-week checklist. */
export function useSessionGrids() {
  return useResource(() => api<SessionGridsData>("execution", "/trade-review/sessions?limit=10"), []);
}

export function SessionGrids({ grids }: { grids: SessionGridsData }) {
  return (
    <>
      {grids.manual.length > 0 && <ManualGrid sessions={grids.manual} />}
      {grids.bot.length > 0 && <BotGrid sessions={grids.bot} />}
    </>
  );
}

export const hasSessions = (g: SessionGridsData | null | undefined) => (g?.manual?.length ?? 0) + (g?.bot?.length ?? 0) > 0;
