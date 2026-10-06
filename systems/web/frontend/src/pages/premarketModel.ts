import type { Bias, PremarketIndicator, PremarketInput, PremarketMacro, PremarketReport } from "../api/types";
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

// ---- Domestic backdrop ------------------------------------------------------------------------------------------

const money = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

/** "4.82%" or "$747.6bn". */
export function formatIndicator(i: Pick<PremarketIndicator, "value" | "unit" | "ok">): string {
  if (!i.ok || i.value == null) return "–";
  return i.unit === "usd_bn" ? `$${money(i.value)}bn` : `${i.value.toFixed(2)}%`;
}

// Not Intl: en-IN spells September "Sept" in some runtimes and "Sep" in others, so the label would depend on the browser.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 2026": the month a print covers (the feed dates a period by its last day). */
export function periodLabel(iso: string | null): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-\d{2}/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}

/** How a print moved from the one before it, in words: "up 0.38 from 4.44%", "unchanged at 5.25%". */
export function indicatorMove(i: PremarketIndicator): string {
  if (!i.ok || i.change == null || i.previous == null) return "";
  const prev = formatIndicator({ value: i.previous, unit: i.unit, ok: true });
  if (i.change === 0) return `unchanged at ${prev}`;
  const size = i.unit === "usd_bn" ? `$${money(Math.abs(i.change))}bn` : Math.abs(i.change).toFixed(2);
  return `${i.change > 0 ? "up" : "down"} ${size} from ${prev}`;
}

/** Percentage points, signed: "+0.43 pts" / "−0.12 pts". */
export function formatPoints(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "–";
  return `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(2)} pts`;
}

export type DerivedRow = { label: string; value: string; hint: string };

/** The two figures that tie the prints to the bond market. A row is dropped when its inputs were missing. */
export function derivedRows(macro: Pick<PremarketMacro, "derived">): DerivedRow[] {
  const rows: DerivedRow[] = [];
  if (macro.derived.real_rate != null)
    rows.push({ label: "Real policy rate", value: formatPoints(macro.derived.real_rate), hint: "Repo rate minus CPI inflation. Positive means policy is tighter than inflation." });
  if (macro.derived.spread_10y_repo != null)
    rows.push({ label: "10Y yield over repo", value: formatPoints(macro.derived.spread_10y_repo), hint: "How far the 10-year yield sits above the policy rate." });
  return rows;
}

/** Whether there is anything to show for the backdrop at all (every feed can be down). */
export function hasMacro(macro: PremarketMacro | null | undefined, ai: PremarketReport["ai"]): boolean {
  if (!macro) return !!ai?.macro_context;
  return macro.indicators.some((i) => i.ok) || macro.rbi.length > 0 || !!ai?.macro_context;
}

/** "3 Oct" for an RBI item's date, on the IST calendar. */
export function shortDate(iso: string | null): string {
  if (!iso) return "";
  const [, month, day] = istDayKey(iso).split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}
