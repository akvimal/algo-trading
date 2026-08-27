import { useEffect, useState } from "react";

import { type ManualOptionGroup, type ManualPosition, type Segment, fetchExecPositions, fetchOptionGroups } from "./api";

const POLL_INTERVAL_MS = 5000;

function fmt(n: number, locale = "en-IN"): string {
  const hasFraction = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString(locale, hasFraction ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 });
}

type OpenRow = {
  key: string;
  symbol: string;
  segment: Segment;
  action: "BUY" | "SELL";
  quantity: number | null;
  entryPrice: number;
  livePrice: number | null;
  unrealizedPnl: number | null;
};

// Intraday > Dashboard - an overview, no order entry (that's Workspace's
// job) and no session/checklist status either (dropped at the user's
// explicit request - check-in already lives on Workspace, right where
// trades actually get placed, and its own status there was redundant
// here - see docs/architecture.md § "Manual Trading SaaS"). Just open
// positions/live P&L.
export default function DashboardPage() {
  const [openRows, setOpenRows] = useState<OpenRow[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);

  async function refreshOpenPositions() {
    try {
      const [positions, groups] = await Promise.all([
        fetchExecPositions({ status: "OPEN", withLivePnl: true, manualOnly: true }),
        fetchOptionGroups({ status: "OPEN", withLivePnl: true, manualOnly: true }),
      ]);
      const posRows: OpenRow[] = (positions as ManualPosition[]).map((p) => ({
        key: `pos-${p.id}`,
        symbol: p.symbol,
        segment: p.segment,
        action: p.action,
        quantity: p.quantity,
        entryPrice: p.entry_price,
        livePrice: p.live_price,
        unrealizedPnl: p.unrealized_pnl,
      }));
      const groupRows: OpenRow[] = (groups as ManualOptionGroup[]).map((g) => ({
        key: `grp-${g.id}`,
        symbol: g.underlying_symbol,
        segment: g.segment,
        action: g.action,
        quantity: g.quantity,
        entryPrice: g.net_debit ?? 0,
        livePrice: g.live_combined_price,
        unrealizedPnl: g.unrealized_pnl,
      }));
      setOpenRows([...posRows, ...groupRows]);
      setOpenError(null);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "Failed to load open positions");
    }
  }

  useEffect(() => {
    void refreshOpenPositions();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      void refreshOpenPositions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const totalUnrealized = openRows.reduce((sum, r) => sum + (r.unrealizedPnl ?? 0), 0);

  return (
    <div className="manual-settings-page">
      <div className="manual-page-header">
        <h3>Dashboard</h3>
      </div>

      <section className="manual-settings-section">
        <h4>Open positions</h4>
        {openError && <p className="error">{openError}</p>}
        <p className="subtitle">
          {openRows.length} open · Unrealized P&amp;L{" "}
          <strong className={totalUnrealized >= 0 ? "pnl-positive" : "pnl-negative"}>{fmt(totalUnrealized)}</strong>
        </p>
        {openRows.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Segment</th>
                  <th>Action</th>
                  <th>Qty</th>
                  <th>Entry</th>
                  <th>Live</th>
                  <th>Unrealized P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {openRows.map((r) => (
                  <tr key={r.key}>
                    <td className="symbol">{r.symbol}</td>
                    <td>{r.segment}</td>
                    <td>{r.action}</td>
                    <td className="num">{r.quantity ?? "-"}</td>
                    <td className="num">{fmt(r.entryPrice, r.segment === "CRYPTO" ? "en-US" : "en-IN")}</td>
                    <td className="num">{r.livePrice != null ? fmt(r.livePrice, r.segment === "CRYPTO" ? "en-US" : "en-IN") : "-"}</td>
                    <td className={`num ${r.unrealizedPnl != null ? (r.unrealizedPnl >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}>
                      {r.unrealizedPnl != null ? fmt(r.unrealizedPnl, r.segment === "CRYPTO" ? "en-US" : "en-IN") : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
