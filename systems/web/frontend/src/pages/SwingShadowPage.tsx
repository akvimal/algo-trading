import { useState } from "react";
import { api } from "../api/http";
import { Empty, ErrorNotice, Skeleton } from "../components/bits";
import { formatDay } from "../format";
import { useResource } from "../hooks/useResource";

type Criterion = { value: unknown; pass: boolean | null; source?: string };
type ShadowRow = {
  snapshot_date: string; symbol: string; direction: "LONG" | "SHORT"; taken: boolean; skip_reason: string | null; score: number | null; tier: string | null;
  criteria: Record<string, Criterion>; ref_close: number; stop_price: number; risk_pct: number | null;
  result: string | null; entry_price: number | null; exit_price: number | null; exit_day: number | null; r_multiple: number | null; mfe_r: number | null; mae_r: number | null;
};
type Shadow = { snapshot_date: string | null; rows: ShadowRow[] };
type Bucket = { n: number; resolved: number; wins: number; avg_r: number | null };
type Summary = { nights: number; first_night: string | null; last_night: string | null; taken: Bucket; skipped: Bucket; by_direction: Record<string, Bucket> };

type Show = "all" | "taken" | "skipped";
const SHOW: { id: Show; label: string }[] = [{ id: "all", label: "All" }, { id: "taken", label: "Would take" }, { id: "skipped", label: "Turned away" }];
const CRITERIA_ORDER = ["flow", "oi_surge", "trend", "weekly", "liquidity", "risk", "expiry", "market", "events"];
const CRITERIA_LABEL: Record<string, string> = {
  flow: "Option flow", oi_surge: "OI move", trend: "Trend", weekly: "Weekly", liquidity: "Liquidity", risk: "Stop distance", expiry: "Expiry", market: "Market", events: "Events",
};

const verdict = (c: Criterion | undefined) => (!c || c.pass == null ? "–" : c.pass ? "✓" : "✗");
const show = (v: unknown) => (v == null ? "n/a" : typeof v === "object" ? Object.entries(v as object).map(([k, x]) => `${k} ${x ?? "–"}`).join(", ") : String(v));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const shiftDay = (day: string, by: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

function Stat({ title, b }: { title: string; b: Bucket }) {
  return (
    <div>
      <div className="faint" style={{ fontSize: 12 }}>{title}</div>
      <strong>{b.n}</strong> <span className="faint">({b.resolved} settled{b.resolved ? `, ${b.wins} up, avg ${b.avg_r?.toFixed(2)}R` : ""})</span>
    </div>
  );
}

/** The shadow log of the 1-3 day open-interest swing idea: what a rule-following bot would have done each night, and what happened next. Nothing here trades. */
export function SwingShadowPage() {
  const [day, setDay] = useState<string | null>(null); // null = the latest night with rows
  const [decision, setDecision] = useState<Show>("all");
  const [open, setOpen] = useState<string | null>(null);
  const summary = useResource(() => api<Summary>("marketData", "/oi-swing/summary"), []);
  const shadow = useResource(() => api<Shadow>("marketData", `/oi-swing/shadow?decision=${decision}${day ? `&day=${day}` : ""}`), [day, decision]);
  const shown = day ?? shadow.data?.snapshot_date ?? today();

  return (
    <div className="stack">
      <h1>Swing shadow</h1>
      <p className="faint" style={{ margin: 0 }}>
        Each night, the stocks sitting at a demand or supply zone are checked against the open-interest swing rules (1-3 day hold, long or short). This page only records what a bot would have done and what happened next
        (entry next open, stop at the zone's far edge, target 1.5R, out at the third close). It places no orders.
      </p>

      {summary.data && (
        <div className="card" data-testid="shadow-summary">
          <div className="field-row" style={{ marginBottom: 0 }}>
            <Stat title="Would have taken" b={summary.data.taken} />
            <Stat title="Turned away (the control)" b={summary.data.skipped} />
            <div>
              <div className="faint" style={{ fontSize: 12 }}>Nights logged</div>
              <strong>{summary.data.nights}</strong>
            </div>
          </div>
          <p className="faint" style={{ fontSize: 12, margin: "8px 0 0" }}>
            Read the counts before the averages: a few weeks of nights is a small sample. The turned-away group is what the same stocks did anyway, so the rules only matter if "would take" beats it.
          </p>
        </div>
      )}

      <div className="chips" role="group" aria-label="Show">
        {SHOW.map((s) => (
          <button key={s.id} aria-pressed={decision === s.id} onClick={() => setDecision(s.id)}>{s.label}</button>
        ))}
      </div>
      <div className="field-row" style={{ alignItems: "center" }}>
        <button className="btn" aria-label="Previous night" onClick={() => setDay(shiftDay(shown, -1))}>‹</button>
        <input type="date" aria-label="Night" value={shown} max={today()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <button className="btn" aria-label="Next night" disabled={shown >= today()} onClick={() => setDay(shiftDay(shown, 1))}>›</button>
        {day && <button className="btn" onClick={() => setDay(null)}>Latest</button>}
      </div>

      {shadow.loading && <Skeleton lines={4} />}
      {shadow.error && !shadow.data && <ErrorNotice error={shadow.error} onRetry={shadow.reload} />}
      {shadow.data && shadow.data.rows.length === 0 && (
        <Empty title="Nothing logged for this night">It fills in after the nightly zone scan (about 17:45 IST). Nights the zone scan did not run have no rows.</Empty>
      )}
      {shadow.data && shadow.data.rows.length > 0 && (
        <div className="card" data-testid="shadow-rows">
          {shadow.data.rows.map((r) => {
            const key = `${r.snapshot_date}:${r.symbol}`;
            return (
              <div className="list-row" key={key} style={{ display: "block" }}>
                <button className="btn" style={{ width: "100%", textAlign: "left", background: "none", border: 0, padding: 0 }} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                  <strong>{r.symbol}</strong> <span className={`pill ${r.direction === "LONG" ? "up" : "dn"}`}>{r.direction}</span>{" "}
                  <span className={`pill ${r.taken ? "up" : ""}`}>{r.taken ? "would take" : "turned away"}</span>{r.tier && <span className="faint"> · tier {r.tier}</span>}
                  <span className="faint" style={{ display: "block", fontSize: 12 }}>
                    stop {r.stop_price} ({r.risk_pct}% away){r.skip_reason ? ` · ${r.skip_reason}` : ""}
                    {r.result ? ` · ${r.result}${r.result === "invalid" ? "" : ` on day ${r.exit_day}, ${r.r_multiple?.toFixed(2)}R (best ${r.mfe_r?.toFixed(2)}R, worst -${r.mae_r?.toFixed(2)}R)`}` : " · still running"}
                  </span>
                </button>
                {open === key && (
                  <div className="faint" style={{ fontSize: 12, marginTop: 6 }} data-testid={`criteria-${r.symbol}`}>
                    {CRITERIA_ORDER.filter((k) => r.criteria[k]).map((k) => (
                      <div key={k}>
                        {verdict(r.criteria[k])} <strong>{CRITERIA_LABEL[k] ?? k}</strong>: {show(r.criteria[k].value)}
                        {r.criteria[k].source === "price_proxy" && " (price-based; no option flow recorded that night)"}
                      </div>
                    ))}
                    <div>Decided {formatDay(r.snapshot_date)} at close {r.ref_close}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
