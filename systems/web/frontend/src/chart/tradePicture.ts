import { composeSnapshot } from "./snapshot";

/** The levels a trade picture is labelled with. An option spread's are levels of the underlying. */
export type PictureLevels = { entry?: number | null; stop?: number | null; target?: number | null };

const num = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** "Entry 1,000 · Stop 950 · Target 1,100": only the levels there are. Empty when there are none. */
export function levelsLine(levels: PictureLevels): string {
  return [
    levels.entry != null ? `Entry ${num(levels.entry)}` : null,
    levels.stop != null ? `Stop ${num(levels.stop)}` : null,
    levels.target != null ? `Target ${num(levels.target)}` : null,
  ]
    .filter((x): x is string => x != null)
    .join(" · ");
}

const WHEN = { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } as const;

/** What the picture's header says under the title: what the picture is, the levels in force, and when. */
export function pictureSubtitle(label: string, levels: PictureLevels, now: Date = new Date()): string {
  return [label, levelsLine(levels), now.toLocaleString(undefined, WHEN)].filter(Boolean).join(" · ");
}

export type TradePictureInput = {
  /** The chart as the library exported it (a PNG data URL and the pixel ratio it was exported at): everything on it, the person's drawings and
   * indicators and the entry, stop and target lines, as they stand. */
  chart: { url: string; scale?: number };
  symbol: string;
  interval: string;
  /** e.g. "Plan at entry" or "Update". */
  label: string;
  levels: PictureLevels;
  /** The person's own words about it, printed under the chart. */
  caption?: string;
};

/** The picture kept with a trade: the chart exactly as it was, under a header that says what it is and what the trade's levels were, with the
 * person's words under it. A PNG data URL, or null when the browser cannot draw it. */
export function composeTradePicture(input: TradePictureInput, now: Date = new Date()): Promise<string | null> {
  return composeSnapshot({
    chart: input.chart.url,
    scale: input.chart.scale,
    title: `${input.symbol} · ${input.interval.replace("min", "m")}`,
    subtitle: pictureSubtitle(input.label, input.levels, now),
    note: input.caption ?? "",
    tag: null,
    aiLine: null,
  });
}
