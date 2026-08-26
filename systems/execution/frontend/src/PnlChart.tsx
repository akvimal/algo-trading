import { useState } from "react";

import { money, moneySigned } from "./format";

export type PnlPoint = { recordedAt: string; unrealizedPnl: number };

const WIDTH = 640;
const HEIGHT = 160;
const PAD_LEFT = 56;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Single-series unrealized-P&L-over-time line chart for one position/
// option group, expanded inline in PositionsPage's Positions grid (see
// docs/architecture.md's per-position P&L history section). One series ->
// no legend needed (the panel's own heading already names it) - color is
// this app's existing green/red P&L convention (--buy/--sell, index.css),
// the same pair every other P&L cell on this page already uses, not a
// new palette. `points` is prepared by the caller: the position's own
// entry_time (pnl=0) prepended and, once closed, exit_time/pnl appended -
// this component only ever renders whatever series it's given.
export function PnlChart({ points, segment }: { points: PnlPoint[]; segment: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length < 2) {
    return <p className="muted">Not enough history yet - check back after the next exit-monitor tick.</p>;
  }

  const times = points.map((p) => new Date(p.recordedAt).getTime());
  const values = points.map((p) => p.unrealizedPnl);
  const minTime = times[0];
  const maxTime = times[times.length - 1];
  const timeSpan = Math.max(1, maxTime - minTime);

  // Symmetric around zero (not just min/max) so the zero baseline always
  // sits at a meaningful position rather than hugging one edge - a
  // one-sided series (e.g. always-profitable) still shows *some* headroom
  // on the empty side, same reasoning a candlestick chart keeps some
  // margin above/below the price range.
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const yMin = -maxAbs * 1.1;
  const yMax = maxAbs * 1.1;

  const x = (t: number) => PAD_LEFT + ((t - minTime) / timeSpan) * PLOT_WIDTH;
  const y = (v: number) => PAD_TOP + PLOT_HEIGHT - ((v - yMin) / (yMax - yMin)) * PLOT_HEIGHT;
  const zeroY = y(0);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(times[i]).toFixed(1)} ${y(p.unrealizedPnl).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${x(maxTime).toFixed(1)} ${zeroY.toFixed(1)} L ${x(minTime).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  const final = values[values.length - 1];
  const seriesColor = final >= 0 ? "var(--buy)" : "var(--sell)";

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
    // Nearest point by x - a simple linear scan is fine, these series are
    // at most a few hundred points (30s cadence over a single trading
    // session).
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(times[i]) - px);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  }

  const hovered = hoverIndex != null ? points[hoverIndex] : null;
  const hoveredX = hoverIndex != null ? x(times[hoverIndex]) : 0;
  const hoveredY = hoverIndex != null ? y(points[hoverIndex].unrealizedPnl) : 0;
  // Flip the tooltip to the left of the crosshair once it'd otherwise run
  // off the right edge of the chart.
  const tooltipOnLeft = hoveredX > WIDTH - 140;

  return (
    <div className="pnl-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label="Unrealized P&L over time">
        {/* Zero baseline - recessive, dashed */}
        <line x1={PAD_LEFT} y1={zeroY} x2={WIDTH - PAD_RIGHT} y2={zeroY} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
        <text x={PAD_LEFT - 8} y={zeroY} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--text-dim)">
          {money(0, segment)}
        </text>
        <text x={PAD_LEFT - 8} y={PAD_TOP + 4} textAnchor="end" fontSize={10} fill="var(--text-dim)">
          {money(yMax, segment)}
        </text>
        <text x={PAD_LEFT - 8} y={HEIGHT - PAD_BOTTOM} textAnchor="end" fontSize={10} fill="var(--text-dim)">
          {money(yMin, segment)}
        </text>

        {/* Area fill down to the zero baseline, then the line itself */}
        <path d={areaPath} fill={seriesColor} fillOpacity={0.12} stroke="none" />
        <path d={linePath} fill="none" stroke={seriesColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Entry/exit endpoint markers */}
        <circle cx={x(times[0])} cy={y(values[0])} r={4} fill="var(--surface)" stroke="var(--text-dim)" strokeWidth={1.5} />
        <circle
          cx={x(times[times.length - 1])}
          cy={y(values[values.length - 1])}
          r={4}
          fill={seriesColor}
          stroke="var(--surface)"
          strokeWidth={1.5}
        />

        {hovered && (
          <>
            <line x1={hoveredX} y1={PAD_TOP} x2={hoveredX} y2={HEIGHT - PAD_BOTTOM} stroke="var(--text-dim)" strokeWidth={1} />
            <circle cx={hoveredX} cy={hoveredY} r={4} fill={seriesColor} stroke="var(--surface)" strokeWidth={1.5} />
          </>
        )}

        {/* Transparent hit layer - hover works anywhere across the chart's
            full height, not just directly on the thin line. */}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        />
      </svg>
      {hovered && (
        <div
          className="pnl-chart-tooltip"
          style={{
            left: tooltipOnLeft ? `${(hoveredX / WIDTH) * 100}%` : `${(hoveredX / WIDTH) * 100}%`,
            transform: tooltipOnLeft ? "translateX(-100%)" : "translateX(8px)",
          }}
        >
          <div>{formatClock(hovered.recordedAt)}</div>
          <div className={hovered.unrealizedPnl >= 0 ? "pnl-positive" : "pnl-negative"}>{moneySigned(hovered.unrealizedPnl, segment)}</div>
        </div>
      )}
    </div>
  );
}
