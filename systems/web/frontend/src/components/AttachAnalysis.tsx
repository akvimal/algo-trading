import type { IdeaAnalysisState } from "../hooks/useIdeaAnalysis";

/** "Include the AI analysis" in a publish form: a tick that reads the stock's analysis (chart and business, one verdict) and sends a short form of it
 * with the post. It says what is happening while the first read of a stock takes its time, and why it could not be had, so the person never
 * wonders whether it went out. */
export function AttachAnalysis({ id, symbol, checked, onChange, state }: { id: string; symbol: string; checked: boolean; onChange: (v: boolean) => void; state: IdeaAnalysisState }) {
  return (
    <div className="stack" data-testid="attach-analysis">
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>
          Include the AI analysis
          <span className="faint" style={{ display: "block", fontSize: 12 }}>
            The verdict from {symbol}'s chart and business, with the strongest reasons and the nearest levels. Written by AI and simple rules from public data, and the post says so.
          </span>
        </span>
      </label>
      {checked && state.loading && (
        <span className="faint" role="status" style={{ fontSize: 12 }}>
          Reading the analysis… the first time for a stock this can take up to a minute.
        </span>
      )}
      {checked && state.error && (
        <span className="error-text" role="alert" style={{ fontSize: 12 }}>
          {state.error} Untick it to publish without the analysis.
        </span>
      )}
    </div>
  );
}
