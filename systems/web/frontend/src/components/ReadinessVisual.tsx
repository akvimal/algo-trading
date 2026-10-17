import { Link } from "react-router-dom";
import type { LiveEligibility, Requirement } from "../api/types";
import { READINESS_HELP, READINESS_TITLE } from "../pages/learnCatalog";
import { meterFill, meterTone, nextCheck, progressNote, type MeterTone } from "../pages/learnModel";
import { graduation } from "../pages/portfolioModel";
import { DisciplineGauge } from "./DisciplineGauge";

const TONE_VAR: Record<MeterTone, string> = { up: "var(--up)", warn: "var(--warn)", dn: "var(--dn)", dim: "var(--text-dim)" };

/** The headline: how many of the checks are met, as a ring. */
function Ring({ met, total, size = 108 }: { met: number; total: number; size?: number }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const frac = total === 0 ? 0 : met / total;
  const color = met === total && total > 0 ? "var(--up)" : met > 0 ? "var(--warn)" : "var(--text-dim)";
  return (
    <svg viewBox="0 0 108 108" width={size} height={size} role="img" aria-label={`${met} of ${total} readiness checks met`} data-testid="ready-ring">
      <circle cx="54" cy="54" r={r} stroke="var(--surface-2)" strokeWidth="9" fill="none" />
      <circle cx="54" cy="54" r={r} stroke={color} strokeWidth="9" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round" transform="rotate(-90 54 54)" style={{ transition: "stroke-dashoffset 0.3s ease" }} />
      <text x="54" y="52" textAnchor="middle" className="num" style={{ fontSize: 30, fontWeight: 600, fill: "var(--text)" }}>{met}/{total}</text>
      <text x="54" y="70" textAnchor="middle" style={{ fontSize: 11, fill: "var(--text-dim)" }}>checks met</text>
    </svg>
  );
}

/** A filled bar; a ceiling shows the limit as the right-hand end. */
function Bar({ fill, tone, label }: { fill: number; tone: MeterTone; label: string }) {
  return (
    <div className="meter" role="img" aria-label={label} style={{ height: 10, borderRadius: 5, marginTop: 6 }}>
      <i style={{ width: `${Math.round(fill * 100)}%`, background: TONE_VAR[tone], transition: "width 0.3s ease" }} />
    </div>
  );
}

/** One block per day (up to 31), filled for the days on the record. */
function DayBlocks({ done, total, tone }: { done: number; total: number; tone: MeterTone }) {
  const n = Math.max(1, Math.min(31, Math.round(total)));
  return (
    <div role="img" aria-label={`${Math.min(done, n)} of ${n} days`} style={{ display: "flex", gap: 3, marginTop: 6 }}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} style={{ flex: 1, height: 10, borderRadius: 3, background: i < done ? TONE_VAR[tone] : "var(--surface-2)" }} />
      ))}
    </div>
  );
}

