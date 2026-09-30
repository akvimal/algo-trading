import { disciplineBand } from "../pages/portfolioModel";

const BAND_VAR: Record<ReturnType<typeof disciplineBand>, string> = {
  none: "var(--text-dim)",
  low: "var(--dn)",
  fair: "var(--warn)",
  good: "var(--up)",
};

/** A 0-100 score as a ring, not just a number - reading "most of the ring is filled and green"
 * is faster than reading "78". Same visual idiom as the loss-budget `.meter` bar elsewhere on
 * Today, just radial: one glance says whether the habit is being kept, not only the tally.
 * `size` scales the whole thing (a small badge-sized use vs. the full card on Review). */
export function DisciplineGauge({ score, size = 96 }: { score: number | null; size?: number }) {
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = BAND_VAR[disciplineBand(score)];
  const label = score == null ? "Not enough trades yet for a discipline score" : `Discipline score ${score} out of 100`;
  return (
    <svg viewBox="0 0 108 108" width={size} height={size} role="img" aria-label={label}>
      <circle cx="54" cy="54" r={r} stroke="var(--surface-2)" strokeWidth="9" fill="none" />
      <circle
        cx="54"
        cy="54"
        r={r}
        stroke={color}
        strokeWidth="9"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct)}
        strokeLinecap="round"
        transform="rotate(-90 54 54)"
        style={{ transition: "stroke-dashoffset 0.3s ease" }}
      />
      <text x="54" y="50" textAnchor="middle" className="num" style={{ fontSize: 26, fontWeight: 600, fill: "var(--text)" }}>
        {score ?? "–"}
      </text>
      <text x="54" y="68" textAnchor="middle" className="dim" style={{ fontSize: 11, fill: "var(--text-dim)" }}>
        {score == null ? "n/a" : "/ 100"}
      </text>
    </svg>
  );
}
