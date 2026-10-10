// Drawing aids, as plain functions (no chart): where a zone's corner snaps to, and when a line goes flat.

export type Wick = { high: number; low: number };

/** The drawings whose end can be held level with the other end (Shift), as in TradingView: a trend line and a ray. */
export const SHIFT_LEVEL_TOOLS: ReadonlySet<string> = new Set(["segment", "rayLine"]);

/** Where a zone's corner lands with the magnet on: the candle's HIGH or its LOW, whichever is nearer, so the top and bottom edges of a
 * zone sit on wicks rather than on a candle's open or close. A corner inside the candle's range snaps; one just outside it (within `reach`,
 * the price distance of the magnet's pixel sensitivity) does too; one clearly beyond the wick is left where the person put it, so a zone can
 * still extend past a candle on purpose. */
export function snapZoneCorner(value: number, candle: Wick, reach: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(candle.high) || !Number.isFinite(candle.low) || candle.high < candle.low) return value;
  const slack = Number.isFinite(reach) && reach > 0 ? reach : 0;
  if (value > candle.high + slack || value < candle.low - slack) return value;
  return value - candle.low <= candle.high - value ? candle.low : candle.high;
}

/** The price a line's end takes while Shift is held: the other end's, so the line is flat. Null when it does not apply (a drawing that is not a
 * line, or no other end to match yet). */
export function levelWithOtherEnd(tool: string, index: number, values: Array<number | undefined>): number | null {
  if (!SHIFT_LEVEL_TOOLS.has(tool) || values.length < 2) return null;
  const other = values[index === 0 ? 1 : 0];
  return typeof other === "number" && Number.isFinite(other) ? other : null;
}