function Graphic({ r }: { r: Requirement }) {
  const tone = meterTone(r);
  const fill = meterFill(r);
  const value = r.value ?? null;
  switch (r.key) {
    case "days":
      return <DayBlocks done={Math.floor(value ?? 0)} total={r.target ?? 14} tone={tone} />;
    case "discipline":
      return (
        <div className="row" style={{ justifyContent: "flex-start", gap: 12, marginTop: 4 }}>
          <DisciplineGauge score={value == null ? null : Math.round(value)} size={64} />
          <span className="dim" style={{ fontSize: 13 }}>needs {r.target != null ? Math.round(r.target) : "–"} or more</span>
        </div>
      );
    case "profit":
      return (
        <div style={{ marginTop: 6, fontSize: 20, fontWeight: 600, color: TONE_VAR[value == null ? "dim" : value > 0 ? "up" : "dn"] }} className="num">
          {value == null ? "No trades yet" : `${value > 0 ? "▲ +" : value < 0 ? "▼ −" : ""}${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
        </div>
      );
    case "costs":
      return (
        <div style={{ marginTop: 6 }}>
          <Bar fill={fill} tone={tone} label={`slippage ${value ?? 0} of ${r.target ?? 0} basis points`} />
          <span className="faint" style={{ fontSize: 12 }}>charges and slippage on</span>
        </div>
      );
    default:
      return <Bar fill={fill} tone={tone} label={`${r.actual}, ${r.required}`} />;
  }
}

function Tile({ r }: { r: Requirement }) {
  const tone = meterTone(r);
  const help = READINESS_HELP[r.key];
  const note = r.key === "profit" ? null : progressNote(r);
  // Days are capped at the target: the blocks show 14 of 14, the surplus is said in words.
  const capped = r.key === "days" && r.value != null && r.target != null && r.value > r.target;
  return (
    <div className="card" data-testid="requirement" data-met={r.met ? "true" : "false"} style={{ margin: 0 }}>
      <div className="row">
        <strong>{READINESS_TITLE[r.key] ?? r.label}</strong>
        <span aria-label={r.met ? "met" : "not met yet"} style={{ color: TONE_VAR[r.met ? "up" : tone], fontWeight: 700 }}>{r.met ? "✓" : "○"}</span>
      </div>
      <Graphic r={r} />
      <div className="row" style={{ marginTop: 4 }}>
        <span className="num" style={{ fontSize: 13 }}>{capped ? `${r.target} of ${r.target} days` : r.actual}</span>
        <span className="faint" style={{ fontSize: 12 }}>{capped ? `${r.actual} on record` : r.required}</span>
      </div>
      {r.note && <div className="dim" style={{ fontSize: 12, marginTop: 4 }} data-testid="requirement-note">{r.note}</div>}
      {note && !capped && <div className="faint" style={{ fontSize: 12, marginTop: 2 }} data-testid="progress-note">{note}</div>}
      {!r.met && help && (
        <details style={{ marginTop: 6 }}>
          <summary className="dim" style={{ fontSize: 13, cursor: "pointer" }}>What this means</summary>
          <span className="dim" style={{ fontSize: 13, display: "block", marginTop: 4 }}>{help.meaning}</span>
        </details>
      )}
    </div>
  );
}

/** "Ready for live trading?" as a picture: a headline ring, one meter per check, and the single next step. Reading changes none of it. */
export function ReadinessVisual({ eligibility }: { eligibility: LiveEligibility }) {
  const g = graduation(eligibility);
  const next = nextCheck(eligibility.requirements);
  const help = next ? READINESS_HELP[next.key] : null;
  return (
    <div className="stack" data-testid="readiness">
      <div className="card">
        <div className="row" style={{ justifyContent: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <Ring met={g.met} total={g.total} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <h2 className="section-title" style={{ margin: 0 }}>Ready for live trading?</h2>
            <p className="dim" style={{ margin: "6px 0 0" }}>
              {g.eligible ? "Every check is met on paper." : "These are the real checks. Lessons do not change them; your paper trades do."}
              {!g.enforced && " For now they are a guide and do not block you."}
            </p>
          </div>
        </div>
        {next && help && (
          <div data-testid="next-step" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <div className="dim" style={{ fontSize: 12 }}>Next step</div>
            <strong>{READINESS_TITLE[next.key] ?? next.label}</strong> <span className="faint">· {next.actual} of {next.required}</span>
            <p className="dim" style={{ margin: "4px 0 8px", fontSize: 13 }}>{help.meaning}</p>
            {help.to.startsWith("#") ? <a className="btn btn-small" href={help.to}>{help.action}</a> : <Link className="btn btn-small" to={help.to}>{help.action}</Link>}
          </div>
        )}
      </div>
      <div className="ready-grid">
        {eligibility.requirements.map((r) => <Tile key={r.key} r={r} />)}
      </div>
    </div>
  );
}
