import { useEffect, useState } from "react";

import { type SentimentDirection, type SentimentHistoryPoint, fetchSentimentHistory } from "./api";
import { buildupBadge } from "./OiSummaryPage";

// Same cadence the scheduled recorder itself writes at (see market-data's
// app/scheduler.py) - no value polling more often than a new row could
// actually land. Only polled while viewing TODAY (see the effect below) -
// a past day's history never changes once written.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

// The visible x-axis window is fixed at 3 hours (not the full session,
// which can be up to 14.5h for MCX) - a horizontal slider pans across the
// rest of the session instead, same idea as a candlestick chart's own
// zoomed default view. Keeps points spread out enough to actually read
// (direction/strength dot sizes, the score subplot's bars) instead of
// compressed across a whole day's width.
const WINDOW_MS = 3 * 60 * 60 * 1000;

const WIDTH = 900;
const PAD_LEFT = 64;
const PAD_RIGHT = 12;
// Also the vertical strip the direction-flip triangles are drawn in
// (flipMarkerPoints below) - keep >= 14.
const PAD_TOP = 20;
// Two stacked plots sharing one x (time) axis - price on top (the thing
// you're checking for alignment), the raw OI-shift score underneath (the
// thing sentiment.py's direction/strength bucketing is actually derived
// from - see its own _classify) so you can see the raw number building
// *before* a strength bucket flips, not just the bucketed label a point's
// color/size already shows on the price plot above.
const PRICE_PLOT_HEIGHT = 130;
// Was 10 - widened to seat a proper bold subplot title row ("OI shift %")
// instead of a 9px axis-corner label that was near-illegible.
const SUBPLOT_GAP = 26;
// The raw OI-shift score is the number sentiment.py's whole
// direction/strength bucketing is derived from, so give it real vertical
// room (was 56) and its own ± scale labels (see the axis text below) -
// a bar's height meant nothing in absolute terms before.
const SCORE_PLOT_HEIGHT = 92;
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

// A run of same-direction reads breaking to the other side is the single
// most actionable thing in this history (OI positioning reversing), so
// mark every change of `direction` - brightest for a true
// bullish<->bearish reversal, dimmed when neutral sits on either side.
type DirectionFlip = { t: number; from: SentimentDirection; to: SentimentDirection };

function computeFlips(pts: SentimentHistoryPoint[]): DirectionFlip[] {
  const flips: DirectionFlip[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].direction !== pts[i - 1].direction) {
      flips.push({
        t: new Date(pts[i].recorded_at).getTime(),
        from: pts[i - 1].direction,
        to: pts[i].direction,
      });
    }
  }
  return flips;
}

