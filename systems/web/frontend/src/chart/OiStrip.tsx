import type { OiSummary, SentimentHistoryPoint } from "../api/types";
import { formatPrice } from "../format";
import type { OiLevelLine } from "./oiLevels";
import {
  BUILDUP_ICON, BUILDUP_LABEL, buildupTone, classifyPcr, deltaPct, flowSkew, hasSentimentTrend, isStaleAt, pcrDiverges, sentimentSteps, volumePcr,
  type SentStep,
} from "./oiStripModel";

const hhmm = (t: string | number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** Indices report OI in crores; a crypto perpetual's open interest is a plain contract count. */
const fmtOi = (n: number, crypto: boolean) => (crypto ? Math.round(n).toLocaleString("en-US") : compactIndian(n));
function compactIndian(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `${(n / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${(n / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function OiChangeBadge({ change, total }: { change: number | null; total: number }) {
  const d = deltaPct(change, total);
  if (!d) return <span className="faint">–</span>;
  return (
    <span className={d.up ? "up" : "dn"}>
      {d.up ? "▲" : "▼"}
      {d.pct.toFixed(1)}%
    </span>
  );
}

function Sentiment({ points, window }: { points: SentimentHistoryPoint[]; window: "5m" | "15m" }) {
  const steps = sentimentSteps(points, window);
  if (steps.length < 2) return null;
  const maxAbs = Math.max(0.2, ...steps.map((s: SentStep) => Math.abs(s.score)));
  const last = steps[steps.length - 1];
  const prev = steps[steps.length - 2];
  const stale = isStaleAt(last.recordedAt);
  return (
    <span
      className="oi-strip-sent"
      data-testid={`oi-sent-${window}`}
      title={`OI shift % (${window}) over the last readings — bars are the reading, ⚡ marks a major move or a side flip. Written every 5 min. Last reading ${hhmm(last.recordedAt)}${stale ? " (stale)" : ""}.`}
    >
      <span className="oi-strip-spark">
        {steps.map((s) => (
          <span
            key={s.barTime}
            className={`oi-strip-spark-bar ${s.major ? "is-major" : ""}`}
            style={{ height: `${Math.max(8, (Math.abs(s.score) / maxAbs) * 100)}%` }}
            data-tone={s.score > 0.02 ? "up" : s.score < -0.02 ? "dn" : "flat"}
            title={`${hhmm(s.barTime)}: ${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)}%${s.major ? " — major move" : ""}`}
          />
        ))}
      </span>
      <b className={last.score > 0.02 ? "up" : last.score < -0.02 ? "dn" : "faint"}>
        {last.score >= 0 ? "+" : ""}
        {last.score.toFixed(2)}%
      </b>
      <span className="faint">{window}</span>
      {last.major && (
        <span className="pill" data-testid={`oi-sent-flag-${window}`}>
          ⚡ {last.score - prev.score >= 0 ? "+" : ""}
          {(last.score - prev.score).toFixed(2)} vs {hhmm(prev.barTime)}
        </span>
      )}
      {stale && <span className="faint">stale</span>}
    </span>
  );
}

/** A compact read of the option chain under the chart of an OI-eligible instrument — PCR (open-interest
 * and volume-based), call/put OI with their 5m/15m change, resistance/support strikes, buildup badges,
 * a flow-skew read, and the "OI trend" sentiment sparklines. Always shown for an eligible instrument; the
 * on-chart lines are a separate, opt-in layer (see the "OI levels" toggle). Renders nothing without data. */
export function OiStrip({ summary, sentiment, levels }: { summary: OiSummary | null; sentiment: SentimentHistoryPoint[]; levels: OiLevelLine[] }) {
  if (!summary) return null;
  const crypto = summary.underlying_exchange === "CRYPTO";
  const volPcr = volumePcr(summary.strikes);
  const diverges = pcrDiverges(summary.pcr, volPcr);
  const skew = flowSkew(summary.total_call_oi_change_5m, summary.total_call_oi, summary.total_put_oi_change_5m, summary.total_put_oi);
  const solid = levels.filter((l) => !l.forming);
  const resistance = solid.filter((l) => l.kind === "resistance").sort((a, b) => a.rank - b.rank);
  const support = solid.filter((l) => l.kind === "support").sort((a, b) => a.rank - b.rank);

  return (
    <div className="oi-strip" data-testid="oi-strip" title={`Nearest-expiry option OI for ${summary.underlying_symbol}, as of this poll`}>
      <span>
        PCR <b>{summary.pcr != null ? summary.pcr.toFixed(2) : "–"}</b>
      </span>
      <span
        className={diverges ? "pill warn" : undefined}
        title={diverges ? `Volume PCR (today's trading) reads ${classifyPcr(volPcr)} while OI PCR (standing positions) reads ${classifyPcr(summary.pcr)}` : "Put volume / call volume, today's actual trading"}
      >
        Vol PCR <b>{volPcr != null ? volPcr.toFixed(2) : "–"}</b>
        {diverges ? " ⇄" : ""}
      </span>
      <span>
        CE OI {fmtOi(summary.total_call_oi, crypto)}{" "}
        <OiChangeBadge change={summary.total_call_oi_change_15m} total={summary.total_call_oi} />/15m <OiChangeBadge change={summary.total_call_oi_change_5m} total={summary.total_call_oi} />/5m
      </span>
      <span>
        PE OI {fmtOi(summary.total_put_oi, crypto)}{" "}
        <OiChangeBadge change={summary.total_put_oi_change_15m} total={summary.total_put_oi} />/15m <OiChangeBadge change={summary.total_put_oi_change_5m} total={summary.total_put_oi} />/5m
      </span>
      {resistance.length > 0 && (
        <span title={resistance.map((l) => l.label).join("  ")}>
          R <b>{resistance.map((l) => formatPrice(l.price)).join(" · ")}</b>
        </span>
      )}
      {support.length > 0 && (
        <span title={support.map((l) => l.label).join("  ")}>
          S <b>{support.map((l) => formatPrice(l.price)).join(" · ")}</b>
        </span>
      )}
      {summary.total_call_buildup && (
        <span className={`pill ${buildupTone(summary.total_call_buildup, "CE")}`} title={`Call OI: ${BUILDUP_LABEL[summary.total_call_buildup]}`}>
          {BUILDUP_ICON[summary.total_call_buildup]} CE {summary.total_call_buildup.replace("_", " ")}
        </span>
      )}
      {summary.total_put_buildup && (
        <span className={`pill ${buildupTone(summary.total_put_buildup, "PE")}`} title={`Put OI: ${BUILDUP_LABEL[summary.total_put_buildup]}`}>
          {BUILDUP_ICON[summary.total_put_buildup]} PE {summary.total_put_buildup.replace("_", " ")}
        </span>
      )}
      {skew && (
        <span title={`Put OI is moving ${skew.leader === "PE" ? "faster" : "slower"} than call OI this 5-minute window`}>
          Δ{skew.pct.toFixed(1)}pp {skew.leader}-led
        </span>
      )}
      {hasSentimentTrend(sentiment) && <span className="faint oi-strip-trend-label">OI trend</span>}
      <Sentiment points={sentiment} window="15m" />
      <Sentiment points={sentiment} window="5m" />
    </div>
  );
}
