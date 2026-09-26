export type Bar = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

/** The bar to show after a price tick. While the newest bar's window is open the tick just moves its
 * close and stretches its high or low. Once that window has ended, and the market is plausibly still
 * open (the last real bar is under two windows old), a fresh bar is started at the tick, so a quiet
 * minute does not leave the chart a bar behind; the next download replaces it with the real one. A
 * stale series (market closed, a data gap) is left alone: no phantom bars. Daily bars never start a
 * new bar from a tick (`canStartBar` false): a Saturday would otherwise get one. Null = nothing to draw. */
export function rollLiveBar(last: Bar | null, price: number | null, now: number, intervalMs: number, canStartBar = true): Bar | null {
  if (!last || price == null || !Number.isFinite(price) || intervalMs <= 0) return null;
  const windowEnd = last.timestamp + intervalMs;
  if (now < windowEnd) {
    const high = Math.max(last.high, price);
    const low = Math.min(last.low, price);
    if (last.close === price && last.high === high && last.low === low) return null;
    return { ...last, close: price, high, low };
  }
  if (canStartBar && now - last.timestamp < 2 * intervalMs) {
    return { timestamp: windowEnd, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 };
  }
  return null;
}
