import { useEffect, useRef, useState } from "react";
import { HABITS, PARTS, type Habit, type Level } from "../pages/learnCatalog";
import { runLabel, type HabitRow } from "../pages/learnModel";
import { LEVEL_LABEL, tagLabel } from "../pages/journalModel";

const LEVELS: { level: Level; question: string; color: string }[] = [
  { level: "study", question: "Did you analyse it first?", color: "var(--accent)" },
  { level: "plan", question: "Did you define the trade?", color: "var(--warn)" },
  { level: "execution", question: "Did you follow the plan?", color: "var(--up)" },
];

const lessonTitle = (id: string) => PARTS.flatMap((p) => p.lessons).find((l) => l.id === id)?.title ?? id;

/** One habit, readable at a glance: the rule is the headline, then why, the drill, and what to read first as chips. */
export function HabitDetailCard({ habit, onClose }: { habit: Habit; onClose?: () => void }) {
  return (
    <div className="card" data-testid="habit-detail" style={{ margin: 0, borderLeft: `4px solid ${LEVELS.find((l) => l.level === habit.level)?.color}` }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span>
          <strong>{tagLabel(habit.tag)}</strong> <span className="faint">· {LEVEL_LABEL[habit.level]}</span>
        </span>
        {onClose && <button className="btn btn-small" onClick={onClose} aria-label="Close">×</button>}
      </div>
      <p style={{ fontSize: 17, lineHeight: 1.4, margin: "10px 0 14px" }}>{habit.rule}</p>
      <div className="habit-facts">
        <div>
          <div className="dim habit-fact-label">Why it matters</div>
          <div>{habit.why}</div>
        </div>
        <div>
          <div className="dim habit-fact-label">Practice drill</div>
          <div>{habit.drill}</div>
          <span className={`pill ${habit.auto ? "up" : ""}`} style={{ marginTop: 4, display: "inline-block" }}>{habit.auto ? "Counted from your orders" : "Counted from your reviews"}</span>
        </div>
        <div>
          <div className="dim habit-fact-label">Read first</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {habit.readFirst.map((id) => <span key={id} className="pill">{lessonTitle(id)}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The detail opens over the page, where it cannot be missed: a bottom sheet on a phone, a centred panel on a desktop. Closes on the backdrop, the × or Escape. */
function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose} data-testid="habit-sheet">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Habit detail" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** All the habits as a map in three columns (study, plan, execution). Each tile shows where the person stands on it; tap one for its detail. */
export function HabitMap({ rows }: { rows: HabitRow[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const byTag = new Map(rows.map((r) => [r.habit.tag, r]));
  const habit = picked ? HABITS.find((h) => h.tag === picked) ?? null : null;
  return (
    <div className="stack" data-testid="habit-map">
      <div className="habit-cols">
        {LEVELS.map(({ level, question, color }) => (
          <div key={level} className="habit-col">
            <div style={{ borderBottom: `3px solid ${color}`, paddingBottom: 6, marginBottom: 8 }}>
              <strong>{LEVEL_LABEL[level]}</strong>
              <div className="dim" style={{ fontSize: 12 }}>{question}</div>
            </div>
            {HABITS.filter((h) => h.level === level).map((h) => {
              const r = byTag.get(h.tag);
              const status = !r ? { text: "Not on your record", tone: "" } : r.fixed ? { text: "Fixed", tone: "up" } : { text: runLabel(r), tone: "warn" };
              return (
                <button key={h.tag} className="habit-tile" aria-pressed={picked === h.tag} onClick={() => setPicked(picked === h.tag ? null : h.tag)} data-testid="habit-tile">
                  <span>{tagLabel(h.tag)}</span>
                  <span className={`pill ${status.tone}`} style={{ fontSize: 11 }}>{status.text}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>Tap a habit to see its rule, the drill and what to read first.</p>
      {habit && <Sheet onClose={() => setPicked(null)}><HabitDetailCard habit={habit} onClose={() => setPicked(null)} /></Sheet>}
    </div>
  );
}
