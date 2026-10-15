import { useState } from "react";
import type { OiSummary, SentimentHistoryPoint } from "../api/types";
import type { Ref } from "react";
import { AiReadButton, type AiReadHandle } from "./AiReadPanel";
import { formatPrice } from "../format";
import { ACTIVITY_LABEL, SIDE_HELP, sideActivity } from "../pages/scanModel";
import type { OiLevelLine } from "./oiLevels";
import {
  BUILDUP_ABBR, BUILDUP_ICON, buildupTone, classifyPcr, deltaPct, flowSkew, hasSentimentTrend, skewView, isStaleAt, pcrDiverges, sentimentSteps, volumePcr,
  fmtOi, type SentStep,
} from "./oiStripModel";

const hhmm = (t: string | number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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

/** Which side's OI is growing faster this 5-minute window: a bar from the centre (CE fills left, PE fills
 * right, longer = a wider gap), toned green for put-led and red for call-led — the PCR's own convention. */
function FlowSkew({ skew, summary }: { skew: { pct: number; leader: "CE" | "PE" }; summary: OiSummary }) {
  const v = skewView(skew);
  const ce = deltaPct(summary.total_call_oi_change_5m, summary.total_call_oi);
  const pe = deltaPct(summary.total_put_oi_change_5m, summary.total_put_oi);
  const signed = (d: { pct: number; up: boolean } | null) => (d ? `${d.up ? "+" : "-"}${d.pct.toFixed(1)}%` : "–");
  return (
    <span
      className={`oi-skew ${v.tone}`}
      data-testid="oi-skew"
      title={`${v.leader === "PE" ? "Put" : "Call"} OI is growing faster over 5m: puts ${signed(pe)} vs calls ${signed(ce)} (gap ${skew.pct.toFixed(1)}pp). ${
        v.leader === "PE" ? "Usually put writers adding support (bullish)" : "Usually call writers adding resistance (bearish)"
      }, but OI alone can't tell writing from buying — check the ${v.leader} pill.`}
    >
      <span className="oi-skew-bar" aria-hidden="true">
        <span className="oi-skew-fill" style={{ width: `${v.fill * 50}%`, [v.leader === "PE" ? "left" : "right"]: "50%" }} />
      </span>
      <b>
        {v.leader} +{skew.pct.toFixed(1)}%
      </b>
    </span>
  );
}

/** A compact read of the option chain under the chart of an OI-eligible instrument — PCR (open-interest
 * and volume-based), call/put OI with their 5m/15m change, resistance/support strikes, buildup badges,
 * a flow-skew read, and the "OI trend" sentiment sparklines. Always shown for an eligible instrument; the
 * on-chart lines are a separate, opt-in layer (see the "OI levels" toggle). Renders nothing without data.
 * The R/S text below is skipped when that same layer is already drawing them on the chart - the same
 * numbers, so showing both just duplicates the space rather than the information. */
export function OiStrip({
  summary,
  sentiment,
  levels,
  onChartLevelsOn,
  stripOn = true,
  aiTarget = null,
  aiRef,
}: {
  summary: OiSummary | null;
  sentiment: SentimentHistoryPoint[];
  levels: OiLevelLine[];
  onChartLevelsOn: boolean;
  /** False when the person has hidden the strip: only a slim row with the AI read stays (see `aiTarget`). */
  stripOn?: boolean;
  /** The instrument to read for the AI read when the strip is hidden and there is no option-chain summary; null: nothing to show. */
  aiTarget?: { exchange: string; symbol: string } | null;
  /** Lets the screen start the AI read from outside (the rail's AI read button). */
  aiRef?: Ref<AiReadHandle>;
}) {
  // On a phone the strip is one line (PCR, the call and put reading, the 15-minute trend); this opens the rest.
  const [more, setMore] = useState(false);
  if (!stripOn) {
    return aiTarget ? (
      <div className="oi-strip oi-strip-slim" data-testid="oi-strip-slim">
        <AiReadButton ref={aiRef} exchange={aiTarget.exchange} symbol={aiTarget.symbol} hideButton />
      </div>
    ) : null;
  }
  if (!summary) return null;
  const crypto = summary.underlying_exchange === "CRYPTO";
  const volPcr = volumePcr(summary.strikes);
  const diverges = pcrDiverges(summary.pcr, volPcr);
  const skew = flowSkew(summary.total_call_oi_change_5m, summary.total_call_oi, summary.total_put_oi_change_5m, summary.total_put_oi);
  const solid = onChartLevelsOn ? [] : levels.filter((l) => !l.forming);
  const resistance = solid.filter((l) => l.kind === "resistance").sort((a, b) => a.rank - b.rank);
  const support = solid.filter((l) => l.kind === "support").sort((a, b) => a.rank - b.rank);

  return (
    <div className={`oi-strip ${more ? "open" : ""}`} data-testid="oi-strip" title={`Nearest-expiry option OI for ${summary.underlying_symbol}, as of this poll`}>
      <span>
        PCR <b>{summary.pcr != null ? summary.pcr.toFixed(2) : "–"}</b>
      </span>
      <span
        className={`oi-extra${diverges ? " pill warn" : ""}`}
        title={diverges ? `Volume PCR (today's trading) reads ${classifyPcr(volPcr)} while OI PCR (standing positions) reads ${classifyPcr(summary.pcr)}` : "Put volume / call volume, today's actual trading"}
      >
        Vol PCR <b>{volPcr != null ? volPcr.toFixed(2) : "–"}</b>
        {diverges ? " ⇄" : ""}
      </span>
      <span className="oi-extra">
        CE OI {fmtOi(summary.total_call_oi, crypto)}{" "}
        <OiChangeBadge change={summary.total_call_oi_change_15m} total={summary.total_call_oi} />/15m <OiChangeBadge change={summary.total_call_oi_change_5m} total={summary.total_call_oi} />/5m
      </span>
      <span className="oi-extra">
        PE OI {fmtOi(summary.total_put_oi, crypto)}{" "}
        <OiChangeBadge change={summary.total_put_oi_change_15m} total={summary.total_put_oi} />/15m <OiChangeBadge change={summary.total_put_oi_change_5m} total={summary.total_put_oi} />/5m
      </span>
      {resistance.length > 0 && (
        <span className="oi-extra" title={resistance.map((l) => l.label).join("  ")}>
          R <b>{resistance.map((l) => formatPrice(l.price)).join(" · ")}</b>
        </span>
      )}
      {support.length > 0 && (
        <span className="oi-extra" title={support.map((l) => l.label).join("  ")}>
          S <b>{support.map((l) => formatPrice(l.price)).join(" · ")}</b>
        </span>
      )}
      {summary.total_call_buildup && (
        <span className={`pill ${buildupTone(summary.total_call_buildup, "CE")}`} title={`Call OI: ${ACTIVITY_LABEL[sideActivity("call", null, summary.total_call_buildup)!.activity]} - ${SIDE_HELP.call[summary.total_call_buildup]}`}>
          {BUILDUP_ICON[summary.total_call_buildup]} CE {BUILDUP_ABBR[summary.total_call_buildup]}
        </span>
      )}
      {summary.total_put_buildup && (
        <span className={`pill ${buildupTone(summary.total_put_buildup, "PE")}`} title={`Put OI: ${ACTIVITY_LABEL[sideActivity("put", null, summary.total_put_buildup)!.activity]} - ${SIDE_HELP.put[summary.total_put_buildup]}`}>
          {BUILDUP_ICON[summary.total_put_buildup]} PE {BUILDUP_ABBR[summary.total_put_buildup]}
        </span>
      )}
      {skew && (
        <span className="oi-extra">
          <FlowSkew skew={skew} summary={summary} />
        </span>
      )}
      {hasSentimentTrend(sentiment) && <span className="faint oi-strip-trend-label oi-extra">OI trend</span>}
      <Sentiment points={sentiment} window="15m" />
      <span className="oi-extra">
        <Sentiment points={sentiment} window="5m" />
      </span>
      <button className="oi-more" aria-expanded={more} aria-label={more ? "Show fewer open-interest readings" : "Show all open-interest readings"} onClick={() => setMore((m) => !m)}>
        {more ? "▴" : "▾"}
      </button>
      <AiReadButton ref={aiRef} exchange={summary.underlying_exchange} symbol={summary.underlying_symbol} expiry={summary.expiry} hideButton />
    </div>
  );
}
