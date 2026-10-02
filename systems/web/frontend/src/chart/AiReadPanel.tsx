import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getAiRead } from "../api/trade";
import { ApiError } from "../api/http";
import type { AiRead } from "../api/types";
import { formatPrice } from "../format";
import { isStaleRead, loadAiRead, saveAiRead } from "./aiReadStore";

const hhmm = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const TONE = { bullish: "up", bearish: "dn", neutral: "warn" } as const;

type State = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; read: AiRead };

/** An on-demand model read of what the OI strip shows plus price, regime, India VIX, news and the macro
 * calendar. Costs the person's own OpenRouter credit, so it only ever runs on a click — never on a timer.
 * A finished read stays on screen until they ask again, and is saved in the browser so a page reload (or
 * coming back to the instrument later today) brings it back, flagged "old" once it is 30+ minutes behind. */
/** What the rest of the screen can ask of the AI read: do what its own button would do now (run one, or show/hide the
 * read that is there). The rail's AI read button uses it, so the read does not depend on the OI strip being on screen. */
export type AiReadHandle = { activate: () => void };

/** `expiry` is only passed to the model's context when the page knows it (the option chain is loaded); without it the
 * server picks the nearest. A read is saved per instrument, not per expiry. */
export const AiReadButton = forwardRef<AiReadHandle, { exchange: string; symbol: string; expiry?: string }>(function AiReadButton({ exchange, symbol, expiry }, ref) {
  const key = `${exchange}:${symbol}`;
  const restore = (): State => {
    const saved = loadAiRead(key);
    return saved ? { status: "done", read: saved } : { status: "idle" };
  };
  const [state, setState] = useState<State>(restore);
  // A read that was saved earlier waits collapsed ("Show AI read") when the chart loads; one the person has just asked for opens.
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const firstKey = useRef(key);

  // A different instrument/expiry makes the previous read about something else - swap to whatever was saved
  // for the new one (or nothing), and ignore any answer still in flight for the old one.
  useEffect(() => {
    if (firstKey.current === key) return; // the initial state already restored this key
    firstKey.current = key;
    request.current += 1;
    setState(restore());
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const run = () => {
    const id = ++request.current;
    setState({ status: "loading" });
    setOpen(true);
    getAiRead(exchange, symbol, expiry)
      .then((read) => {
        if (id !== request.current) return;
        saveAiRead(key, read);
        setState({ status: "done", read });
      })
      .catch((e: unknown) => id === request.current && setState({ status: "error", message: e instanceof ApiError ? e.message : "Could not get an AI read." }));
  };

  const loading = state.status === "loading";
  const click = state.status === "done" && open ? () => setOpen(false) : state.status === "done" ? () => setOpen(true) : run;
  useImperativeHandle(ref, () => ({ activate: () => (loading ? undefined : click()) }));
  return (
    <>
      <button className="chip-btn ai-read-btn" onClick={click} disabled={loading} data-testid="ai-read-btn">
        {loading ? "Reading…" : state.status === "done" ? (open ? "✦ Hide AI read" : "✦ Show AI read") : "✦ AI read"}
      </button>
      {state.status === "error" && (
        <div className="ai-read" role="alert" data-testid="ai-read-error">
          <span className="error-text">{state.message}</span> <button className="chip-btn" onClick={run}>Retry</button>
        </div>
      )}
      {state.status === "done" && open && <AiReadBody read={state.read} onRefresh={run} />}
    </>
  );
});

function AiReadBody({ read, onRefresh }: { read: AiRead; onRefresh: () => void }) {
  return (
    <div className="ai-read" data-testid="ai-read">
      <div className="ai-read-head">
        <span className={`pill ${TONE[read.bias]}`} data-testid="ai-read-bias">
          {read.bias} · {read.confidence}%
        </span>
        <b className="ai-read-line">{read.one_liner}</b>
        <span className={`ai-read-meta ${isStaleRead(read) ? "warn-text" : "faint"}`} title={`Model ${read.model}`}>
          {read.model} · {hhmm(read.generated_at)}
          {isStaleRead(read) ? " · old, refresh for a current read" : ""}
        </span>
        <button className="chip-btn" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <ul className="ai-read-list">
        {read.reasoning.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <div className="ai-read-levels">
        {read.resistance.length > 0 && (
          <span>
            R <b className="dn">{read.resistance.map((p) => formatPrice(p)).join(" · ")}</b>
          </span>
        )}
        {read.support.length > 0 && (
          <span>
            S <b className="up">{read.support.map((p) => formatPrice(p)).join(" · ")}</b>
          </span>
        )}
        {read.wait_for && (
          <span>
            Wait for: <b>{read.wait_for}</b>
          </span>
        )}
      </div>
      {read.risks.length > 0 && (
        <div className="ai-read-risks">
          <span className="faint">Risks</span>
          <ul className="ai-read-list">
            {read.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="faint ai-read-foot">
        {read.data_gaps.length > 0 && <>Not provided to the model: {read.data_gaps.join(", ")}. </>}
        An AI reading of this data, not financial advice.
      </div>
    </div>
  );
}
