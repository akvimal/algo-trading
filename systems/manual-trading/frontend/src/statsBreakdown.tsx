// Shared by ManualStatsPage (Performance) and DisciplinePage - both slice
// the same closed-trade shape into win-rate/PnL/R buckets along different
// dimensions (setup tag, symbol, entry hour, trend-followed, risk-managed).
// Extracted out of ManualStatsPage.tsx 2026-09-05 when the Discipline
// breakdowns moved to their own page - see docs/architecture.md.

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function pnlClass(n: number): string {
  return n > 0 ? "pnl-positive" : n < 0 ? "pnl-negative" : "";
}

export type BreakdownTrade = {
  pnl: number | null;
  entry_price: number | null;
  stop_loss_price: number | null;
  quantity: number | null;
};

export type Bucket = { key: string; trades: number; wins: number; losses: number; pnl: number; rSum: number; rCount: number };

export function breakdown<T extends BreakdownTrade>(trades: T[], keyFn: (t: T) => string | null): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const t of trades) {
    if (t.pnl == null) continue;
    const k = keyFn(t);
    if (k == null) continue;
    const b = m.get(k) ?? { key: k, trades: 0, wins: 0, losses: 0, pnl: 0, rSum: 0, rCount: 0 };
    b.trades += 1;
    b.pnl += t.pnl;
    if (t.pnl > 0) b.wins += 1;
    else if (t.pnl < 0) b.losses += 1;
    if (t.entry_price != null && t.stop_loss_price != null && t.quantity != null && t.entry_price !== t.stop_loss_price) {
      const risk = Math.abs(t.entry_price - t.stop_loss_price) * t.quantity;
      if (risk > 0) {
        b.rSum += t.pnl / risk;
        b.rCount += 1;
      }
    }
    m.set(k, b);
  }
  return [...m.values()];
}

export function BreakdownTable({
  title,
  header,
  rows,
  titleExtra,
}: {
  title: string;
  header: string;
  rows: Bucket[];
  // Optional link/badge appended after the title - used by "By setup" to
  // point at the Setup Field Guide without every other breakdown needing it.
  titleExtra?: import("react").ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="manual-settings-section">
      <h4>
        {title}
        {titleExtra}
      </h4>
      <div className="manual-stats-table-wrap">
        <table className="manual-stats-table">
          <thead>
            <tr>
              <th>{header}</th>
              <th>Trades</th>
              <th>Win rate</th>
              <th>PnL</th>
              <th>Avg PnL</th>
              <th>Avg R</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key}>
                <td>{b.key}</td>
                <td>{b.trades}</td>
                <td>{fmt((b.wins / b.trades) * 100, 0)}%</td>
                <td className={pnlClass(b.pnl)}>{fmt(b.pnl)}</td>
                <td className={pnlClass(b.pnl / b.trades)}>{fmt(b.pnl / b.trades)}</td>
                <td className={b.rCount > 0 ? pnlClass(b.rSum / b.rCount) : ""}>
                  {b.rCount > 0 ? `${b.rSum / b.rCount >= 0 ? "+" : ""}${fmt(b.rSum / b.rCount)}R` : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
