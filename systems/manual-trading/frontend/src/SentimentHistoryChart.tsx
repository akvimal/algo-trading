import { useEffect, useState } from "react";

import { type SentimentDirection, type SentimentHistoryPoint, fetchSentimentHistory } from "./api";

// Same cadence the scheduled recorder itself writes at (see market-data's
// app/scheduler.py) - no value polling more often than a new row could
// actually land.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const WIDTH = 900;
const PAD_LEFT = 64;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
// Two stacked plots sharing one x (time) axis - price on top (the thing
// you're checking for alignment), the raw OI-shift score underneath (the
// thing sentiment.py's direction/strength bucketing is actually derived
// from - see its own _classify) so you can see the raw number building
// *before* a strength bucket flips, not just the bucketed label a point's
// color/size already shows on the price plot above.
const PRICE_PLOT_HEIGHT = 130;
const SUBPLOT_GAP = 10;
const SCORE_PLOT_HEIGHT = 56;
const XAXIS_LABEL_HEIGHT = 20;
const HEIGHT = PAD_TOP + PRICE_PLOT_HEIGHT + SUBPLOT_GAP + SCORE_PLOT_HEIGHT + XAXIS_LABEL_HEIGHT;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;

const PRICE_TOP = PAD_TOP;
const PRICE_BOTTOM = PRICE_TOP + PRICE_PLOT_HEIGHT;
const SCORE_TOP = PRICE_BOTTOM + SUBPLOT_GAP;
const SCORE_BOTTOM = SCORE_TOP + SCORE_PLOT_HEIGHT;
const XAXIS_Y = SCORE_BOTTOM + 14;

const DIRECTION_COLOR: Record<SentimentDirection, string> = {
  bullish: "var(--buy)",
  bearish: "var(--sell)",
  neutral: "var(--text-dim)",
};

const STRENGTH_LABEL: Record<string, string> = { mild: "Mild", strong: "Strong", very_strong: "Very Strong" };

// Bigger dot = stronger conviction, not just a different color - a run of
// small dots turning into big ones is the "building" pattern this chart
// is for spotting, same idea as an OI bar chart's own increase/decrease
// caps (OiBarChart.tsx).
const STRENGTH_RADIUS: Record<string, number> = { mild: 4, strong: 5.5, very_strong: 7.5 };
const NEUTRAL_RADIUS = 3;

function pointRadius(p: SentimentHistoryPoint): number {
  return p.strength ? STRENGTH_RADIUS[p.strength] : NEUTRAL_RADIUS;
}

function directionLabel(p: SentimentHistoryPoint): string {
  if (p.direction === "neutral" || !p.strength) return "Neutral";
  return `${p.direction === "bullish" ? "Bullish" : "Bearish"} (${STRENGTH_LABEL[p.strength]})`;
}

