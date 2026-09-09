import { useEffect, useMemo, useState } from "react";

import { type Segment, fetchExecPositions, fetchOptionGroups } from "./api";
import { computeDisciplineScore, DISCIPLINE_WEIGHTS, disciplineColor } from "./discipline";
import { breakdown, BreakdownTable } from "./statsBreakdown";

// The overall discipline score + supporting breakdowns. Redesigned
// 2026-09-09 around the plan (Limit + stop, stick to it, review it,
// win) - see discipline.ts and docs/architecture.md § "Discipline score".

const WINDOW_OPTIONS = [7, 14, 30, 60, 90];
const WINDOW_STORAGE_KEY = "manualDisciplineWindowDays";

// The full trade shape the score (discipline.ts) and the breakdown tables
// (statsBreakdown.tsx) both need.
type Trade = {
  id: string;
  segment: Segment;
  symbol: string;
  pnl: number | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  target_price: number | null;
  quantity: number | null;
  exit_time: string;
  exit_reason: string | null;
  order_type: "market" | "limit" | null;
  entry_setup_tag: string | null;
  entry_confidence: number | null;
  setup_tag: string | null;
  confidence: number | null;
  reviewed: boolean;
  auto_traded: boolean;
};

function fmtPct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function loadWindowDays(): number {
  const raw = Number(localStorage.getItem(WINDOW_STORAGE_KEY));
  return WINDOW_OPTIONS.includes(raw) ? raw : 30;
}

function ScoreGauge({ score }: { score: number | null }) {
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = disciplineColor(score);
  return (
    <svg viewBox="0 0 108 108" className={`discipline-gauge is-${color}`} width="116" height="116">
      <circle cx="54" cy="54" r={r} className="discipline-gauge-track" strokeWidth="9" fill="none" />
      <circle
        cx="54"
        cy="54"
        r={r}
        className="discipline-gauge-fill"
        strokeWidth="9"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct)}
        strokeLinecap="round"
        transform="rotate(-90 54 54)"
      />
      <text x="54" y="50" textAnchor="middle" className="discipline-gauge-number">
        {score ?? "—"}
      </text>
      <text x="54" y="68" textAnchor="middle" className="discipline-gauge-label">
        {score == null ? "n/a" : "/ 100"}
      </text>
    </svg>
  );
}

