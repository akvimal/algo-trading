import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/http";
import type { LiveEligibility, MistakeSummary, Segment } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import { Empty, ErrorNotice, Skeleton } from "../components/bits";
import { ReadinessVisual } from "../components/ReadinessVisual";
import { Signed } from "../components/bits";
import { SEGMENTS } from "../config";
import { formatPnl } from "../format";
import { useResource, type Resource } from "../hooks/useResource";
import { FIXED_AT, HABITS, PARTS } from "./learnCatalog";
import { focusHabit, habitRows, runLabel, type HabitRow } from "./learnModel";
import { LEVEL_LABEL, tagLabel } from "./journalModel";

const SEGMENT_LABEL: Record<Segment, string> = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" };
const parseSegment = (v: string | null): Segment => ((SEGMENTS as readonly string[]).includes(v ?? "") ? (v as Segment) : "NSE");

/** Learn: are you ready for live trading, which habit to fix next (from your own reviewed trades), and the learning path.
 * Reading changes nothing here: every tick comes from what you actually did, and live trading stays behind its own checks. */
export function LearnPage() {
  const [params, setParams] = useSearchParams();
  const { markets } = useProfile();
  const segment = parseSegment(params.get("segment"));
  const elig = useResource(() => api<LiveEligibility>("execution", `/live-eligibility/${segment}`), [segment]);
  const mistakes = useResource(() => api<MistakeSummary>("execution", `/trade-review/summary/${segment}`), [segment]);

  return (
    <div className="stack">
      <h1>Learn</h1>
      <p className="dim" style={{ margin: 0 }}>
        Where you stand, what to fix first, and the path from the basics to live trading. It teaches process and risk, never what to buy.
      </p>
      <div className="chips" role="group" aria-label="Account">
        {SEGMENTS.filter((s) => markets.includes(s) || s === segment).map((s) => (
          <button key={s} aria-pressed={segment === s} onClick={() => setParams({ segment: s }, { replace: true })}>
            {SEGMENT_LABEL[s]}
          </button>
        ))}
      </div>

      <Readiness elig={elig} />
      <Habits mistakes={mistakes} segment={segment} />
      <Path />
    </div>
  );
}

function Readiness({ elig }: { elig: Resource<LiveEligibility> }) {
  if (elig.loading) return <Skeleton lines={3} />;
  if (elig.error) return <ErrorNotice error={elig.error} onRetry={elig.reload} />;
  if (!elig.data) return null;
  return <ReadinessVisual eligibility={elig.data} />;
}

function Habits({ mistakes, segment }: { mistakes: Resource<MistakeSummary>; segment: Segment }) {
  return (
    <div id="habits" className="stack" data-testid="habits">
      <h2 className="section-title">Fix a habit</h2>
      {mistakes.loading && <Skeleton lines={3} />}
      {mistakes.error && <ErrorNotice error={mistakes.error} onRetry={mistakes.reload} />}
      {mistakes.data && <HabitList summary={mistakes.data} segment={segment} />}
      <details className="card">
        <summary><strong>Every habit and its rule</strong> <span className="faint">({HABITS.length})</span></summary>
        <div className="stack" style={{ marginTop: 8 }}>
          {HABITS.map((h) => <HabitDetail key={h.tag} habit={h} />)}
        </div>
      </details>
    </div>
  );
}

function HabitList({ summary, segment }: { summary: MistakeSummary; segment: Segment }) {
  const rows = habitRows(summary);
  const focus = focusHabit(rows);
  return (
    <>
      {summary.pending > 0 && (
        <div className="card" data-testid="review-first">
          <strong>{summary.pending} closed trade{summary.pending === 1 ? " is" : "s are"} not reviewed yet.</strong>{" "}
          <span className="dim">This list is only as accurate as your reviews.</span>{" "}
          <Link to={`/portfolio?segment=${segment}&tab=review`}>Review now</Link>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty title={summary.reviewed === 0 ? "No reviewed trades yet" : "No mistakes on record"}>
          {summary.reviewed === 0
            ? "Review a closed trade (“What went wrong?”) and the habits that cost you most show up here, with a rule and a drill for each."
            : "Nothing to fix in your reviewed trades. Keep reviewing and this stays honest."}
        </Empty>
      ) : (
        <>
          {focus && (
            <div className="card" data-testid="focus">
              <div className="dim" style={{ fontSize: 12 }}>Start with</div>
              <strong>{tagLabel(focus.habit.tag)}</strong> <span className="faint">· {LEVEL_LABEL[focus.habit.level]}</span>
              <p style={{ margin: "6px 0 0" }}>{focus.habit.rule}</p>
              <p className="dim" style={{ margin: "4px 0 0" }}>Drill: {focus.habit.drill}</p>
            </div>
          )}
          {rows.map((r) => <HabitRowView key={r.habit.tag} row={r} />)}
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            One habit at a time, earliest step first: no study explains no plan, and no plan explains the rest. A habit is fixed after {FIXED_AT} clean trades in a row.
          </p>
        </>
      )}
    </>
  );
}

function HabitRowView({ row }: { row: HabitRow }) {
  return (
    <details className="card" data-testid="habit-row">
      <summary>
        <span className="row" style={{ display: "inline-flex", width: "calc(100% - 20px)", gap: 8 }}>
          <span>
            {tagLabel(row.habit.tag)} <span className="faint">· {LEVEL_LABEL[row.habit.level]} · {row.trades}×</span>
          </span>
          <span className="row" style={{ gap: 8 }}>
            <Signed value={row.pnl} text={formatPnl(row.pnl)} />
            <span className={`pill ${row.fixed ? "up" : "warn"}`}>{runLabel(row)}</span>
          </span>
        </span>
      </summary>
      <HabitDetail habit={row.habit} />
    </details>
  );
}

function HabitDetail({ habit }: { habit: (typeof HABITS)[number] }) {
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <strong>{tagLabel(habit.tag)} <span className="faint">· {LEVEL_LABEL[habit.level]}</span></strong>
      <span><strong>Rule:</strong> {habit.rule}</span>
      <span className="dim"><strong>Why:</strong> {habit.why}</span>
      <span className="dim"><strong>Drill:</strong> {habit.drill} {habit.auto ? "The app counts it from your orders." : "Counted from your own review tags."}</span>
      <span className="faint" style={{ fontSize: 12 }}>Read first: {habit.readFirst.map((id) => lessonTitle(id)).join(", ")}</span>
    </div>
  );
}

const lessonTitle = (id: string) => PARTS.flatMap((p) => p.lessons).find((l) => l.id === id)?.title ?? id;

function Path() {
  return (
    <div className="stack" data-testid="path">
      <h2 className="section-title">The learning path</h2>
      <p className="dim" style={{ margin: 0 }}>Fundamentals first, then risk and the plan, then habits, then one strategy at a time. The lessons are being written one at a time; the list shows what is coming.</p>
      {PARTS.map((part) => (
        <details key={part.id} className="card">
          <summary>
            <strong>Part {part.id}: {part.title}</strong> <span className="faint">· {part.lessons.length} lessons</span>
            <span className="dim" style={{ display: "block", fontSize: 13 }}>{part.blurb}</span>
          </summary>
          <div style={{ marginTop: 8 }}>
            {part.lessons.map((l) => (
              <div key={l.id} className="list-row" data-testid="lesson">
                <span>
                  <span className="faint">{l.id}</span> {l.title}
                  <span className="dim" style={{ display: "block", fontSize: 13 }}>{l.blurb}</span>
                </span>
                <span className="pill">Coming soon</span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
