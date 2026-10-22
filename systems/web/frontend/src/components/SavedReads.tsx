import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listSavedReads, type Bias } from "../api/analysis";
import { useResource } from "../hooks/useResource";
import { fullTradeLink } from "../pages/scanModel";
import { AnalysisPanel } from "./AnalysisPanel";
import { BIAS_ARROW, BIAS_WORD, biasTone, percent, readAge } from "./analysisModel";
import { StockActions } from "./StockActions";
import { Empty, ErrorNotice, Skeleton } from "./bits";

const FILTERS: { id: "all" | Bias; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bullish", label: "Bullish" },
  { id: "neutral", label: "Neutral" },
  { id: "bearish", label: "Bearish" },
];

/** Every stock that already has an AI business read, newest first: a reference you can open without going back through a scan. Free to load (nothing is
 * captured and no model is called); a row opens the full analysis (chart and business together) from the stored read. */
export function SavedReads() {
  const reads = useResource(listSavedReads, []);
  const [filter, setFilter] = useState<"all" | Bias>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (reads.data ?? []).filter((r) => (filter === "all" || r.bias === filter) && (!q || r.symbol.includes(q)));
  }, [reads.data, filter, query]);

  if (reads.loading) return <Skeleton lines={4} />;
  if (reads.error && !reads.data) return <ErrorNotice error={reads.error} onRetry={reads.reload} />;
  if (!reads.data) return null;
  if (reads.data.length === 0) return <Empty title="No saved reads yet">Press "AI analysis" on a stock in a scan, or on the Trade page, and its business read is kept here.</Empty>;

  return (
    <div className="stack" data-testid="saved-reads">
      <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div className="chips" role="group" aria-label="Business read">
          {FILTERS.map((f) => (
            <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="select-field" style={{ flex: "1 1 160px" }}>
          <span className="dim">Search a symbol</span>
          <input type="search" value={query} placeholder="e.g. RELIANCE" onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <p className="faint" style={{ fontSize: 12, margin: 0 }}>
        {shown.length} of {reads.data.length} stocks. The business read is from screener.in; open a stock to see the chart read beside it.
      </p>
      {shown.map((r) => (
        <div key={r.symbol} className="card stack" data-testid="saved-read">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>
              {r.symbol}
              <StockActions symbol={r.symbol} />
            </strong>
            <span className={`pill ${biasTone(r.bias)}`}>
              {BIAS_ARROW[r.bias]} {BIAS_WORD[r.bias]}
              {r.confidence != null ? ` · ${percent(r.confidence)}` : ""}
            </span>
            <span className="faint" style={{ fontSize: 12 }}>
              {r.fetched_at ? `read ${readAge(r.fetched_at)}` : ""}
            </span>
          </div>
          {r.summary && <p className="dim" style={{ margin: 0, fontSize: 13 }}>{r.summary}</p>}
          <div className="row" style={{ justifyContent: "flex-start", gap: 12 }}>
            <button className="link-btn" aria-expanded={open === r.symbol} onClick={() => setOpen(open === r.symbol ? null : r.symbol)}>
              {open === r.symbol ? "Hide analysis" : "Full analysis"}
            </button>
            <Link to={fullTradeLink(r.symbol)}>Chart</Link>
          </div>
          {open === r.symbol && <AnalysisPanel symbol={r.symbol} auto />}
        </div>
      ))}
    </div>
  );
}
