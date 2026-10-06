import type { Bias, PremarketInput, PremarketReport } from "../api/types";
import { formatTime, istDayKey } from "../format";

const MINUS = "−";

/** "+0.66%" for a price move, "+3.4 bp" for a yield (basis points). Signed, so colour never carries it alone. */
export function formatMove(input: Pick<PremarketInput, "change" | "unit" | "ok">): string {
  if (!input.ok || input.change == null) return "–";
  const sign = input.change > 0 ? "+" : input.change < 0 ? MINUS : "";
  const body = Math.abs(input.change).toFixed(input.unit === "bp" ? 1 : 2);
  return `${sign}${body}${input.unit === "bp" ? " bp" : "%"}`;
}

/** Crude, the rupee's fall and yields work against Indian equities, so a rise in them is bad news. */
const INVERTED = new Set(["brent", "wti", "usdinr", "us10y", "in10y"]);
export function moveTone(input: Pick<PremarketInput, "key" | "change" | "ok">): "up" | "dn" | "flat" {
  if (!input.ok || !input.change) return "flat";
  const good = INVERTED.has(input.key) ? input.change < 0 : input.change > 0;
  return good ? "up" : "dn";
}

export const BIAS_LABEL: Record<Bias, string> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };

export type Section = { title: string; inputs: PremarketInput[] };

/** The inputs in the order a trader reads them: the gap first, then what drove it. */
export function sections(inputs: PremarketInput[]): Section[] {
  const by = (keys: string[]) => keys.map((k) => inputs.find((i) => i.key === k)).filter((i): i is PremarketInput => !!i);
  const defs: [string, string[]][] = [
    ["GIFT Nifty", ["gift_nifty"]],
    ["US close", ["sp500", "dow", "nasdaq"]],
    ["Crude, rupee, yields", ["brent", "wti", "usdinr", "us10y", "in10y"]],
    ["Indian ADRs", ["adr_infy", "adr_hdb", "adr_wit", "adr_ibn", "adr_rdy"]],
  ];
  return defs.map(([title, keys]) => ({ title, inputs: by(keys) })).filter((s) => s.inputs.length > 0);
}

/** "Today 08:45", or "Fri 2 Oct 08:45" for an older report (a weekend, or before the morning's run). */
export function reportAge(report: Pick<PremarketReport, "generated_at">, now: Date = new Date()): { stale: boolean; text: string } {
  const stale = istDayKey(report.generated_at) !== istDayKey(now);
  const time = formatTime(report.generated_at);
  if (!stale) return { stale, text: `Today ${time}` };
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(report.generated_at));
  return { stale, text: `${day} ${time}` };
}

/** The headline sentence: the model's one-liner, or - when it did not run - a plain statement of the rule-based read. */
export function headline(report: PremarketReport): string {
  if (report.ai) return report.ai.one_liner;
  const gap = report.rules.gift_gap_pct;
  const gapText = gap == null ? "" : ` GIFT Nifty is ${gap >= 0 ? "up" : "down"} ${Math.abs(gap).toFixed(2)}% on Nifty's last close.`;
  return `Rule-based read: ${BIAS_LABEL[report.rules.bias].toLowerCase()}.${gapText}`;
}
