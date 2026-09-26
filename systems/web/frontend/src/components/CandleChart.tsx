import type { Candle } from "../api/types";
import { formatPrice } from "../format";

export type ChartLine = { price: number; label: string; tone: "entry" | "stop" | "target" | "live" };

const W = 320;
const H = 190;
const RIGHT = 46; // room for the price labels
const TOP = 8;
const BOTTOM = 16;
const MAX_BARS = 70;

const COLOR = { entry: "var(--accent)", stop: "var(--dn)", target: "var(--up)", live: "var(--text-dim)" } as const;

function clock(iso: string, intraday: boolean): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...(intraday ? { hour: "2-digit", minute: "2-digit", hour12: false } : { day: "numeric", month: "short" }) }).format(d);
}

/** Recent candles with the plan drawn on them: where you enter, where you are wrong (stop) and
 * where you take profit (target). Deliberately small: no zoom or drawing tools. The advanced
 * chart (structure overlays, drawings) is still in the classic app. The picture is a summary
 * for the eyes; the accessible label carries the same numbers in words. */
export function CandleChart({ candles, lines, intraday = true }: { candles: Candle[]; lines: ChartLine[]; intraday?: boolean }) {
  const bars = candles.slice(-MAX_BARS);
  if (bars.length < 2) {
    return (
      <p className="dim" style={{ margin: 0 }}>
        No candles to show yet. The market may be closed, or data has not loaded.
      </p>
    );
  }
  const prices = [...bars.flatMap((c) => [c.high, c.low]), ...lines.map((l) => l.price)];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = (hi - lo || 1) * 0.04;
  const min = lo - pad;
  const span = hi + pad - min;
  const plotW = W - RIGHT;
  const step = plotW / bars.length;
  const bodyW = Math.max(1.5, step * 0.62);
  const y = (p: number) => TOP + (1 - (p - min) / span) * (H - TOP - BOTTOM);
  const x = (i: number) => i * step + step / 2;
  const last = bars[bars.length - 1];
  // Faint price scale so the candles can be read against numbers; a tick that would sit on top of a
  // marked level's own label is skipped.
  const ticks = [0.15, 0.5, 0.85]
    .map((f) => min + span * f)
    .filter((p) => lines.every((l) => Math.abs(y(l.price) - y(p)) > 11));
  const summary = `Price chart of ${bars.length} candles, from ${clock(bars[0].timestamp, intraday)} to ${clock(last.timestamp, intraday)}. Last close ${formatPrice(last.close)}, high ${formatPrice(Math.max(...bars.map((b) => b.high)))}, low ${formatPrice(Math.min(...bars.map((b) => b.low)))}.${lines.length ? ` Marked levels: ${lines.map((l) => `${l.label} ${formatPrice(l.price)}`).join(", ")}.` : ""}`;

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary} style={{ display: "block", maxWidth: 600, margin: "0 auto" }}>
        {ticks.map((p) => (
          <g key={p}>
            <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke="var(--border)" strokeWidth="0.5" />
            <text x={plotW + 3} y={y(p) + 3} fontSize="8" fill="var(--text-faint)">
              {formatPrice(p)}
            </text>
          </g>
        ))}
        {bars.map((c, i) => {
          const up = c.close >= c.open;
          const color = up ? "var(--up)" : "var(--dn)";
          const top = y(Math.max(c.open, c.close));
          const h = Math.max(1, Math.abs(y(c.open) - y(c.close)));
          return (
            <g key={c.timestamp}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
              <rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={h} fill={up ? "none" : color} stroke={color} strokeWidth="1" />
            </g>
          );
        })}
        {lines.map((l) => (
          <g key={`${l.tone}-${l.label}`}>
            <line x1={0} x2={plotW} y1={y(l.price)} y2={y(l.price)} stroke={COLOR[l.tone]} strokeWidth="1" strokeDasharray={l.tone === "live" ? "1 3" : "5 3"} />
            <text x={plotW + 3} y={y(l.price) + 3} fontSize="8" fill={COLOR[l.tone]}>
              {l.label} {formatPrice(l.price)}
            </text>
          </g>
        ))}
        <text x={0} y={H - 3} fontSize="8" fill="var(--text-faint)">
          {clock(bars[0].timestamp, intraday)}
        </text>
        <text x={plotW} y={H - 3} fontSize="8" fill="var(--text-faint)" textAnchor="end">
          {clock(last.timestamp, intraday)}
        </text>
      </svg>
    </figure>
  );
}
