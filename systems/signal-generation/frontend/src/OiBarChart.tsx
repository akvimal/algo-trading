import { useState } from "react";

import type { OiSummaryStrike } from "./api";

// Grouped Call/Put OI-by-strike bar chart with an increase/decrease cap
// per bar, replicating a familiar broker-terminal OI chart: solid fill =
// current OI; a hatched cap on top = this window's OI increase; a
// hollow/outlined cap on top = this window's OI decrease (the bar's
// outline reaches back to what OI was before the drop, its solid fill
// only as tall as where OI stands now). Same hand-rolled SVG approach as
// execution/frontend's PnlChart.tsx (no charting library in this app).
// Colors match that reference chart's own legend (Put OI green, Call OI
// red) rather than this app's usual --buy/--sell-by-side convention.
const WIDTH = 900;
const HEIGHT = 320;
const PAD_LEFT = 12;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 44;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;
// Gap between the two bars of one strike's own group, and between
// separate strikes' groups - both fractions of one strike's band width.
// OUTER > INNER so groups read as distinct clusters, not one continuous
// row of bars (the complaint this spacing pass addresses).
const INNER_GAP_FRACTION = 0.1;
const OUTER_GAP_FRACTION = 0.22;

const PUT_COLOR = "#3cb371"; // matches the reference chart's Put OI green - not this app's --buy (a different green elsewhere in the UI)
const CALL_COLOR = "#e15b5b"; // matches the reference chart's Call OI red - not this app's --sell

function fmtOiShort(n: number): string {
  if (n >= 10000000) return `${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtChangeShort(n: number): string {
  return `${n > 0 ? "+" : ""}${fmtOiShort(n)}`;
}

// Solid+cap geometry for one leg's bar, expressed as {solidTo, capTo}
// data-space values (not pixels) - solidTo is always where the CURRENT
// oi sits; capTo is where the cap's far edge sits (current+increase, or
// the pre-decrease previous value) - see this file's own top comment.
// Returns capTo === solidTo (no cap) when change is null/0.
function legExtent(oi: number, change: number | null): { solidTo: number; capTo: number; capKind: "increase" | "decrease" | "none" } {
  if (change == null || change === 0) return { solidTo: oi, capTo: oi, capKind: "none" };
  if (change > 0) return { solidTo: oi - change, capTo: oi, capKind: "increase" };
  return { solidTo: oi, capTo: oi - change, capKind: "decrease" };
}

function OiLegBar({
  x,
  width,
  oi,
  change,
  color,
  hatchId,
  valueToY,
  baseY,
}: {
  x: number;
  width: number;
  oi: number;
  change: number | null;
  color: string;
  hatchId: string;
  valueToY: (v: number) => number;
  baseY: number;
}) {
  const { solidTo, capTo, capKind } = legExtent(oi, change);
  const solidTopY = valueToY(solidTo);
  const capTopY = valueToY(capTo);
  return (
    <>
      <rect x={x} y={solidTopY} width={width} height={Math.max(0, baseY - solidTopY)} fill={color} fillOpacity={0.9} />
      {capKind === "increase" && <rect x={x} y={capTopY} width={width} height={Math.max(0, solidTopY - capTopY)} fill={`url(#${hatchId})`} />}
      {capKind === "decrease" && (
        <rect x={x} y={capTopY} width={width} height={Math.max(0, solidTopY - capTopY)} fill="none" stroke={color} strokeWidth={1.5} />
      )}
    </>
  );
}

