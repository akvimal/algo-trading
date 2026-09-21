import { useState } from "react";

import type { OiSummaryStrike } from "./api";

// Call/Put implied-volatility skew across strikes - the chart that fills
// OiSummaryPage.tsx's second chart slot for a custom (non-watchlist)
// symbol tab, replacing Sentiment history there (that one needs persisted
// history this app doesn't track for arbitrary stocks - see the OI daily
// history GitHub issue). Deliberately needs NO new data: every strike's
// implied_volatility is already fetched for OiBarChart's own OI-by-strike
// chart, just unused for charting until now. Same hand-rolled SVG
// approach and dimensions as OiBarChart.tsx (no charting library in this
// app) so the two sit visually consistent side by side.
const WIDTH = 900;
const HEIGHT = 320;
const PAD_LEFT = 12;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 44;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

// Same colors as OiBarChart's own legend (Put green, Call red) - the two
// charts sit side by side in the same row, so keeping the color meaning
// consistent between them matters more than this chart having its own
// palette.
const PUT_COLOR = "#3cb371";
const CALL_COLOR = "#e15b5b";

// Mirrors OiSummaryPage.tsx's own fmtIv - Dhan (NSE/MCX) already reports
// IV as a percent value; Delta (CRYPTO) reports a 0-1 ratio.
function ivPercent(n: number, isCrypto: boolean): number {
  return isCrypto ? n * 100 : n;
}

