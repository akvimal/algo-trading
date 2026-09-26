import { formatInr, formatDay } from "../format";
import type { CurvePoint } from "../pages/portfolioModel";

const W = 300;
const H = 110;
const PAD = 6;

/** A small equity curve as inline SVG (no chart library: it is one line and a baseline).
 * The picture is decoration; the accessible summary carries the same facts in words. */
export function EquityChart({ points, baseline }: { points: CurvePoint[]; baseline: number }) {
  if (points.length < 2) {
    return (
      <p className="dim" style={{ margin: 0 }}>
        Your equity curve appears after your first full day of trading. It updates once a day.
      </p>
    );
  }
  const values = points.map((p) => p.equity);
  const lo = Math.min(baseline, ...values);
  const hi = Math.max(baseline, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const up = last.equity >= baseline;
  const summary = `Equity from ${formatInr(points[0].equity)} on ${formatDay(points[0].date)} to ${formatInr(last.equity)} on ${formatDay(last.date)}. Started at ${formatInr(baseline)}.`;

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary} preserveAspectRatio="none" style={{ display: "block", height: 110 }}>
        <line x1={PAD} x2={W - PAD} y1={y(baseline)} y2={y(baseline)} stroke="var(--border)" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={up ? "var(--up)" : "var(--dn)"} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <figcaption className="row faint" style={{ fontSize: 12, marginTop: 4 }}>
        <span>{formatDay(points[0].date)}</span>
        <span>dashed line: where you started</span>
        <span>{formatDay(last.date)}</span>
      </figcaption>
    </figure>
  );
}
