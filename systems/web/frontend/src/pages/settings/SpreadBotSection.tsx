import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/http";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { formatDay, formatTime } from "../../format";
import { useResource } from "../../hooks/useResource";

type BotSettings = { enabled: boolean; risk_pct: number; symbols: string[]; entry_from: string; entry_to: string; min_votes: number; width_strikes: number; max_trades_per_day: number };
type Decision = { id: number; symbol: string; decided_at: string; outcome: "entered" | "skipped" | "failed"; reason: string; votes: Record<string, number> | null; group_id: string | null };

const READ_LABEL: Record<string, string> = { trend: "Trend", oi: "OI", structure: "Structure", premarket: "Pre-market" };
const lean = (v: number) => (v > 0 ? "bullish" : v < 0 ? "bearish" : "no lean");

/** The intraday credit-spread bot: paper only, off until switched on. Every decision it makes is listed with the four reads behind it. */
export function SpreadBotSection() {
  const settings = useResource(() => api<BotSettings>("execution", "/spread-bot/settings"), []);
  const decisions = useResource(() => api<Decision[]>("execution", "/spread-bot/decisions?limit=40"), [], { pollMs: 60_000 });
  const [draft, setDraft] = useState<BotSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  if (settings.loading) return <Skeleton lines={5} />;
  if (settings.error && !settings.data) return <ErrorNotice error={settings.error} onRetry={settings.reload} />;
  if (!draft) return null;
  const set = <K extends keyof BotSettings>(k: K, v: BotSettings[K]) => setDraft({ ...draft, [k]: v });
  const toggleSymbol = (s: string) => set("symbols", draft.symbols.includes(s) ? draft.symbols.filter((x) => x !== s) : [...draft.symbols, s]);

  async function save(next: BotSettings) {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api<BotSettings>("execution", "/spread-bot/settings", { method: "PUT", json: next });
      setDraft(saved);
      setMessage("Saved.");
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <label className="check" htmlFor="bot-enabled" style={{ alignItems: "flex-start" }}>
          <input id="bot-enabled" type="checkbox" checked={draft.enabled} disabled={saving} onChange={(e) => void save({ ...draft, enabled: e.target.checked })} />
          <span>
            <strong style={{ color: "var(--text)" }}>Credit-spread bot (practice account only)</strong>
            <span className="faint" style={{ display: "block", fontSize: 13, marginTop: 2 }}>
              Every five minutes in the entry window it reads the trend, the OI shift, the market structure and the pre-market view. When at least {draft.min_votes} of the four lean the same way and none
              lean the other way, it sells a put spread (bullish) or a call spread (bearish) with the short strike on the biggest open-interest wall, sized so the most it can lose is {draft.risk_pct}% of
              your practice balance. One spread at a time. It never trades a live account.
            </span>
          </span>
        </label>
      </div>

      <div className="card stack" aria-label="Bot limits">
        <div className="chips" role="group" aria-label="Underlyings">
          {["NIFTY", "BANKNIFTY"].map((s) => (
            <button key={s} aria-pressed={draft.symbols.includes(s)} onClick={() => toggleSymbol(s)}>
              {s}
            </button>
          ))}
        </div>
        <label>
          Max loss per spread (% of balance)
          <input type="number" min={0.1} max={5} step={0.1} value={draft.risk_pct} onChange={(e) => set("risk_pct", Number(e.target.value))} />
        </label>
        <label>
          Enter from
          <input type="text" inputMode="text" value={draft.entry_from} onChange={(e) => set("entry_from", e.target.value)} />
        </label>
        <label>
          Enter until
          <input type="text" inputMode="text" value={draft.entry_to} onChange={(e) => set("entry_to", e.target.value)} />
        </label>
        <label>
          Reads that must agree (of 4)
          <input type="number" min={2} max={4} value={draft.min_votes} onChange={(e) => set("min_votes", Number(e.target.value))} />
        </label>
        <label>
          Strikes between the two legs
          <input type="number" min={1} max={10} value={draft.width_strikes} onChange={(e) => set("width_strikes", Number(e.target.value))} />
        </label>
        <label>
          Most trades a day
          <input type="number" min={1} max={10} value={draft.max_trades_per_day} onChange={(e) => set("max_trades_per_day", Number(e.target.value))} />
        </label>
        <div>
          <button className="btn" disabled={saving || draft.symbols.length === 0} onClick={() => void save(draft)}>
            Save limits
          </button>
          {message && (
            <span className="faint" role="status" style={{ marginLeft: 8 }}>
              {message}
            </span>
          )}
        </div>
      </div>

      <h2 className="section-title">What it has decided</h2>
      {decisions.loading && <Skeleton lines={3} />}
      {decisions.data && decisions.data.length === 0 && <Empty title="No decisions yet">Once it is on and the market is open, every cycle is listed here, entered or not, with why.</Empty>}
      {decisions.data && decisions.data.length > 0 && (
        <div className="card" data-testid="bot-decisions">
          {decisions.data.map((d) => (
            <div className="list-row" key={d.id}>
              <span>
                <strong>{d.symbol}</strong> <span className={`pill ${d.outcome === "entered" ? "up" : d.outcome === "failed" ? "dn" : ""}`}>{d.outcome}</span>
                <span className="faint" style={{ display: "block", fontSize: 12 }}>
                  {formatDay(d.decided_at)} {formatTime(d.decided_at)} · {d.reason}
                </span>
                {d.votes && (
                  <span className="faint" style={{ display: "block", fontSize: 12 }}>
                    {Object.entries(d.votes)
                      .map(([k, v]) => `${READ_LABEL[k] ?? k}: ${lean(v)}`)
                      .join(" · ")}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
