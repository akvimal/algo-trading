// A drawing is anchored in price and TIME, and must stay put when the candle size changes. The chart
// library turns a bare timestamp into the nearest loaded bar, so switching 5m to 1h would snap a
// corner drawn at 09:07 onto the 09:00 or 10:00 candle and visibly move the drawing. So a restored
// point is handed over as a continuous, possibly fractional, bar index instead, worked out by
// interpolating between the two REAL bars either side of the timestamp. (Calendar arithmetic cannot
// do it: market bars only exist in trading hours, so a naive formula overshoots across every
// overnight and weekend gap.)

export type BarAnchor = { timestamps: number[] };

/** Index of the last bar at or before `ts` (binary search over ascending timestamps); -1 if `ts`
 * precedes the first bar. */
export function floorBarIndex(ts: number, timestamps: number[]): number {
  let lo = 0;
  let hi = timestamps.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function tsToFractionalIndex(ts: number, anchor: BarAnchor): number | null {
  const t = anchor.timestamps;
  if (!Number.isFinite(ts) || t.length === 0) return null;
  const last = t.length - 1;
  const i = floorBarIndex(ts, t);
  if (i < 0) {
    // Older than everything loaded: extrapolate with the first pair's spacing.
    if (t.length < 2 || t[1] === t[0]) return 0;
    return (ts - t[0]) / (t[1] - t[0]);
  }
  if (i >= last) {
    if (ts === t[last]) return last;
    if (t.length < 2 || t[last] === t[last - 1]) return last;
    return last + (ts - t[last]) / (t[last] - t[last - 1]);
  }
  const span = t[i + 1] - t[i];
  return span > 0 ? i + (ts - t[i]) / span : i;
}

export function fractionalIndexToTs(idx: number, anchor: BarAnchor): number | null {
  const t = anchor.timestamps;
  if (!Number.isFinite(idx) || t.length === 0) return null;
  const last = t.length - 1;
  if (idx <= 0) return t.length < 2 ? t[0] : t[0] + idx * (t[1] - t[0]);
  if (idx >= last) return t.length < 2 ? t[last] : t[last] + (idx - last) * (t[last] - t[last - 1]);
  const i0 = Math.floor(idx);
  return t[i0] + (idx - i0) * (t[i0 + 1] - t[i0]);
}

type Point = { timestamp?: number; value?: number; dataIndex?: number };

/** A stored point as the library wants it: a fractional index when there are bars to convert against,
 * else the raw timestamp. Never both: the library recomputes the index from a timestamp on every
 * frame, which would quietly undo the conversion. */
export function toChartPoint(p: { timestamp?: number; value?: number }, anchor: BarAnchor | null): Point {
  const idx = typeof p.timestamp === "number" && anchor ? tsToFractionalIndex(p.timestamp, anchor) : null;
  return idx != null ? { dataIndex: idx, value: p.value } : { timestamp: p.timestamp, value: p.value };
}

/** The reverse, for saving: a point that has only been dragged carries an index and no timestamp, so
 * recover the real time from the index; storage must always keep the timeframe-independent anchor. */
export function pointTimestamp(p: Point, anchor: BarAnchor | null): number | undefined {
  if (typeof p.timestamp === "number") return p.timestamp;
  if (anchor && typeof p.dataIndex === "number") return fractionalIndexToTs(p.dataIndex, anchor) ?? undefined;
  return undefined;
}