export function OiBarChart({
  strikes,
  spot,
  symbol,
  changeWindow,
}: {
  strikes: OiSummaryStrike[];
  spot: number;
  symbol: string;
  changeWindow: "5m" | "15m";
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (strikes.length === 0) {
    return <p className="muted">No strikes to chart.</p>;
  }

  const changeFor = (change5m: number | null, change15m: number | null) => (changeWindow === "5m" ? change5m : change15m);

  const maxOi = Math.max(
    1,
    ...strikes.flatMap((s) => {
      const vals: number[] = [];
      if (s.call) vals.push(legExtent(s.call.oi, changeFor(s.call.oi_change_5m, s.call.oi_change_15m)).capTo);
      if (s.put) vals.push(legExtent(s.put.oi, changeFor(s.put.oi_change_5m, s.put.oi_change_15m)).capTo);
      return vals;
    }),
  );

  const bandWidth = PLOT_WIDTH / strikes.length;
  const outerGap = bandWidth * OUTER_GAP_FRACTION;
  const innerGap = bandWidth * INNER_GAP_FRACTION;
  const barWidth = (bandWidth - outerGap - innerGap) / 2;

  const bandCenterX = (i: number) => PAD_LEFT + bandWidth * (i + 0.5);
  // Put on the left, Call on the right within each strike's pair -
  // matches the reference chart's own left-to-right order.
  const leftBarX = (i: number) => PAD_LEFT + bandWidth * i + outerGap / 2;
  const rightBarX = (i: number) => leftBarX(i) + barWidth + innerGap;

  const baseY = PAD_TOP + PLOT_HEIGHT;
  const valueToY = (v: number) => PAD_TOP + PLOT_HEIGHT - (v / maxOi) * PLOT_HEIGHT;

  // Spot-price line's x position - linearly interpolated between the two
  // straddling strikes' own band centers (not a separate continuous
  // value axis), so it lines up exactly with the categorical bar
  // positions rather than drifting if strikes aren't perfectly evenly
  // priced. Clamped to the first/last band center when spot falls
  // outside this (already ATM-windowed) strike range.
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

  const hovered = hoverIndex != null ? strikes[hoverIndex] : null;
  const hoveredCallChange = hovered?.call ? changeFor(hovered.call.oi_change_5m, hovered.call.oi_change_15m) : null;
  const hoveredPutChange = hovered?.put ? changeFor(hovered.put.oi_change_5m, hovered.put.oi_change_15m) : null;

  return (
    <div className="oi-bar-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={`${symbol} open interest by strike`}>
        <defs>
          <pattern id="oi-hatch-put" patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
            <rect width={6} height={6} fill={PUT_COLOR} fillOpacity={0.25} />
            <line x1={0} y1={0} x2={0} y2={6} stroke={PUT_COLOR} strokeWidth={3} />
          </pattern>
          <pattern id="oi-hatch-call" patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
            <rect width={6} height={6} fill={CALL_COLOR} fillOpacity={0.25} />
            <line x1={0} y1={0} x2={0} y2={6} stroke={CALL_COLOR} strokeWidth={3} />
          </pattern>
        </defs>

        {/* Baseline */}
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
              {s.put && (
                <OiLegBar
                  x={leftBarX(i)}
                  width={barWidth}
                  oi={s.put.oi}
                  change={changeFor(s.put.oi_change_5m, s.put.oi_change_15m)}
                  color={PUT_COLOR}
                  hatchId="oi-hatch-put"
                  valueToY={valueToY}
                  baseY={baseY}
                />
              )}
              {s.call && (
                <OiLegBar
                  x={rightBarX(i)}
                  width={barWidth}
                  oi={s.call.oi}
                  change={changeFor(s.call.oi_change_5m, s.call.oi_change_15m)}
                  color={CALL_COLOR}
                  hatchId="oi-hatch-call"
                  valueToY={valueToY}
                  baseY={baseY}
                />
              )}
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

        {/* Spot-price marker - dashed vertical line + label pinned near
            the TOP of the plot so it never collides with the rotated
            strike labels below. */}
        <line x1={spotX} y1={PAD_TOP} x2={spotX} y2={baseY} stroke="var(--text-dim)" strokeWidth={1.5} strokeDasharray="4 3" />
        <rect x={pillCenterX - 48} y={PAD_TOP} width={96} height={16} rx={3} fill="var(--surface-raised)" stroke="var(--border)" />
        <text x={pillCenterX} y={PAD_TOP + 11} textAnchor="middle" fontSize={10} fill="var(--text)">
          {symbol} {spot.toFixed(2)}
        </text>
      </svg>

      <div className="oi-bar-chart-legend">
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch put" /> Put OI
        </span>
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch put increase" /> Increase
        </span>
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch put decrease" /> Decrease
        </span>
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch call" /> Call OI
        </span>
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch call increase" /> Increase
        </span>
        <span className="oi-bar-chart-legend-item">
          <i className="oi-bar-chart-swatch call decrease" /> Decrease
        </span>
      </div>

      {hovered && (
        <div className="oi-bar-chart-tooltip">
          <strong>{hovered.strike}</strong>
          {hovered.put && (
            <span style={{ color: PUT_COLOR }}>
              Put OI {fmtOiShort(hovered.put.oi)}
              {hoveredPutChange != null ? ` (${fmtChangeShort(hoveredPutChange)})` : ""}
            </span>
          )}
          {hovered.call && (
            <span style={{ color: CALL_COLOR }}>
              Call OI {fmtOiShort(hovered.call.oi)}
              {hoveredCallChange != null ? ` (${fmtChangeShort(hoveredCallChange)})` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
