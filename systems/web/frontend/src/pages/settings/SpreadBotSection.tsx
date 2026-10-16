import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/http";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import type { OptionGroup } from "../../api/types";
import { Signed } from "../../components/bits";
import { formatDay, formatPct, formatPnl, formatTime } from "../../format";
import { useResource } from "../../hooks/useResource";

type BotSettings = { enabled: boolean; risk_pct: number; symbols: string[]; entry_from: string; entry_to: string; min_votes: number; width_strikes: number; max_trades_per_day: number; strategy_mode: "credit_spread" | "auto"; daily_loss_pct: number };
type Decision = { id: number; symbol: string; decided_at: string; outcome: "entered" | "skipped" | "failed"; reason: string; votes: Record<string, number> | null; group_id: string | null; detail?: { status?: boolean } | null };

type Kind = "all" | "entered" | "skipped" | "failed" | "status";
// "skipped" is the real evaluations that ended without a trade; the 5-minute holding / outside-window / limit-reached rows are "status".
const KINDS: Record<Kind, { label: string; query: string }> = {
  all: { label: "All", query: "" },
  entered: { label: "Entered", query: "&outcome=entered" },
  skipped: { label: "Skipped", query: "&outcome=skipped&status=false" },
  failed: { label: "Failed", query: "&outcome=failed" },
  status: { label: "Status checks", query: "&status=true" },
};
const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const shiftDay = (day: string, by: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

const READ_LABEL: Record<string, string> = { trend: "Trend", oi: "OI", structure: "Structure", premarket: "Pre-market" };
const lean = (v: number) => (v > 0 ? "bullish" : v < 0 ? "bearish" : "no lean");

/** The intraday credit-spread bot: paper only, off until switched on. Every decision it makes is listed with the four reads behind it. */
export function SpreadBotSection() {
  const settings = useResource(() => api<BotSettings>("execution", "/spread-bot/settings"), []);
  const [day, setDay] = useState(todayIst);
  const [kind, setKind] = useState<Kind>("all");
  const decisions = useResource(() => api<Decision[]>("execution", `/spread-bot/decisions?limit=1000&day=${day}${KINDS[kind].query}`), [day, kind], { pollMs: day === todayIst() ? 60_000 : undefined });
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
              your practice balance. One spread at a time. It never trades a live account. It does not exit on a new signal. A credit spread ends when the underlying
              reaches the short strike, it loses half its max loss, it earns 70% of its credit, or the NSE square-off time arrives; a bought option or debit spread, when it loses 40% of its cost,
              gains 60%, or at square-off.
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
        <label className="field">
          Which strategy
          <select value={draft.strategy_mode} onChange={(e) => set("strategy_mode", e.target.value as BotSettings["strategy_mode"])}>
            <option value="credit_spread">Always sell the credit spread</option>
            <option value="auto">Choose for me (buy the move on a strong trend)</option>
          </select>
          <span className="faint" style={{ fontSize: 12 }}>
            {draft.strategy_mode === "auto"
              ? "On a strong trend the reads agree with (ADX 25+), it buys an at-the-money option instead - or a debit spread when volatility is high. Stopped out after losing 40% of what it cost, targets 60% more. Everything else still sells the credit spread."
              : "Whatever the direction, it sells the spread on the open-interest wall."}
          </span>
        </label>
        <div className="field-row">
          <label className="field">
            Max loss per spread (% of balance)
            <input type="number" min={0.1} max={5} step={0.1} value={draft.risk_pct} onChange={(e) => set("risk_pct", Number(e.target.value))} />
          </label>
          <label className="field">
            Reads that must agree (of 4)
            <input type="number" min={2} max={4} value={draft.min_votes} onChange={(e) => set("min_votes", Number(e.target.value))} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            Enter from
            <input type="text" inputMode="text" value={draft.entry_from} onChange={(e) => set("entry_from", e.target.value)} />
          </label>
          <label className="field">
            Enter until
            <input type="text" inputMode="text" value={draft.entry_to} onChange={(e) => set("entry_to", e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            Strikes between the two legs
            <input type="number" min={1} max={10} value={draft.width_strikes} onChange={(e) => set("width_strikes", Number(e.target.value))} />
          </label>
          <label className="field">
            Most trades a day
            <input type="number" min={1} max={10} value={draft.max_trades_per_day} onChange={(e) => set("max_trades_per_day", Number(e.target.value))} />
          </label>
        </div>
        <label className="field">
          Stop for the day after losing (% of balance)
          <input type="number" min={0.5} max={20} step={0.5} value={draft.daily_loss_pct} onChange={(e) => set("daily_loss_pct", Number(e.target.value))} />
          <span className="faint" style={{ fontSize: 12 }}>
            Counts the bot's own closed trades today. Once they are down this much it takes no more entries until tomorrow; a spread already open still ends on its own stop, target or square-off.
          </span>
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

      <BotResults />

      <h2 className="section-title">What it has decided</h2>
      <div className="chips" role="group" aria-label="Show">
        {(Object.keys(KINDS) as Kind[]).map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {KINDS[k].label}
          </button>
        ))}
      </div>
      <div className="field-row" style={{ alignItems: "center" }}>
        <button className="btn" aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>
          ‹
        </button>
        <input type="date" aria-label="Day" value={day} max={todayIst()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <button className="btn" aria-label="Next day" disabled={day >= todayIst()} onClick={() => setDay(shiftDay(day, 1))}>
          ›
        </button>
        {day !== todayIst() && (
          <button className="btn" onClick={() => setDay(todayIst())}>
            Today
          </button>
        )}
        {decisions.data && <span className="faint">{decisions.data.length} shown</span>}
      </div>
      {decisions.loading && <Skeleton lines={3} />}
      {decisions.data && decisions.data.length === 0 && <Empty title="Nothing here">No {KINDS[kind].label === "All" ? "decisions" : KINDS[kind].label.toLowerCase()} on {day}. Once the bot is on and the market is open, every cycle is listed, entered or not, with why.</Empty>}
      {decisions.data && decisions.data.length > 0 && (
        <div className="card" data-testid="bot-decisions">
          {decisions.data.map((d) => (
            <div className="list-row" key={d.id}>
              <span>
                <strong>{d.symbol}</strong> <span className={`pill ${d.outcome === "entered" ? "up" : d.outcome === "failed" ? "dn" : ""}`}>{d.detail?.status ? "status" : d.outcome}</span>
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

const isBot = (g: OptionGroup) => g.setup_tag === "spread-bot";
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** How the bot has done: today and all time, the spread it has open now, and each closed trade with why it ended. Read from its own tagged trades. */
function BotResults() {
  const open = useResource(() => api<OptionGroup[]>("execution", "/option-groups?status=OPEN&with_live_pnl=true&limit=200"), [], { pollMs: 30_000 });
  const closed = useResource(() => api<OptionGroup[]>("execution", "/option-groups?status=CLOSED&limit=500"), [], { pollMs: 60_000 });
  // The entry decision behind each trade (its reads and reason), looked up by the trade it opened.
  const entries = useResource(() => api<Decision[]>("execution", "/spread-bot/decisions?outcome=entered&limit=200"), [], { pollMs: 60_000 });
  if (open.loading || closed.loading) return <Skeleton lines={3} />;
  const entryOf = (g: OptionGroup) => (entries.data ?? []).find((d) => d.group_id === g.id);
  const criteria = (g: OptionGroup) => {
    const d = entryOf(g);
    if (!d) return g.notes ?? null;
    const reads = d.votes ? Object.entries(d.votes).map(([k, v]) => `${READ_LABEL[k] ?? k}: ${lean(v)}`).join(" · ") : "";
    return `${d.reason}${reads ? ` (${reads})` : ""}`;
  };
  const openBot = (open.data ?? []).filter(isBot);
  const done = (closed.data ?? []).filter(isBot);
  const today = dayKey(new Date().toISOString());
  const pnlOf = (g: OptionGroup) => g.pnl ?? 0;
  const total = done.reduce((a, g) => a + pnlOf(g), 0);
  const todays = done.filter((g) => g.exit_time && dayKey(g.exit_time) === today).reduce((a, g) => a + pnlOf(g), 0);
  const openPnl = openBot.reduce((a, g) => a + (g.unrealized_pnl ?? 0), 0);
  const wins = done.filter((g) => pnlOf(g) > 0).length;
  return (
    <>
      <h2 className="section-title">How it is doing</h2>
      {openBot.length + done.length === 0 ? (
        <Empty title="No trades yet">When the bot enters a spread it is counted here.</Empty>
      ) : (
        <div className="card stack" data-testid="bot-results">
          <div className="field-row" style={{ marginBottom: 0 }}>
            <span>
              Today <Signed value={todays + openPnl} text={formatPnl(todays + openPnl)} />
            </span>
            <span>
              All time <Signed value={total + openPnl} text={formatPnl(total + openPnl)} />
            </span>
            <span>
              Win rate {done.length ? formatPct((wins / done.length) * 100, 0) : "–"} <span className="faint">({done.length} closed)</span>
            </span>
          </div>
          {openBot.map((g) => (
            <div className="list-row" key={g.id}>
              <span>
                <strong>{g.underlying_symbol}</strong> <span className="pill">open</span>
                <span className="faint" style={{ display: "block", fontSize: 12 }}>
                  {g.strategy_type.replace(/_/g, " ")} · {g.quantity} · entered {formatDay(g.entry_time)} {formatTime(g.entry_time)}
                </span>
                {criteria(g) && <span className="faint" style={{ display: "block", fontSize: 12 }}>Why: {criteria(g)}</span>}
              </span>
              <Signed value={g.unrealized_pnl ?? null} text={g.unrealized_pnl == null ? "–" : formatPnl(g.unrealized_pnl)} />
            </div>
          ))}
          {done.slice(0, 15).map((g) => (
            <div className="list-row" key={g.id}>
              <span>
                <strong>{g.underlying_symbol}</strong> <span className="faint">{g.strategy_type.replace(/_/g, " ")}</span>
                <span className="faint" style={{ display: "block", fontSize: 12 }}>
                  Entered {formatDay(g.entry_time)} {formatTime(g.entry_time)} · exited {g.exit_time ? `${formatDay(g.exit_time)} ${formatTime(g.exit_time)}` : "–"} · ended by {(g.exit_reason ?? "unknown").replace(/_/g, " ")}
                </span>
                {criteria(g) && <span className="faint" style={{ display: "block", fontSize: 12 }}>Why: {criteria(g)}</span>}
              </span>
              <Signed value={g.pnl ?? null} text={g.pnl == null ? "–" : formatPnl(g.pnl)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
