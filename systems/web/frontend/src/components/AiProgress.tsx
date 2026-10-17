import { useEffect, useState } from "react";
import type { PremarketReport } from "../api/types";
import { BIAS_LABEL } from "../pages/premarketModel";

export type ProgressStep = { key: string; label: string; detail: string; state: "done" | "active" };

/** The stages of a brief that is being prepared, from what the server already has: the inputs are in and the rules have scored them; the model is reading. */
export function progressSteps(report: Pick<PremarketReport, "inputs" | "rules" | "ai_model">): ProgressStep[] {
  const ok = report.inputs.filter((i) => i.ok).length;
  return [
    { key: "inputs", label: "Market data collected", detail: `${ok} of ${report.inputs.length} inputs`, state: "done" },
    { key: "rules", label: "Rule-based read", detail: `${BIAS_LABEL[report.rules.bias]} (score ${report.rules.score.toFixed(2)})`, state: "done" },
    { key: "ai", label: "AI read", detail: report.ai_model ? `${report.ai_model} is reading the numbers` : "The model is reading the numbers", state: "active" },
  ];
}

/** Whole seconds since `since` (an ISO time), ticking once a second; falls back to the moment this first showed when the server gave no time. */
export function useElapsedSeconds(since: string | null | undefined, now: () => number = Date.now): number {
  const [started] = useState(() => (since ? new Date(since).getTime() : now()));
  const [tick, setTick] = useState(now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(now()), 1000);
    return () => window.clearInterval(id);
  }, [now]);
  return Math.max(0, Math.round((tick - started) / 1000));
}

/** Live progress while the AI read is prepared, instead of a one-line wait notice. The rule-based read stays on screen meanwhile. */
export function AiProgress({ report }: { report: PremarketReport }) {
  const seconds = useElapsedSeconds(report.ai_requested_at);
  const steps = progressSteps(report);
  return (
    <div className="ai-progress" role="status" aria-live="polite" data-testid="ai-pending">
      <ol className="ai-steps">
        {steps.map((s) => (
          <li key={s.key} className={`ai-step ${s.state}`}>
            <span className="ai-step-mark" aria-hidden="true">{s.state === "done" ? "✓" : <i className="ai-spinner" />}</span>
            <span className="ai-step-text">
              <strong>{s.label}</strong>
              <span className="dim"> · {s.detail}</span>
              {s.state === "active" && <span className="faint num"> · {seconds}s</span>}
            </span>
          </li>
        ))}
      </ol>
      <div className="ai-bar" aria-hidden="true"><i /></div>
      <span className="faint" style={{ fontSize: 12 }}>The rule-based read stands meanwhile and updates when the AI read lands, usually within half a minute.</span>
    </div>
  );
}