// Small triangle drawn in the PAD_TOP strip above the price plot, pointing
// the way the new read leans (up = bullish, down = bearish, diamond =
// neutral).
function flipMarkerPoints(cx: number, dir: SentimentDirection): string {
  if (dir === "bullish") return `${cx - 4},13 ${cx + 4},13 ${cx},4`;
  if (dir === "bearish") return `${cx - 4},4 ${cx + 4},4 ${cx},13`;
  return `${cx - 3.5},9 ${cx},3.5 ${cx + 3.5},9 ${cx},14.5`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatAxisTime(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// Plain "YYYY-MM-DD" in the VIEWER's own local time - good enough for a
// day-picker default/Prev/Next-disable check; the backend resolves "today"
// itself (settings.timezone, IST) when `date` is omitted, so this is only
// ever used for user-driven navigation, not sent as the very first fetch.
function todayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayHeading(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Spot price over time for one sentiment-badge symbol, for one calendar
// day at a time (Prev/Next/date-pick navigation), each point colored by
// that snapshot's own OI-based direction (green=bullish, red=bearish,
// gray=neutral) - lets you eyeball whether price actually moved the way a
// past OI read predicted (e.g. a run of bullish reads followed by the
// line trending up), which was the whole point of persisting this history
// (see market-data's market_data.sentiment_history table). The x-axis
// shows a fixed WINDOW_MS-wide slice of that day's own trading-session
// window (session_start/session_end from the backend, resolved from
// SEGMENT_SESSION_HOURS) - not the data's own min/max, and not the full
// session at once - with a horizontal slider to pan across the rest of
// the session; defaults to the most recent WINDOW_MS (up to "now" if
// viewing today, else up to session_end). A second, synced subplot
// underneath plots the raw score_15m (bars) and score_5m (dots) that
// direction/strength above is actually bucketed from - the building/fading momentum shows up here
// before it ever flips a bucket; that subplot carries its own bold title
// and ± scale labels. The latest read's raw 15m shift % is also surfaced
// as a big number above the chart, and every point where `direction`
// changes gets a flip marker (vertical guide + a triangle pointing the new
// way) - see computeFlips. Hand-rolled SVG, same approach as
// execution/frontend's PnlChart.tsx and this app's own OiBarChart.tsx - no
// charting library in this codebase.
export function SentimentHistoryChart({ symbol }: { symbol: string }) {
  const [date, setDate] = useState(todayDateString);
  const [day, setDay] = useState<{ exchange: string; sessionStart: number; sessionEnd: number; points: SentimentHistoryPoint[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // null = not yet panned by the user this day - falls back to the
  // "most recent WINDOW_MS" default computed below once `day` loads.
  // Reset to null whenever the date/symbol changes so switching days
  // doesn't carry over a manually-panned position from a different one.
  const [windowStart, setWindowStart] = useState<number | null>(null);

  const isToday = date === todayDateString();

  useEffect(() => {
    let cancelled = false;
    setDay(null);
    setError(null);
    setHoverIndex(null);
    setWindowStart(null);

    async function poll() {
      try {
        const data = await fetchSentimentHistory(symbol, date);
        if (!cancelled) {
          setDay({
            exchange: data.exchange,
            sessionStart: new Date(data.session_start).getTime(),
            sessionEnd: new Date(data.session_end).getTime(),
            points: data.points,
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void poll();
    if (!isToday) return () => { cancelled = true; };
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol, date, isToday]);

  if (error) return <p className="error">{error}</p>;

  const dayNav = (
    <div className="sentiment-history-daynav">
      <button type="button" className="icon-btn" onClick={() => setDate((d) => addDays(d, -1))} aria-label="Previous day">
        ‹
      </button>
      <input type="date" value={date} max={todayDateString()} onChange={(e) => setDate(e.target.value)} />
      <button type="button" className="icon-btn" onClick={() => setDate((d) => addDays(d, 1))} disabled={isToday} aria-label="Next day">
        ›
      </button>
      {!isToday && (
        <button type="button" className="tiny secondary" onClick={() => setDate(todayDateString())}>
          Today
        </button>
      )}
    </div>
  );

  if (day === null) {
    return (
      <div className="sentiment-history-chart">
        {dayNav}
        <p className="muted">Loading sentiment history for {formatDayHeading(date)}...</p>
      </div>
    );
  }

  const { sessionStart, sessionEnd, points } = day;
  const allWithPrice = points.filter((p) => p.spot_price != null);

  if (allWithPrice.length === 0) {
    return (
      <div className="sentiment-history-chart">
        {dayNav}
        <p className="muted">
          No sentiment history recorded for {symbol} on {formatDayHeading(date)}
          {isToday ? " yet - check back after the next 5-minute tick" : " - the market may not have been in session that day"}.
        </p>
      </div>
    );
  }

  // The visible x-axis window is a fixed WINDOW_MS slice of the session
  // (clamped to the session's own length, for a segment whose session is
  // somehow shorter), pannable via the slider below - see this
  // component's own docblock and WINDOW_MS's.
  const sessionSpan = Math.max(1, sessionEnd - sessionStart);
  const windowMs = Math.min(WINDOW_MS, sessionSpan);
  const maxWindowStart = Math.max(sessionStart, sessionEnd - windowMs);
  const defaultWindowEnd = isToday ? Math.min(Date.now(), sessionEnd) : sessionEnd;
  const defaultWindowStart = Math.min(maxWindowStart, Math.max(sessionStart, defaultWindowEnd - windowMs));
  const effectiveWindowStart =
    windowStart != null ? Math.min(Math.max(windowStart, sessionStart), maxWindowStart) : defaultWindowStart;
  const windowEnd = effectiveWindowStart + windowMs;

  const slider = maxWindowStart > sessionStart && (
    <input
      type="range"
      className="sentiment-history-slider"
      min={sessionStart}
      max={maxWindowStart}
      step={5 * 60 * 1000} // 5 min - matches the recorder's own cadence
      value={effectiveWindowStart}
      onChange={(e) => {
        setWindowStart(Number(e.target.value));
        // Panning changes withPrice's own length (the current window's
        // filtered subset) - a stale hoverIndex from before the pan can
        // point past the end of the new one. Bounds-checked defensively
        // too (see `hovered` above), but reset here as well so the
        // tooltip doesn't linger on a now-meaningless index instead of
        // just disappearing.
        setHoverIndex(null);
      }}
      aria-label={`Pan the visible ${(WINDOW_MS / 3600000).toFixed(0)}-hour window across the trading session`}
    />
  );

  const withPrice = allWithPrice.filter((p) => {
    const t = new Date(p.recorded_at).getTime();
    return t >= effectiveWindowStart && t <= windowEnd;
  });

  const minTime = effectiveWindowStart;
  const maxTime = windowEnd;

  if (withPrice.length === 0) {
    return (
      <div className="sentiment-history-chart">
        {dayNav}
        <p className="sentiment-history-window-label">
          {formatAxisTime(minTime)} – {formatAxisTime(maxTime)}
        </p>
        {slider}
        <p className="muted">No sentiment history in this window - pan the slider to see {symbol}'s recorded history for this day.</p>
      </div>
    );
  }

  const times = withPrice.map((p) => new Date(p.recorded_at).getTime());
  const prices = withPrice.map((p) => p.spot_price as number);
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

  // Flips are computed over the whole day (so one at the window's left
  // edge is still detected against the point just outside it), then
  // filtered to what's visible.
  const flips = computeFlips(points).filter((f) => f.t >= minTime && f.t <= maxTime);
  const flipTimes = new Set(flips.map((f) => f.t));

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

  // A handful of evenly-spaced x-axis time labels across the visible
  // WINDOW (not just where data happens to land) - fixed count/spacing
  // regardless of how many points exist, so a partial/gappy window still
  // gets a complete, evenly-ticked axis.
  const AXIS_TICK_COUNT = 6;
  const axisTickTimes = Array.from({ length: AXIS_TICK_COUNT }, (_, i) => minTime + (i * timeSpan) / (AXIS_TICK_COUNT - 1));

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

  // hoverIndex is bounds-checked against THIS render's withPrice, not just
  // non-null - panning the slider or navigating days changes withPrice's
  // own length (it's the current window's filtered subset now, not the
  // whole day), so a hoverIndex set before that change can point past the
  // new array's end. Reproduced live: "Cannot read properties of
  // undefined (reading 'spot_price')" after panning while a point was
  // hovered. The effect below also resets hoverIndex on every window
  // change, so this is a defensive second layer, not the only guard.
  const hovered = hoverIndex != null && hoverIndex < withPrice.length ? withPrice[hoverIndex] : null;
  const hoveredX = hovered ? x(times[hoverIndex as number]) : 0;
  const hoveredPriceY = hovered ? yPrice(hovered.spot_price as number) : 0;
  const tooltipOnLeft = hoveredX > WIDTH - 170;

  // The most recent read that has a 15m score, surfaced as a big number
  // above the chart - this % used to appear only in the hover tooltip's
  // dim one-liner. Scanned over the full day, not just the visible window.
  const latestScored = [...points].reverse().find((p) => p.score_15m != null) ?? null;
  const latestScoreVal = latestScored ? (latestScored.score_15m as number) : 0;

  return (
    <div className="sentiment-history-chart">
      {dayNav}
      {latestScored && (
        <div className="sentiment-history-latest">
          <span className="sentiment-history-latest-label">{isToday ? "Latest OI shift" : "Last OI shift"}</span>
          <span className="sentiment-history-latest-value" style={{ color: scoreColor(latestScoreVal) }}>
            {latestScoreVal > 0 ? "▲ " : latestScoreVal < 0 ? "▼ " : ""}
            {latestScoreVal.toFixed(2)}%
          </span>
          <span className="sentiment-history-latest-dir" style={{ color: DIRECTION_COLOR[latestScored.direction] }}>
            {directionLabel(latestScored)}
          </span>
          <span className="muted">{formatClock(latestScored.recorded_at)}</span>
        </div>
      )}
      <p className="sentiment-history-window-label">
        {formatAxisTime(minTime)} – {formatAxisTime(maxTime)}
      </p>
      {slider}
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label={`${symbol} spot price and OI shift, ${formatAxisTime(minTime)}-${formatAxisTime(maxTime)} on ${date}`}>
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
        <text x={PAD_LEFT} y={SCORE_TOP - 9} fontSize={11} fontWeight={700} fill="var(--text)">
          OI shift %
        </text>
        <text x={PAD_LEFT + 62} y={SCORE_TOP - 9} fontSize={9} fill="var(--text-dim)">
          15m bars · 5m dots
        </text>
        <text x={PAD_LEFT - 8} y={SCORE_TOP + 4} textAnchor="end" fontSize={9} fill="var(--text-dim)">
          +{maxAbsScore.toFixed(1)}
        </text>
        <text x={PAD_LEFT - 8} y={scoreZeroY + 3} textAnchor="end" fontSize={9} fill="var(--text-dim)">
          0
        </text>
        <text x={PAD_LEFT - 8} y={SCORE_BOTTOM} textAnchor="end" fontSize={9} fill="var(--text-dim)">
          −{maxAbsScore.toFixed(1)}
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
              fillOpacity={0.9}
            />
          ) : null,
        )}
        {withPrice.map((p, i) =>
          p.score_5m != null ? (
            <circle key={`dot-${p.recorded_at}`} cx={x(times[i])} cy={yScore(p.score_5m)} r={2} fill="var(--text)" />
          ) : null,
        )}

        {/* x-axis time labels, shared by both plots - spans the full
            session window, not just where data landed. */}
        {axisTickTimes.map((t, i) => (
          <text key={i} x={x(t)} y={XAXIS_Y} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
            {formatAxisTime(t)}
          </text>
        ))}

        {/* Direction-flip markers - vertical guide across both plots + a
            triangle above the price plot pointing the new way (see
            computeFlips / flipMarkerPoints). Brighter for a true
            bullish<->bearish reversal, dim when neutral is on either side. */}
        {flips.map((f) => {
          const reversal = f.from !== "neutral" && f.to !== "neutral";
          return (
            <g key={`flip-${f.t}`}>
              <line
                x1={x(f.t)}
                y1={PAD_TOP}
                x2={x(f.t)}
                y2={SCORE_BOTTOM}
                stroke={DIRECTION_COLOR[f.to]}
                strokeWidth={1}
                strokeDasharray="2 3"
                strokeOpacity={reversal ? 0.7 : 0.35}
              />
              <polygon points={flipMarkerPoints(x(f.t), f.to)} fill={DIRECTION_COLOR[f.to]} fillOpacity={reversal ? 1 : 0.55} />
            </g>
          );
        })}

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
          <div className="sentiment-history-tooltip-scores">
            <span style={{ color: scoreColor(hovered.score_15m) }}>
              15m {hovered.score_15m != null ? `${hovered.score_15m.toFixed(2)}%` : "-"}
            </span>
            <span className="muted">5m {hovered.score_5m != null ? `${hovered.score_5m.toFixed(2)}%` : "-"}</span>
          </div>
          {flipTimes.has(new Date(hovered.recorded_at).getTime()) && (
            <div className="sentiment-history-tooltip-flip" style={{ color: DIRECTION_COLOR[hovered.direction] }}>
              ⇅ Flipped {directionLabel(hovered)}
            </div>
          )}
          {(hovered.atm_call_buildup || hovered.atm_put_buildup) && (
            <div className="sentiment-history-tooltip-buildup">
              <span>Call {buildupBadge(hovered.atm_call_buildup)}</span>
              <span>Put {buildupBadge(hovered.atm_put_buildup)}</span>
            </div>
          )}
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
          <span className="sentiment-history-flip-glyph" aria-hidden="true">⇅</span> Direction flip
        </span>
        <span className="sentiment-history-legend-item">
          <span className="sentiment-history-swatch" style={{ background: "var(--text)", borderRadius: "50%" }} /> 5m read (dot, lower panel)
        </span>
      </div>
    </div>
  );
}
