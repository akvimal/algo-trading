import { useEffect, useState } from "react";

import { fetchExecPositions, fetchOptionGroups } from "./api";

type ManualCalendarFilterProps = {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  defaultOpen?: boolean;
};

// Local-date grouping key (YYYY-MM-DD) - same convention ManualStatsPage's
// own dayKey/ManualTab.tsx's own dayKey use.
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function todayKey(): string {
  return dayKey(new Date().toISOString());
}

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

// Green/red tint scaled by how far a day's pnl sits from the largest
// magnitude day this month - not just a flat "profit/loss" 2-tone, so a
// -50 day and a -5000 day don't look the same. maxAbs is the largest
// |pnl| across the visible month, shared by every cell so the scale is
// consistent.
function dayBackground(pnl: number, maxAbs: number): string {
  if (pnl === 0 || maxAbs === 0) return "transparent";
  const intensity = Math.min(1, Math.abs(pnl) / maxAbs);
  const alpha = 0.12 + intensity * 0.45;
  return pnl > 0 ? `rgba(46, 204, 113, ${alpha})` : `rgba(232, 88, 106, ${alpha})`;
}

// Collapsible month calendar (defaults collapsed) - each day's background
// is tinted green/red by that day's realized manual-trade pnl, click a day
// to scope every card's own PnL summary to it (see ManualTab.tsx's own
// selectedDate/cardPnlSummary). Fetches its own closed-trade data
// independently of ManualStatsPage's identical fetch - both are small,
// infrequent, self-contained widgets, not worth threading shared state
// between for this.
export default function ManualCalendarFilter({ selectedDate, onSelectDate, defaultOpen = false }: ManualCalendarFilterProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [viewMonth, setViewMonth] = useState(() => {
    const [y, m] = todayKey().split("-").map(Number);
    return { year: y, month: m - 1 }; // month: 0-indexed, matches Date's own convention
  });
  const [pnlByDay, setPnlByDay] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!open) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function refresh() {
    try {
      const [positions, groups] = await Promise.all([
        fetchExecPositions({ status: "CLOSED", manualOnly: true, limit: 1000 }),
        fetchOptionGroups({ status: "CLOSED", manualOnly: true, limit: 1000 }),
      ]);
      const byDay: Record<string, number> = {};
      for (const p of positions) {
        if (p.option_group_id != null || p.exit_time == null || p.pnl == null) continue;
        const key = dayKey(p.exit_time);
        byDay[key] = (byDay[key] ?? 0) + p.pnl;
      }
      for (const g of groups) {
        if (g.exit_time == null || g.pnl == null) continue;
        const key = dayKey(g.exit_time);
        byDay[key] = (byDay[key] ?? 0) + g.pnl;
      }
      setPnlByDay(byDay);
    } catch {
      // leave whatever was last successfully fetched
    }
  }

  const { year, month } = viewMonth;
  const monthLabel = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => {
    const d = String(i + 1).padStart(2, "0");
    const m = String(month + 1).padStart(2, "0");
    return `${year}-${m}-${d}`;
  })];

  const monthKeys = cells.filter((c): c is string => c != null);
  const maxAbs = Math.max(0, ...monthKeys.map((k) => Math.abs(pnlByDay[k] ?? 0)));
  const tradedDays = monthKeys.filter((k) => k in pnlByDay);
  const profitableDays = tradedDays.filter((k) => (pnlByDay[k] ?? 0) > 0).length;
  const today = todayKey();

  return (
    <div className="manual-calendar">
      <button type="button" className="manual-calendar-toggle" onClick={() => setOpen((v) => !v)}>
        <span>{open ? "▾" : "▸"}</span>
        Date filter: {selectedDate === today ? "Today" : selectedDate}
      </button>
      {open && (
        <div className="manual-calendar-body">
          <div className="manual-calendar-nav">
            <button
              type="button"
              className="tiny secondary"
              onClick={() => setViewMonth((v) => (v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 }))}
            >
              ‹
            </button>
            <span className="manual-calendar-month-label">{monthLabel}</span>
            <button
              type="button"
              className="tiny secondary"
              onClick={() => setViewMonth((v) => (v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 }))}
            >
              ›
            </button>
            {selectedDate !== today && (
              <button type="button" className="tiny secondary" onClick={() => onSelectDate(today)}>
                Today
              </button>
            )}
          </div>
          <div className="manual-calendar-grid">
            {WEEKDAY_LABELS.map((w, i) => (
              <span className="manual-calendar-weekday" key={i}>
                {w}
              </span>
            ))}
            {cells.map((key, i) =>
              key == null ? (
                <span key={i} />
              ) : (
                <button
                  type="button"
                  key={key}
                  className={`manual-calendar-day ${key === selectedDate ? "selected" : ""} ${key === today ? "today" : ""}`}
                  style={{ background: dayBackground(pnlByDay[key] ?? 0, maxAbs) }}
                  title={key in pnlByDay ? `${key}: ${pnlByDay[key].toFixed(2)}` : key}
                  onClick={() => onSelectDate(key)}
                >
                  {Number(key.slice(-2))}
                </button>
              ),
            )}
          </div>
          {tradedDays.length > 0 && (
            <p className="muted manual-calendar-summary">
              {monthLabel}: {profitableDays}/{tradedDays.length} profitable days
            </p>
          )}
        </div>
      )}
    </div>
  );
}