function StatCard({
  label,
  rate,
  trades,
  weight,
  detail,
}: {
  label: string;
  rate: number | null;
  trades: number;
  weight: number;
  detail?: string;
}) {
  const pct = rate == null ? 0 : Math.round(rate * 100);
  const color = disciplineColor(rate == null ? null : pct);
  return (
    <div className={`discipline-card is-${color}`}>
      <span className="discipline-card-label">
        {label}
        {weight > 1 && <span className="discipline-card-weight" title={`Counts ${weight}× in the overall score`}>{weight}×</span>}
      </span>
      <span className="discipline-card-value">{fmtPct(rate)}</span>
      <div className="discipline-bar-track">
        <div className="discipline-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="discipline-card-detail muted">
        {trades === 0 ? "no tracked trades" : detail ? detail : `${trades} trade${trades === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}

export default function DisciplinePage() {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [windowDays, setWindowDays] = useState<number>(loadWindowDays);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    localStorage.setItem(WINDOW_STORAGE_KEY, String(windowDays));
  }, [windowDays]);

  async function refresh() {
    try {
      const [positions, groups] = await Promise.all([
        fetchExecPositions({ status: "CLOSED", manualOnly: true, limit: 1000 }),
        fetchOptionGroups({ status: "CLOSED", manualOnly: true, limit: 1000 }),
      ]);
      const reviewed = (reviewed_at: string | null, notes: string | null) =>
        reviewed_at != null || (notes != null && notes.trim().length > 0);
      const fromPositions: Trade[] = positions
        .filter((p) => p.option_group_id == null && p.exit_time != null)
        .map((p) => ({
          id: p.id,
          segment: p.segment,
          symbol: p.symbol,
          pnl: p.pnl,
          entry_price: p.entry_price,
          stop_loss_price: p.stop_loss_price,
          target_price: p.target_price,
          quantity: p.quantity,
          exit_time: p.exit_time!,
          exit_reason: p.exit_reason,
          order_type: p.order_type,
          entry_setup_tag: p.entry_setup_tag,
          entry_confidence: p.entry_confidence,
          setup_tag: p.setup_tag,
          confidence: p.confidence,
          reviewed: reviewed(p.reviewed_at, p.notes),
          auto_traded: p.auto_traded,
        }));
      const fromGroups: Trade[] = groups
        .filter((g) => g.exit_time != null)
        .map((g) => ({
          id: g.id,
          segment: g.segment,
          symbol: g.underlying_symbol,
          pnl: g.pnl,
          entry_price: null,
          stop_loss_price: g.spot_stop_loss_price,
          target_price: g.spot_target_price,
          quantity: g.quantity,
          exit_time: g.exit_time!,
          exit_reason: g.exit_reason,
          order_type: g.order_type,
          entry_setup_tag: g.entry_setup_tag,
          entry_confidence: g.entry_confidence,
          setup_tag: g.setup_tag,
          confidence: g.confidence,
          reviewed: reviewed(g.reviewed_at, g.notes),
          auto_traded: g.auto_traded,
        }));
      setTrades([...fromPositions, ...fromGroups]);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const result = useMemo(() => computeDisciplineScore(trades ?? [], [], windowDays), [trades, windowDays]);

  // Same window the score used - every table below reads this slice, so
  // nothing on the page can disagree with the number at the top.
  // Auto-traded fills are excluded (they're not discretionary decisions).
  const windowed = useMemo(() => {
    if (!trades || !result.windowStart) return [];
    return trades.filter(
      (t) => !t.auto_traded && new Date(t.exit_time).toLocaleDateString("en-CA") >= result.windowStart!,
    );
  }, [trades, result.windowStart]);

  const hasPlan = (t: Trade) => t.order_type === "limit" && t.stop_loss_price != null;

  // The 4 components broken out per segment.
  const bySegment = useMemo(() => {
    const segments = [...new Set(windowed.map((t) => t.segment))] as Segment[];
    return segments
      .map((seg) => {
        const ts = windowed.filter((t) => t.segment === seg);
        const withPnl = ts.filter((t) => t.pnl != null);
        const mean = (vals: number[]) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null);
        return {
          segment: seg,
          trades: ts.length,
          pnl: withPnl.reduce((s, t) => s + (t.pnl ?? 0), 0),
          winRate: withPnl.length > 0 ? withPnl.filter((t) => (t.pnl as number) > 0).length / withPnl.length : null,
          plannedRate: mean(ts.map((t) => (hasPlan(t) ? 1 : 0))),
          adherenceRate: mean(ts.map((t) => (!hasPlan(t) ? 0 : t.exit_reason === "manual" ? 0.4 : 1))),
          reviewRate: mean(
            ts.map(
              (t) =>
                0.5 * (t.entry_setup_tag && t.entry_confidence != null ? 1 : 0) +
                0.5 * (t.reviewed && t.setup_tag && t.confidence != null ? 1 : 0),
            ),
          ),
        };
      })
      .sort((a, b) => b.trades - a.trades);
  }, [windowed]);

  if (trades === null) {
    return (
      <div className="manual-wide-page">
        <div className="manual-page-header">
          <h3>Discipline</h3>
        </div>
        {error ? <p className="error">Could not reach the backend: {error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="manual-wide-page">
      <div className="manual-page-header">
        <h3>Discipline</h3>
        <label className="discipline-window-picker">
          Window
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
            {WINDOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                last {d} active days
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted discipline-intro">
        Scores four habits, not outcomes alone: place a <b>Limit order with a stop</b>, <b>stick to it</b> (let the stop /
        target / square-off decide, don't bail), <b>declare the setup + confidence before and review after</b>, and{" "}
        <b>win</b>. Averaged over the last {windowDays} days you placed at least one discretionary trade
        {result.windowStart && ` (since ${result.windowStart})`}. Auto-trader fills don't count.
      </p>

      <section className="discipline-hero">
        <ScoreGauge score={result.score} />
        <div className="discipline-cards">
          <StatCard
            label="Planned"
            rate={result.planned.rate}
            trades={result.planned.trades}
            weight={DISCIPLINE_WEIGHTS.planned}
            detail="Limit order + a stop"
          />
          <StatCard
            label="Stuck to plan"
            rate={result.planAdherence.rate}
            trades={result.planAdherence.trades}
            weight={DISCIPLINE_WEIGHTS.planAdherence}
            detail="no plan = 0 · bailed early = 40%"
          />
          <StatCard
            label="Review (before + after)"
            rate={result.planReview.rate}
            trades={result.planReview.trades}
            weight={DISCIPLINE_WEIGHTS.planReview}
            detail={
              result.planReview.beforeRate != null
                ? `${fmtPct(result.planReview.beforeRate)} before · ${fmtPct(result.planReview.afterRate)} after`
                : undefined
            }
          />
          <StatCard
            label="Winning"
            rate={result.outcome.rate}
            trades={result.outcome.trades}
            weight={DISCIPLINE_WEIGHTS.outcome}
            detail={
              result.outcome.winRate != null
                ? `${fmtPct(result.outcome.winRate)} win${result.outcome.avgR != null ? ` · ${result.outcome.avgR >= 0 ? "+" : ""}${result.outcome.avgR.toFixed(2)}R avg` : ""}`
                : undefined
            }
          />
        </div>
      </section>

      <div className="stats-grid">
        {bySegment.length > 0 && (
          <section className="manual-settings-section">
            <h4>By segment</h4>
            <div className="manual-stats-table-wrap">
              <table className="manual-stats-table">
                <thead>
                  <tr>
                    <th>Segment</th>
                    <th>Trades</th>
                    <th>Planned</th>
                    <th>Stuck to plan</th>
                    <th>Review</th>
                    <th>Win rate</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {bySegment.map((s) => (
                    <tr key={s.segment}>
                      <td>{s.segment}</td>
                      <td>{s.trades}</td>
                      <td>{fmtPct(s.plannedRate)}</td>
                      <td>{fmtPct(s.adherenceRate)}</td>
                      <td>{fmtPct(s.reviewRate)}</td>
                      <td>{fmtPct(s.winRate)}</td>
                      <td className={s.pnl >= 0 ? "pnl-positive" : "pnl-negative"}>{s.pnl.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <BreakdownTable
          title="By order type"
          header="Entry"
          rows={breakdown(windowed, (t) =>
            t.order_type == null ? null : t.order_type === "limit" ? "Limit" : "Market",
          ).sort((a, b) => b.pnl - a.pnl)}
        />
        <BreakdownTable
          title="Plan adherence"
          header="Plan"
          rows={breakdown(windowed, (t) => {
            if (!hasPlan(t)) return "No plan (market / no stop)";
            return t.exit_reason === "manual" ? "Bailed manually" : "Let the plan run";
          }).sort((a, b) => b.pnl - a.pnl)}
        />
        <BreakdownTable
          title="Plan review"
          header="Journal"
          rows={breakdown(windowed, (t) => {
            const before = !!t.entry_setup_tag && t.entry_confidence != null;
            const after = t.reviewed && !!t.setup_tag && t.confidence != null;
            if (before && after) return "Before + after";
            if (before) return "Before only";
            if (after) return "After only";
            return "Neither";
          }).sort((a, b) => b.pnl - a.pnl)}
        />
      </div>
    </div>
  );
}