function scoreColor(score: number | null): string {
  if (score == null || Math.abs(score) < 0.01) return "var(--text-dim)";
  return score > 0 ? "var(--buy)" : "var(--sell)";
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatAxisTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// Spot price over time for one sentiment-badge symbol, each point colored
// by that snapshot's own OI-based direction (green=bullish, red=bearish,
// gray=neutral) - lets you eyeball whether price actually moved the way a
// past OI read predicted (e.g. a run of bullish reads followed by the
// line trending up), which was the whole point of persisting this history
// (see market-data's market_data.sentiment_history table). A second,
// synced subplot underneath plots the raw score_15m (bars) and score_5m
// (dots) that direction/strength above is actually bucketed from - the
// building/fading momentum shows up here before it ever flips a bucket.
// Hand-rolled SVG, same approach as execution/frontend's PnlChart.tsx and
// this app's own OiBarChart.tsx - no charting library in this codebase.
export function SentimentHistoryChart({ symbol }: { symbol: string }) {
  const [points, setPoints] = useState<SentimentHistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    setError(null);
    setHoverIndex(null);

    async function poll() {
      try {
        const data = await fetchSentimentHistory(symbol);
        if (!cancelled) setPoints(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol]);

  if (error) return <p className="error">{error}</p>;
  if (points === null) return <p className="muted">Loading sentiment history...</p>;

  const withPrice = points.filter((p) => p.spot_price != null);
  if (withPrice.length < 2) {
    return <p className="muted">Not enough sentiment history yet for {symbol} - check back after a few more 5-minute ticks.</p>;
  }

  const times = withPrice.map((p) => new Date(p.recorded_at).getTime());
  const prices = withPrice.map((p) => p.spot_price as number);
  const minTime = times[0];
  const maxTime = times[times.length - 1];
  const timeSpan = Math.max(1, maxTime - minTime);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  // A little headroom above/below so points at the extremes aren't
  // clipped against the plot edge - a flat series (minPrice===maxPrice)
  // still gets *some* visible range instead of dividing by zero.
  const pricePad = Math.max((maxPrice - minPrice) * 0.1, maxPrice * 0.001, 1);
  const yMin = minPrice - pricePad;
  const yMax = maxPrice + pricePad;

  // Symmetric around zero (like execution/frontend's PnlChart.tsx does for
  // P&L) so the zero baseline sits at a meaningful, consistent position
  // rather than hugging one edge whenever every read this window happens
  // to be one-sided.
  const allScores = withPrice.flatMap((p) => [p.score_5m, p.score_15m]).filter((s): s is number => s != null);
  const maxAbsScore = Math.max(1, ...allScores.map((s) => Math.abs(s)));

  const x = (t: number) => PAD_LEFT + ((t - minTime) / timeSpan) * PLOT_WIDTH;
  const yPrice = (v: number) => PRICE_TOP + PRICE_PLOT_HEIGHT - ((v - yMin) / (yMax - yMin)) * PRICE_PLOT_HEIGHT;
  const yScore = (v: number) => SCORE_TOP + SCORE_PLOT_HEIGHT / 2 - (v / maxAbsScore) * (SCORE_PLOT_HEIGHT / 2);
  const scoreZeroY = yScore(0);

  const linePath = withPrice.map((p, i) => `${i === 0 ? "M" : "L"} ${x(times[i]).toFixed(1)} ${yPrice(p.spot_price as number).toFixed(1)}`).join(" ");

  // Thin bars, not full-width columns - these are near-instantaneous 5-
  // minute-apart snapshots, not evenly-bucketed candles, so a bar chart's
  // usual "bars touch" convention would overstate how continuous the data
  // really is.
  const barWidth = Math.max(2, Math.min(8, PLOT_WIDTH / withPrice.length - 2));

  // A handful of evenly-spaced x-axis time labels rather than one per
  // point - at 5-minute cadence a real history run has far too many
  // points to label each one without them overlapping.
  const AXIS_TICK_COUNT = 6;
  const axisTickIndices = Array.from(new Set(
    Array.from({ length: Math.min(AXIS_TICK_COUNT, withPrice.length) }, (_, i) =>
      Math.round((i * (withPrice.length - 1)) / Math.max(1, Math.min(AXIS_TICK_COUNT, withPrice.length) - 1)),
    ),
  ));

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < withPrice.length; i++) {
      const d = Math.abs(x(times[i]) - px);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  }

  const hovered = hoverIndex != null ? withPrice[hoverIndex] : null;
  const hoveredX = hoverIndex != null ? x(times[hoverIndex]) : 0;
  const hoveredPriceY = hoverIndex != null ? yPrice(withPrice[hoverIndex].spot_price as number) : 0;
  const tooltipOnLeft = hoveredX > WIDTH - 170;

  return (
    <div className="sentiment-history-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={`${symbol} spot price and OI shift over time`}>
        {/* Price plot */}
        <text x={PAD_LEFT - 8} y={PRICE_TOP + 4} textAnchor="end" fontSize={10} fill="var(--text-dim)">
          {maxPrice.toFixed(2)}
        </text>
        <text x={PAD_LEFT - 8} y={PRICE_BOTTOM} textAnchor="end" fontSize={10} fill="var(--text-dim)">
          {minPrice.toFixed(2)}
        </text>

        <path d={linePath} fill="none" stroke="var(--text-dim)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />

        {withPrice.map((p, i) => (
          <circle key={p.recorded_at} cx={x(times[i])} cy={yPrice(p.spot_price as number)} r={pointRadius(p)} fill={DIRECTION_COLOR[p.direction]} />
        ))}

        {/* OI-shift score subplot - score_15m (the bucketing's own primary
            input) as bars, score_5m (the agree/disagree sharpener) as a
            small dot on top of each bar. */}
        <text x={PAD_LEFT - 8} y={SCORE_TOP + 8} textAnchor="end" fontSize={9} fill="var(--text-dim)">
          OI shift %
        </text>
        <line x1={PAD_LEFT} y1={scoreZeroY} x2={WIDTH - PAD_RIGHT} y2={scoreZeroY} stroke="var(--text-dim)" strokeWidth={1.25} strokeDasharray="3 3" />

        {withPrice.map((p, i) =>
          p.score_15m != null ? (
            <rect
              key={`bar-${p.recorded_at}`}
              x={x(times[i]) - barWidth / 2}
              y={Math.min(scoreZeroY, yScore(p.score_15m))}
              width={barWidth}
              height={Math.max(1, Math.abs(yScore(p.score_15m) - scoreZeroY))}
              fill={scoreColor(p.score_15m)}
              fillOpacity={0.75}
            />
          ) : null,
        )}
        {withPrice.map((p, i) =>
          p.score_5m != null ? (
            <circle key={`dot-${p.recorded_at}`} cx={x(times[i])} cy={yScore(p.score_5m)} r={2} fill="var(--text)" />
          ) : null,
        )}

        {/* x-axis time labels, shared by both plots */}
        {axisTickIndices.map((i) => (
          <text key={i} x={x(times[i])} y={XAXIS_Y} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
            {formatAxisTime(withPrice[i].recorded_at)}
          </text>
        ))}

        {hovered && (
          <>
            <line x1={hoveredX} y1={PRICE_TOP} x2={hoveredX} y2={SCORE_BOTTOM} stroke="var(--text-dim)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={hoveredX} cy={hoveredPriceY} r={pointRadius(hovered) + 2.5} fill="none" stroke={DIRECTION_COLOR[hovered.direction]} strokeWidth={2} />
          </>
        )}

        <rect
          x={PAD_LEFT}
          y={PRICE_TOP}
          width={PLOT_WIDTH}
          height={SCORE_BOTTOM - PRICE_TOP}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        />
      </svg>
      {hovered && (
        <div
          className="sentiment-history-tooltip"
          style={{
            left: `${(hoveredX / WIDTH) * 100}%`,
            transform: tooltipOnLeft ? "translateX(-100%)" : "translateX(8px)",
          }}
        >
          <div>{formatClock(hovered.recorded_at)}</div>
          <div>{hovered.spot_price?.toFixed(2)}</div>
          <div style={{ color: DIRECTION_COLOR[hovered.direction] }}>{directionLabel(hovered)}</div>
          <div className="muted">
            5m {hovered.score_5m != null ? `${hovered.score_5m.toFixed(2)}%` : "-"} · 15m{" "}
            {hovered.score_15m != null ? `${hovered.score_15m.toFixed(2)}%` : "-"}
          </div>
        </div>
      )}
      <div className="sentiment-history-legend">
        <span className="sentiment-history-legend-item">
          <span className="sentiment-history-swatch" style={{ background: "var(--buy)" }} /> Bullish
        </span>
        <span className="sentiment-history-legend-item">
          <span className="sentiment-history-swatch" style={{ background: "var(--sell)" }} /> Bearish
        </span>
        <span className="sentiment-history-legend-item">
          <span className="sentiment-history-swatch" style={{ background: "var(--text-dim)" }} /> Neutral
        </span>
        <span className="sentiment-history-legend-item">
          <span className="sentiment-history-swatch" style={{ background: "var(--text)", borderRadius: "50%" }} /> 5m read (dot, lower panel)
        </span>
      </div>
    </div>
  );
}