export function IvSkewChart({
  strikes,
  spot,
  symbol,
  isCrypto = false,
}: {
  strikes: OiSummaryStrike[];
  spot: number;
  symbol: string;
  isCrypto?: boolean;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (strikes.length === 0) {
    return <p className="muted">No strikes to chart.</p>;
  }

  const callIv = strikes.map((s) => (s.call ? ivPercent(s.call.implied_volatility, isCrypto) : null));
  const putIv = strikes.map((s) => (s.put ? ivPercent(s.put.implied_volatility, isCrypto) : null));
  const allIv = [...callIv, ...putIv].filter((v): v is number => v != null);

  if (allIv.length === 0) {
    return <p className="muted">No IV data for this expiry yet.</p>;
  }

  const minIv = Math.min(...allIv);
  const maxIv = Math.max(...allIv);
  // A flat/near-flat skew (maxIv - minIv tiny) would otherwise divide by
  // ~0 and draw a degenerate flat line at the top - pad the range instead
  // so it always reads as a real (if boring) chart.
  const span = Math.max(maxIv - minIv, 1);
  const rangeLow = minIv - span * 0.1;
  const rangeHigh = maxIv + span * 0.1;

  const bandWidth = PLOT_WIDTH / strikes.length;
  const bandCenterX = (i: number) => PAD_LEFT + bandWidth * (i + 0.5);
  const baseY = PAD_TOP + PLOT_HEIGHT;
  const valueToY = (v: number) => PAD_TOP + PLOT_HEIGHT - ((v - rangeLow) / (rangeHigh - rangeLow)) * PLOT_HEIGHT;

  // Same spot-price interpolation as OiBarChart, so the marker lines up
  // identically between the two sibling charts.
  let spotX = bandCenterX(0);
  if (spot <= strikes[0].strike) {
    spotX = bandCenterX(0);
  } else if (spot >= strikes[strikes.length - 1].strike) {
    spotX = bandCenterX(strikes.length - 1);
  } else {
    for (let i = 0; i < strikes.length - 1; i++) {
      const a = strikes[i].strike;
      const b = strikes[i + 1].strike;
      if (spot >= a && spot <= b) {
        const frac = b === a ? 0 : (spot - a) / (b - a);
        spotX = bandCenterX(i) + frac * (bandCenterX(i + 1) - bandCenterX(i));
        break;
      }
    }
  }
  const pillCenterX = Math.min(Math.max(spotX, PAD_LEFT + 48), WIDTH - PAD_RIGHT - 48);

  // One <path> per side, skipping null legs rather than interpolating
  // through a gap - "M x y L x y ..." restarted (a new "M") after any
  // null so the line breaks visibly instead of drawing a misleading
  // straight segment across a missing strike.
  function pathFor(values: (number | null)[]): string {
    let d = "";
    let started = false;
    values.forEach((v, i) => {
      if (v == null) {
        started = false;
        return;
      }
      const x = bandCenterX(i);
      const y = valueToY(v);
      d += started ? ` L ${x} ${y}` : `${d ? " " : ""}M ${x} ${y}`;
      started = true;
    });
    return d;
  }

  const hovered = hoverIndex != null ? strikes[hoverIndex] : null;
  const hoveredCallIv = hoverIndex != null ? callIv[hoverIndex] : null;
  const hoveredPutIv = hoverIndex != null ? putIv[hoverIndex] : null;

  return (
    <div className="oi-bar-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={`${symbol} implied volatility skew`}>
        <line x1={PAD_LEFT} y1={baseY} x2={WIDTH - PAD_RIGHT} y2={baseY} stroke="var(--border)" strokeWidth={1} />

        {strikes.map((s, i) => {
          const isAtm = s.call?.moneyness === "ATM" || s.put?.moneyness === "ATM";
          const bandX = PAD_LEFT + bandWidth * i;
          return (
            <g key={s.strike}>
              <rect
                x={bandX}
                y={PAD_TOP}
                width={bandWidth}
                height={PLOT_HEIGHT}
                fill={hoverIndex === i ? "var(--surface-raised)" : "transparent"}
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
              />
              <text
                x={bandCenterX(i)}
                y={baseY + 14}
                textAnchor="end"
                fontSize={10}
                fill={isAtm ? "var(--text)" : "var(--text-dim)"}
                fontWeight={isAtm ? 700 : 400}
                transform={`rotate(-45 ${bandCenterX(i)} ${baseY + 14})`}
              >
                {s.strike}
              </text>
            </g>
          );
        })}

        <path d={pathFor(putIv)} fill="none" stroke={PUT_COLOR} strokeWidth={2} />
        <path d={pathFor(callIv)} fill="none" stroke={CALL_COLOR} strokeWidth={2} />
        {putIv.map(
          (v, i) => v != null && <circle key={`put-${strikes[i].strike}`} cx={bandCenterX(i)} cy={valueToY(v)} r={hoverIndex === i ? 4 : 2.5} fill={PUT_COLOR} />,
        )}
        {callIv.map(
          (v, i) => v != null && <circle key={`call-${strikes[i].strike}`} cx={bandCenterX(i)} cy={valueToY(v)} r={hoverIndex === i ? 4 : 2.5} fill={CALL_COLOR} />,
        )}

        {/* Spot-price marker - same placement convention as OiBarChart. */}
        <line x1={spotX} y1={PAD_TOP} x2={spotX} y2={baseY} stroke="var(--text-dim)" strokeWidth={1.5} strokeDasharray="4 3" />
        <rect x={pillCenterX - 48} y={PAD_TOP} width={96} height={16} rx={3} fill="var(--surface-raised)" stroke="var(--border)" />
        <text x={pillCenterX} y={PAD_TOP + 11} textAnchor="middle" fontSize={10} fill="var(--text)">
          {symbol} {spot.toFixed(2)}
        </text>
      </svg>

      <div className="oi-bar-chart-legend">
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch put" /> Put IV
        </span>
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch call" /> Call IV
        </span>
      </div>

      {hovered && (
        <div className="oi-bar-chart-tooltip">
          <strong>{hovered.strike}</strong>
          {hoveredPutIv != null && <span style={{ color: PUT_COLOR }}>Put IV {hoveredPutIv.toFixed(2)}%</span>}
          {hoveredCallIv != null && <span style={{ color: CALL_COLOR }}>Call IV {hoveredCallIv.toFixed(2)}%</span>}
        </div>
      )}
    </div>
  );
}
