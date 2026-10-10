import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/http";
import { createCustomScreen, deleteCustomScreen, listCustomScreens, previewCustomScreen, runCustomScreen, updateCustomScreen } from "../api/customScreens";
import type { ZoneScan, ZoneScanRow, Buildup, CustomScreen, CustomScreenRunResult, OiBuildup, OiRow, Proximity, Regime, Screener, ScreenerRow } from "../api/types";
import { Empty, ErrorNotice, Signed, Skeleton } from "../components/bits";
import { TextField } from "../components/Field";
import { Sparkline } from "../components/Sparkline";
import { formatDay, formatPct, formatPrice } from "../format";
import { useResource } from "../hooks/useResource";
import { ChartIcon, HistoryIcon, TradeIcon } from "../chart/icons";
import { ScanChartPanel } from "./ScanChartPanel";
import { ScanTradePanel } from "./ScanTradePanel";
import {
  BUILDUP_HELP, BUILDUP_LABEL, DEFAULT_MIN_SHIFT, MIN_OI_CHANGE_PCT, MIN_PRICE_MOVE_PCT, OI_DEFAULTS, OI_SIGNAL_HELP, OI_SIGNAL_LABEL, PAGE, PROXIMITY_LABEL, QUADRANT_SIGNALS, REGIME_LABEL, SCREENER_DEFAULTS, compactCount, defaultViewFromOi, filterOi, filterScreener, isQuadrantSignal, oiDays, oiQuadrant, oiSignal, oiWindowChange, totalOiChangePct, tradeLink, visible,
  UNIVERSES, UNIVERSE_LABEL, haveLiquidity, sizeLabel, universeCounts, ZONE_TIER_HELP, zonePlace, zoneTrends, type OiFilters, type OiSignal, type OiSort, type RsCut, type ScreenerFilters, type ScreenerSort, type ZoneFilter,
} from "./scanModel";
import {
  EMPTY_FORM, EXAMPLE_CONDITIONS, INDEX_OPTIONS, defToForm, filterSummary, formToDef, sortScreens, usesIntraday, validateForm, type CustomScreenForm,
} from "./customScreenModel";

const TABS = [
  { id: "oi", label: "OI buildup" },
  { id: "screener", label: "Screener" },
  { id: "custom", label: "Custom" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const parseTab = (v: string | null): TabId => (TABS.some((t) => t.id === v) ? (v as TabId) : "oi");

export function ScanPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  return (
    <div className="stack">
      <h1>Scan</h1>
      <div className="chips" role="tablist" aria-label="Scans">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams({ tab: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "oi" ? <OiScan /> : tab === "screener" ? <ScreenerScan /> : <CustomScreenScan />}
      <p className="faint" style={{ fontSize: 12 }}>
        End-of-day readings for information only. They are not recommendations to buy or sell. Live OI and the Weekly Advisor aren't available here yet.
      </p>
    </div>
  );
}

function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <label className="select-field">
      <span className="dim">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="select-field" style={{ flex: "1 1 160px" }}>
      <span className="dim">Search a symbol</span>
      <input type="search" value={value} placeholder="e.g. RELIANCE" onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </label>
  );
}

/** Shows a page at a time; a new filter starts back at the first page. */
function useShown(resetKey: string): [number, () => void] {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [resetKey]);
  return [shown, () => setShown((n) => n + PAGE)];
}

const buildupOptions = [{ value: "all" as const, label: "All" }, ...(Object.keys(BUILDUP_LABEL) as Buildup[]).map((b) => ({ value: b, label: BUILDUP_LABEL[b] }))];

function OiScan() {
  const data = useResource(() => api<OiBuildup>("marketData", "/oi-buildup?history_days=10"), []);
  const [f, setF] = useState<OiFilters>(OI_DEFAULTS);
  // The nightly zone scan is a separate read: if it is missing or fails the OI list works exactly as before, just without the zone filter's matches.
  const zoneScan = useResource(() => api<ZoneScan>("marketData", "/zone-scan"), []);
  const zones = useMemo(() => Object.fromEntries((zoneScan.data?.rows ?? []).map((z) => [z.symbol, z])) as Record<string, ZoneScanRow>, [zoneScan.data]);
  const rows = data.data ? filterOi(data.data.rows, f, zones) : [];
  const [shown, more] = useShown(JSON.stringify(f));
  // Only one card's chart, and independently only one card's ticket, is ever open at a time - each
  // is its own live read (a quote socket for the chart, an account/regime read for the ticket), so
  // this bounds the page to at most one of each however many cards are on screen. The two track
  // separately (a different card's Chart and a different card's Trade can be open together) since
  // there is no real link between which chart you are looking at and which ticket you are filling.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tradeOpen, setTradeOpen] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="oi-signal">
        <div className="chips" role="group" aria-label="Signal">
          {(["all", ...QUADRANT_SIGNALS, "strong_bull", "strong_bear"] as OiSignal[]).map((s) => (
            <button
              key={s}
              aria-pressed={f.signal === s}
              title={s === "all" ? "Every stock, whatever it shows" : isQuadrantSignal(s) ? `${BUILDUP_LABEL[s]}: ${BUILDUP_HELP[s]}` : OI_SIGNAL_HELP[s]}
              // a list of shifts is read biggest first
              onClick={() =>
                setF({
                  ...f,
                  signal: s,
                  sort: s === "all" ? (f.sort === "strength" || f.sort === "oi_total" ? "call_oi" : f.sort) : isQuadrantSignal(s) ? "oi_total" : "strength",
                })
              }
            >
              {s === "all" ? "All stocks" : isQuadrantSignal(s) ? BUILDUP_LABEL[s] : `★ ${OI_SIGNAL_LABEL[s]}`}
            </button>
          ))}
        </div>
        {(f.signal === "strong_bull" || f.signal === "strong_bear") && (
          <label className="select-field oi-shift">
            <span className="dim">Both sides up at least (%)</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={1000}
              step={1}
              value={Number.isFinite(f.minShift) ? f.minShift : ""}
              onChange={(e) => setF({ ...f, minShift: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) })}
            />
          </label>
        )}
      </div>
      {isQuadrantSignal(f.signal) && (
        <p className="faint" style={{ margin: 0, fontSize: 12 }} data-testid="oi-signal-help">
          {BUILDUP_LABEL[f.signal]}: {BUILDUP_HELP[f.signal]}. Counts when the price moved at least {MIN_PRICE_MOVE_PCT}% and total open interest (calls plus puts) changed at least {MIN_OI_CHANGE_PCT}%, the
          biggest OI change first. It describes today's option chain; it is not a prediction.
        </p>
      )}
      {(f.signal === "strong_bull" || f.signal === "strong_bear") && (
        <p className="faint" style={{ margin: 0, fontSize: 12 }} data-testid="oi-signal-help">
          {OI_SIGNAL_HELP[f.signal]} Both call and put open interest grew by at least {f.minShift}%. It describes today's option chain; it is not a prediction.
        </p>
      )}
      <div className="filters">
        <SearchBox value={f.search} onChange={(search) => setF({ ...f, search })} />
        <Select<ZoneFilter>
          label="At a zone"
          value={f.zone}
          onChange={(zone) => setF({ ...f, zone, sort: zone === "all" ? (f.sort === "zone" ? "call_oi" : f.sort) : "zone" })}
          options={[
            { value: "all", label: "Any stock" },
            { value: "shortlist", label: "Shortlist (tier A and B)" },
            { value: "any", label: "Any zone (A, B and C)" },
          ]}
        />
        <Select label="Call side" value={f.call} onChange={(call) => setF({ ...f, call })} options={buildupOptions} />
        <Select label="Put side" value={f.put} onChange={(put) => setF({ ...f, put })} options={buildupOptions} />
        <Select<OiSort>
          label="Sort by"
          value={f.sort}
          onChange={(sort) => setF({ ...f, sort })}
          options={[
            { value: "call_oi", label: "Call OI change" },
            { value: "put_oi", label: "Put OI change" },
            { value: "pcr", label: "Put/call ratio" },
            { value: "price", label: "Price change" },
            { value: "strength", label: "Size of the shift" },
            { value: "oi_total", label: "Total OI change" },
            { value: "zone", label: "Zone: best tier first" },
            { value: "symbol", label: "Symbol A to Z" },
          ]}
        />
      </div>
      {f.zone !== "all" && (
        <p className="faint" style={{ margin: 0, fontSize: 12 }} data-testid="zone-help">
          {zoneScan.error
            ? "The zone scan could not be loaded, so no stock matches."
            : zoneScan.data?.snapshot_date
              ? `Zones from the nightly scan of ${formatDay(zoneScan.data.snapshot_date)}: an untested demand or supply zone on the daily chart, with the weekly chart and open interest as support. It describes where price sits; it is not a prediction.${data.data && data.data.snapshot_date !== zoneScan.data.snapshot_date ? ` The open interest on the cards is from ${formatDay(data.data.snapshot_date)}, so a tier may not match it.` : ""}`
              : "The nightly zone scan has not run yet."}
        </p>
      )}
      {data.loading && <Skeleton lines={6} />}
      {data.error && <ErrorNotice error={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          <p className="dim" style={{ margin: 0 }}>
            End-of-day snapshot for {formatDay(data.data.snapshot_date)}, compared with the previous trading day. {rows.length} of {data.data.rows.length} stocks.
          </p>
          <details className="legend">
            <summary>What do these mean?</summary>
            {(Object.keys(BUILDUP_LABEL) as Buildup[]).map((b) => (
              <div key={b}>
                <strong>{BUILDUP_LABEL[b]}</strong>: {BUILDUP_HELP[b]}.
              </div>
            ))}
            <div>
              <strong>Put/call ratio</strong>: put open interest divided by call open interest. Above 1 means more puts are open than calls.
            </div>
            <div>
              <strong>The four boxes</strong> compare the price move with the change in total open interest (calls plus puts): long buildup and short covering are the bullish pair, short
              buildup and long unwinding the bearish pair. A stock counts when the price moved at least {MIN_PRICE_MOVE_PCT}% and total OI changed at least {MIN_OI_CHANGE_PCT}%.
            </div>
            <div>
              <strong>At a zone</strong>: the nightly scan reads each F&O stock's daily and weekly chart for an untested demand or supply zone that price is inside or within one day's range of, and not against the
              daily trend. {ZONE_TIER_HELP.A} {ZONE_TIER_HELP.B} {ZONE_TIER_HELP.C} Zones are a judgment drawn from price history, not a signal.
            </div>
            <div>
              <strong>Strong bullish</strong>: {OI_SIGNAL_HELP.strong_bull} <strong>Strong bearish</strong>: {OI_SIGNAL_HELP.strong_bear} A shift counts only when open interest
              grew by at least {DEFAULT_MIN_SHIFT}% (you can change it) on both sides.
            </div>
          </details>
          {data.data.rows.length === 0 ? (
            <Empty title="No snapshot yet">The end-of-day scan has not run yet. Check back after the market closes.</Empty>
          ) : rows.length === 0 ? (
            <Empty title="No stocks match">Try clearing a filter.</Empty>
          ) : (
            <>
              <div className="stack" data-testid="oi-list">
                {visible(rows, shown).map((r) => (
                  <OiCard
                    key={r.symbol}
                    row={r}
                    zone={zones[r.symbol]}
                    minShift={f.minShift}
                    expanded={expanded === r.symbol}
                    onToggle={() => setExpanded((cur) => (cur === r.symbol ? null : r.symbol))}
                    tradeOpen={tradeOpen === r.symbol}
                    onToggleTrade={() => setTradeOpen((cur) => (cur === r.symbol ? null : r.symbol))}
                  />
                ))}
              </div>
              {shown < rows.length && (
                <button className="btn" onClick={more}>
                  Show more ({rows.length - shown} left)
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function BuildupPill({ b }: { b: Buildup | null }) {
  if (!b) return null;
  const good = b === "long_buildup" || b === "short_covering";
  return (
    <span className={`pill ${good ? "up" : "dn"}`} title={BUILDUP_HELP[b]}>
      {BUILDUP_LABEL[b]}
    </span>
  );
}

/** The last five days of call and put OI change for one stock, newest first, each against the day before it. */
const SCAN_ICONS = { history: HistoryIcon, chart: ChartIcon, trade: TradeIcon } as const;

/** The History / Chart / Trade toggles on a result card: an icon, with the word kept as its accessible name and tooltip. */
function ScanIconButton({ kind, open, onClick }: { kind: keyof typeof SCAN_ICONS; open: boolean; onClick: () => void }) {
  const Icon = SCAN_ICONS[kind];
  const label = open ? `Close ${kind}` : kind[0].toUpperCase() + kind.slice(1);
  return (
    <button className="link-btn icon-only" aria-expanded={open} aria-label={label} title={label} onClick={onClick}>
      <Icon />
    </button>
  );
}

function OiHistory({ row }: { row: OiRow }) {
  const days = oiDays(row.history, 5);
  const window = oiWindowChange(row.history, 5);
  if (days.length === 0) {
    return (
      <p className="dim" style={{ margin: 0 }} data-testid="oi-history">
        Not enough history yet: the end-of-day scan keeps one snapshot a day, so a change needs two.
      </p>
    );
  }
  return (
    <div className="oi-history" data-testid="oi-history">
      <table>
        <caption className="sr-only">Last {days.length} days of open interest change for {row.symbol}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Price</th>
            <th scope="col">Call OI</th>
            <th scope="col">Put OI</th>
            <th scope="col">PCR</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{formatDay(d.date)}</th>
              <td>
                <Signed value={d.pricePct} text={formatPct(d.pricePct, 2, true)} />
              </td>
              <td>
                <Signed value={d.callPct} text={formatPct(d.callPct, 1, true)} /> <BuildupPill b={d.callBuildup} />
              </td>
              <td>
                <Signed value={d.putPct} text={formatPct(d.putPct, 1, true)} /> <BuildupPill b={d.putBuildup} />
              </td>
              <td className="num">{d.pcr == null ? "–" : d.pcr.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {window.from && (
        <p className="dim" style={{ margin: "6px 0 0" }}>
          Since {formatDay(window.from)}: call OI <Signed value={window.callPct} text={formatPct(window.callPct, 1, true)} />, put OI{" "}
          <Signed value={window.putPct} text={formatPct(window.putPct, 1, true)} />.
        </p>
      )}
    </div>
  );
}

function ZoneLine({ z }: { z: ZoneScanRow }) {
  return (
    <div className="row" data-testid="zone-line">
      <span>
        <span className={`pill pill-small ${z.zone_kind === "demand" ? "up" : "dn"}`} title={ZONE_TIER_HELP[z.tier]} data-testid="zone-badge">
          Tier {z.tier} · {z.zone_kind === "demand" ? "Demand" : "Supply"}
        </span>{" "}
        <span className="dim">{zonePlace(z)}</span>
      </span>
      <span className="faint num" style={{ fontSize: 12 }} title="The zone's edges, and the trend on each chart">
        {formatPrice(Math.min(z.zone_proximal, z.zone_distal))} to {formatPrice(Math.max(z.zone_proximal, z.zone_distal))} · {zoneTrends(z)}
      </span>
    </div>
  );
}

function OiCard({
  row: r,
  zone,
  minShift,
  expanded,
  onToggle,
  tradeOpen,
  onToggleTrade,
}: {
  row: OiRow;
  zone?: ZoneScanRow;
  minShift: number;
  expanded: boolean;
  onToggle: () => void;
  tradeOpen: boolean;
  onToggleTrade: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <div className="card scan-card" data-testid="oi-card">
      <div className="row">
        <strong>
          {r.symbol}
          {(() => {
            const signal = oiSignal(r, minShift);
            return signal ? (
              <span className={`pill pill-small ${signal === "strong_bull" ? "up" : "dn"}`} title={OI_SIGNAL_HELP[signal]} data-testid="oi-signal-badge" style={{ marginLeft: 8 }}>
                ★ {OI_SIGNAL_LABEL[signal]}
              </span>
            ) : null;
          })()}
          {(() => {
            const q = oiQuadrant(r);
            const total = totalOiChangePct(r);
            return q ? (
              <span className={`pill pill-small ${q === "long_buildup" || q === "short_covering" ? "up" : "dn"}`} title={`${BUILDUP_HELP[q]}. Total OI ${formatPct(total, 1, true)}.`} data-testid="oi-quadrant-badge" style={{ marginLeft: 8 }}>
                {BUILDUP_LABEL[q]} · OI {formatPct(total, 1, true)}
              </span>
            ) : null;
          })()}
        </strong>
        <span>
          <span className="num">{r.spot_price == null ? "–" : formatPrice(r.spot_price)}</span>{" "}
          <Signed value={r.price_change_pct} text={formatPct(r.price_change_pct, 2, true)} />
        </span>
      </div>
      <div className="pair">
        <div>
          <div className="dim">Call OI {compactCount(r.total_call_oi)}</div>
          <Signed value={r.call_oi_change_pct} text={formatPct(r.call_oi_change_pct, 1, true)} /> <BuildupPill b={r.call_buildup} />
        </div>
        <div>
          <div className="dim">Put OI {compactCount(r.total_put_oi)}</div>
          <Signed value={r.put_oi_change_pct} text={formatPct(r.put_oi_change_pct, 1, true)} /> <BuildupPill b={r.put_buildup} />
        </div>
      </div>
      {zone && <ZoneLine z={zone} />}
      <div className="row">
        <span className="dim">
          Put/call ratio <span className="num">{r.pcr == null ? "–" : r.pcr.toFixed(2)}</span>
        </span>
        <span className="field-actions">
          <ScanIconButton kind="history" open={historyOpen} onClick={() => setHistoryOpen((v) => !v)} />
          <ScanIconButton kind="chart" open={expanded} onClick={onToggle} />
          <ScanIconButton kind="trade" open={tradeOpen} onClick={onToggleTrade} />
        </span>
      </div>
      {historyOpen && <OiHistory row={r} />}
      {expanded && <ScanChartPanel exchange={r.exchange} symbol={r.symbol} />}
      {tradeOpen && (
        <div className="scan-chart">
          <ScanTradePanel exchange={r.exchange} symbol={r.symbol} oiDefaultView={defaultViewFromOi(r)} />
        </div>
      )}
      {(expanded || tradeOpen) && (
        <p style={{ margin: "2px 0 0" }}>
          <Link to={tradeLink(r.symbol)} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">Open the full Trade page →</Link>
        </p>
      )}
    </div>
  );
}

const regimeOptions = [{ value: "all" as const, label: "All" }, ...(Object.keys(REGIME_LABEL) as Regime[]).map((r) => ({ value: r, label: REGIME_LABEL[r] }))];
const proximityOptions = [{ value: "all" as const, label: "All" }, ...(Object.keys(PROXIMITY_LABEL) as Proximity[]).map((p) => ({ value: p, label: PROXIMITY_LABEL[p] }))];

function ScreenerScan() {
  const data = useResource(() => api<Screener>("marketData", "/equity-screener?history_days=10"), []);
  const [f, setF] = useState<ScreenerFilters>(SCREENER_DEFAULTS);
  const rows = data.data ? filterScreener(data.data.rows, f) : [];
  const [shown, more] = useShown(JSON.stringify(f));
  // Same one-at-a-time inline chart/trade accordions as OI buildup (see OiScan) - each its own,
  // not shared with the OI tab's, since switching tabs unmounts this component anyway.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tradeOpen, setTradeOpen] = useState<string | null>(null);

  const counts = data.data ? universeCounts(data.data.rows, f.liquid) : null;
  const liquidityKnown = data.data ? haveLiquidity(data.data.rows) : true;

  return (
    <div className="stack">
      <div className="oi-signal">
        <div className="chips" role="group" aria-label="Universe">
          {UNIVERSES.map((u) => (
            <button key={u} aria-pressed={f.universe === u} onClick={() => setF({ ...f, universe: u })} title={u === "other" ? "Stocks in none of the Nifty 500 index lists - mostly smaller and thinner" : undefined}>
              {UNIVERSE_LABEL[u]}
              {counts && ` (${counts[u]})`}
            </button>
          ))}
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={f.liquid} onChange={(e) => setF({ ...f, liquid: e.target.checked })} />
          <span className="dim">Liquid only (₹5 Cr or more traded a day)</span>
        </label>
      </div>
      {f.liquid && !liquidityKnown && data.data && (
        <p className="faint" style={{ margin: 0, fontSize: 12 }} data-testid="liquidity-pending">
          Traded value is filled in by tonight's end-of-day run, so this filter does nothing until then.
        </p>
      )}
      <div className="filters">
        <SearchBox value={f.search} onChange={(search) => setF({ ...f, search })} />
        <Select label="Trend" value={f.regime} onChange={(regime) => setF({ ...f, regime })} options={regimeOptions} />
        <Select<RsCut>
          label="Relative strength (12-1 month)"
          value={f.rs}
          onChange={(rs) => setF({ ...f, rs, sort: rs === "any" ? (f.sort === "rs" ? "d5" : f.sort) : "rs" })}
          options={[
            { value: "any", label: "Any" },
            { value: "10", label: "Top 10%" },
            { value: "20", label: "Top 20%" },
            { value: "40", label: "Top 40%" },
          ]}
        />
        <Select label="52-week range" value={f.proximity} onChange={(proximity) => setF({ ...f, proximity })} options={proximityOptions} />
        <Select<ScreenerSort>
          label="Sort by"
          value={f.sort}
          onChange={(sort) => setF({ ...f, sort })}
          options={[
            { value: "d5", label: "5-day change" },
            { value: "d20", label: "20-day change" },
            { value: "adx", label: "Trend strength (ADX)" },
            { value: "mom", label: "12-1 month return" },
            { value: "ret3m", label: "3-month return" },
            { value: "rs", label: "Relative strength rank" },
            { value: "turnover", label: "Traded value" },
            { value: "ema20", label: "Furthest below 20-day EMA" },
            { value: "rsi3", label: "Lowest 3-day RSI" },
            { value: "symbol", label: "Symbol A to Z" },
          ]}
        />
      </div>
      {data.loading && <Skeleton lines={6} />}
      {data.error && <ErrorNotice error={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          <p className="dim" style={{ margin: 0 }}>
            End-of-day read for {formatDay(data.data.snapshot_date)}. {rows.length} of {data.data.rows.length} stocks. Trend comes from ADX and DMI, the 52-week range from daily bars.
          </p>
          <details className="legend">
            <summary>About these numbers</summary>
            <div>
              <strong>Universe and liquidity</strong>: the index lists are the exchange's own. Traded value is the 20-day average of price times volume; the cut-off keeps out stocks a trader could struggle to leave. Roughly half of all listed stocks fall under it.
            </div>
            <div>
              <strong>Relative strength</strong>: where the 12-1 month return ranks among the liquid stocks (100 is the best). That score is the close a month ago against the close a year ago, so the latest month is left out on purpose.
            </div>
            <div>
              <strong>Not a signal.</strong> These are filters for your own judgment. Back-tests in October 2026 of few-day setups built from these same fields (pullbacks, breakouts, squeezes, oversold bounces, demand zones) found no reliable edge after costs on liquid Nifty 500 stocks. Buying the strongest 12-1 month names for two to four weeks showed a small advantage over the whole group, but not a proven one.
            </div>
          </details>
          {data.data.rows.length === 0 ? (
            <Empty title="No snapshot yet">The end-of-day screener has not run yet. Check back after the market closes.</Empty>
          ) : rows.length === 0 ? (
            <Empty title="No stocks match">Try clearing a filter.</Empty>
          ) : (
            <>
              <div className="stack" data-testid="screener-list">
                {visible(rows, shown).map((r) => (
                  <ScreenerCard
                    key={r.symbol}
                    row={r}
                    expanded={expanded === r.symbol}
                    onToggle={() => setExpanded((cur) => (cur === r.symbol ? null : r.symbol))}
                    tradeOpen={tradeOpen === r.symbol}
                    onToggleTrade={() => setTradeOpen((cur) => (cur === r.symbol ? null : r.symbol))}
                  />
                ))}
              </div>
              {shown < rows.length && (
                <button className="btn" onClick={more}>
                  Show more ({rows.length - shown} left)
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** The descriptive extras on a Screener card, leaving out whatever the stock has too few bars for. */
function SwingLine({ r }: { r: ScreenerRow }) {
  const size = sizeLabel(r);
  const bits: { key: string; text: string; title: string }[] = [];
  if (r.avg_turnover_cr != null) bits.push({ key: "t", text: `₹${r.avg_turnover_cr >= 100 ? r.avg_turnover_cr.toFixed(0) : r.avg_turnover_cr.toFixed(1)} Cr/day`, title: "Average traded value over 20 days" });
  if (r.rs_12m_pctile != null) bits.push({ key: "rs", text: `RS ${r.rs_12m_pctile.toFixed(0)}`, title: "Rank of the 12-1 month return among liquid stocks (100 is the best)" });
  if (r.ret_3m_pct != null) bits.push({ key: "3m", text: `3m ${formatPct(r.ret_3m_pct, 0, true)}`, title: "Return over the last 63 trading days" });
  if (r.mom_12_1_pct != null) bits.push({ key: "12", text: `12-1m ${formatPct(r.mom_12_1_pct, 0, true)}`, title: "The close a month ago against the close a year ago" });
  if (r.dist_ema20_pct != null) bits.push({ key: "e", text: `${formatPct(r.dist_ema20_pct, 1, true)} vs 20-day EMA`, title: "How far the close is from its 20-day exponential average" });
  if (r.rsi3 != null) bits.push({ key: "r", text: `RSI(3) ${r.rsi3.toFixed(0)}`, title: "A very short-term momentum read: low is oversold, high is overbought" });
  if (r.atr_pct != null) bits.push({ key: "a", text: `moves ~${r.atr_pct.toFixed(1)}%/day`, title: "Average true range over 14 days, as a percentage of the close" });
  if (!size && bits.length === 0) return null;
  return (
    <div className="row" data-testid="swing-line">
      <span className="faint" style={{ fontSize: 12 }}>
        {size && <span className="pill pill-small" data-testid="size-badge" style={{ marginRight: 6 }}>{size}</span>}
        {bits.map((b, i) => (
          <span key={b.key} title={b.title}>
            {i > 0 && " · "}
            {b.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function ScreenerCard({
  row: r,
  expanded,
  onToggle,
  tradeOpen,
  onToggleTrade,
}: {
  row: ScreenerRow;
  expanded: boolean;
  onToggle: () => void;
  tradeOpen: boolean;
  onToggleTrade: () => void;
}) {
  return (
    <div className="card scan-card" data-testid="screener-card">
      <div className="row">
        <strong>{r.symbol}</strong>
        <span className="num">{formatPrice(r.close)}</span>
      </div>
      <div className="pair">
        <div>
          <div className="dim">5 days</div>
          <Signed value={r.pct_change_5d} text={formatPct(r.pct_change_5d, 1, true)} />
        </div>
        <div>
          <div className="dim">20 days</div>
          <Signed value={r.pct_change_20d} text={formatPct(r.pct_change_20d, 1, true)} />
        </div>
        <Sparkline values={r.history.map((h) => h.close)} />
      </div>
      <SwingLine r={r} />
      <div className="row">
        <span>
          {r.regime && <span className="pill">{REGIME_LABEL[r.regime]}</span>}
          {r.adx != null && <span className="faint"> ADX {r.adx.toFixed(0)}</span>}
          {r.proximity && (
            <span className={`pill ${r.proximity === "near_52w_high" ? "up" : "dn"}`} style={{ marginLeft: 6 }}>
              {PROXIMITY_LABEL[r.proximity]}
            </span>
          )}
        </span>
        <span className="field-actions">
          <ScanIconButton kind="chart" open={expanded} onClick={onToggle} />
          <ScanIconButton kind="trade" open={tradeOpen} onClick={onToggleTrade} />
        </span>
      </div>
      {expanded && <ScanChartPanel exchange={r.exchange} symbol={r.symbol} />}
      {tradeOpen && (
        <div className="scan-chart">
          <ScanTradePanel exchange={r.exchange} symbol={r.symbol} />
        </div>
      )}
      {(expanded || tradeOpen) && (
        <p style={{ margin: "2px 0 0" }}>
          <Link to={tradeLink(r.symbol)} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">Open the full Trade page →</Link>
        </p>
      )}
    </div>
  );
}

const FNO_OPTIONS = [{ value: "any" as const, label: "Any" }, { value: "yes" as const, label: "F&O only" }, { value: "no" as const, label: "Non-F&O only" }];
const INDEX_SELECT_OPTIONS = [{ value: "", label: "Any" }, ...INDEX_OPTIONS.map((i) => ({ value: i, label: i }))];

/** A saved, per-user, typed expression evaluated against the same EOD universe the other two
 * tabs read - "weekly_close < min(weekly_low, 20) and ema(5) crosses_below ema(20)", labelled
 * "Bearish breakout", filterable to F&O stocks / an index. A price range is just another
 * condition ("close > 100 and close < 500") - no separate min/max fields, see customScreenModel.
 * See app/domain/screener_expr.py (market-data) for the expression grammar. */
function CustomScreenScan() {
  const saved = useResource(listCustomScreens, []);
  const [tab, setTab] = useState<"new" | "saved">("new");
  const [form, setForm] = useState<CustomScreenForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [result, setResult] = useState<CustomScreenRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Same one-at-a-time inline chart/trade accordions as OI buildup/Screener - their own.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tradeOpen, setTradeOpen] = useState<string | null>(null);

  const errors = validateForm(form);

  async function preview() {
    setRunError(null);
    setResult(null);
    setExpanded(null);
    setTradeOpen(null);
    setBusy(true);
    try {
      setResult(await previewCustomScreen(formToDef(form)));
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runSaved(s: CustomScreen) {
    setRunError(null);
    setResult(null);
    setExpanded(null);
    setTradeOpen(null);
    setBusy(true);
    try {
      setResult(await runCustomScreen(s.id));
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setSaveError(null);
    setBusy(true);
    try {
      const def = formToDef(form);
      if (editingId) await updateCustomScreen(editingId, def);
      else await createCustomScreen(def);
      cancelEdit();
      saved.reload();
      setTab("saved");
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await deleteCustomScreen(id).catch(() => undefined);
    if (editingId === id) cancelEdit();
    setDeletingId(null);
    saved.reload();
  }

  function edit(s: CustomScreen) {
    setEditingId(s.id);
    setForm(defToForm(s));
    setResult(null);
    setRunError(null);
    setSaveError(null);
    setTab("new"); // the form lives there, whether starting fresh or editing
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  return (
    <div className="stack">
      <div className="chips" role="tablist" aria-label="Custom screens">
        <button role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>
          {editingId ? "Edit screen" : "New screen"}
        </button>
        <button role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")}>
          Saved screens{saved.data && saved.data.length > 0 ? ` (${saved.data.length})` : ""}
        </button>
      </div>

      {tab === "new" && (
      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          {editingId ? "Edit screen" : "New screen"}
        </h2>
        <TextField id="cs-label" label="Label" value={form.label} onChange={(label) => setForm({ ...form, label })} placeholder="e.g. Bearish breakout" inputMode="text" />
        <TextField
          id="cs-expr"
          label="Condition"
          value={form.expression}
          onChange={(expression) => setForm({ ...form, expression })}
          placeholder="weekly_close < min(weekly_low, 20) and ema(5) crosses_below ema(20)"
          inputMode="text"
          hint="Names: close, open, high, low (daily); weekly_close ...; m5_ m15_ m30_ h1_ for intraday (m15_close, m15_ema(20)). prev(x) is one bar back, prev(x, N) is N bars back. ema(N); min(x, N), max(x, N); < <= > >= == !=, crosses_above, crosses_below; and, or, not. Put daily conditions first: intraday data is fetched live, for up to 120 stocks (about a minute)."
        />
        <div className="chips" role="group" aria-label="Example conditions" style={{ marginBottom: 8 }}>
          {EXAMPLE_CONDITIONS.map((ex) => (
            <button key={ex.label} title={ex.expression} onClick={() => setForm({ ...form, expression: ex.expression })}>
              {ex.label}
            </button>
          ))}
        </div>
        <div className="filters">
          <Select<CustomScreenForm["fno"]> label="F&O" value={form.fno} onChange={(fno) => setForm({ ...form, fno })} options={FNO_OPTIONS} />
          <Select label="Index" value={form.index} onChange={(index) => setForm({ ...form, index })} options={INDEX_SELECT_OPTIONS} />
        </div>
        {errors.length > 0 && (
          <ul className="hints" aria-live="polite">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {runError && (
          <div className="notice error" role="alert">
            {runError}
          </div>
        )}
        {saveError && (
          <div className="notice error" role="alert">
            {saveError}
          </div>
        )}
        {busy && usesIntraday(form.expression) && (
          <p className="faint" role="status" data-testid="intraday-wait" style={{ margin: "6px 0 0", fontSize: 12 }}>
            Reading intraday bars live for each stock. This can take up to a minute.
          </p>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          {editingId && (
            <button className="btn btn-small" onClick={cancelEdit} disabled={busy}>
              Cancel
            </button>
          )}
          <button className="btn btn-small" onClick={() => void preview()} disabled={busy || errors.length > 0}>
            Preview
          </button>
          <button className="btn btn-small btn-primary" onClick={() => void save()} disabled={busy || errors.length > 0}>
            {editingId ? "Save changes" : "Save screen"}
          </button>
        </div>
      </div>
      )}

      {result && (
        <div className="card" data-testid="custom-screen-result">
          <p className="dim" style={{ margin: 0 }}>
            {result.snapshot_date ? `EOD read for ${formatDay(result.snapshot_date)}` : "No EOD data yet - the screener has not run once."}
            {result.snapshot_date && ` · ${result.matches.length} of ${result.candidates} stocks matched`}
            {filterSummary(form) && ` (${filterSummary(form)})`}
            {usesIntraday(form.expression) && " · intraday bars read live"}
          </p>
          {result.intraday_note && (
            <p className="notice" role="note" data-testid="intraday-note" style={{ margin: "6px 0 0" }}>
              {result.intraday_note}
            </p>
          )}
          {result.snapshot_date && result.matches.length === 0 ? (
            <Empty title="No matches">Try a different condition, or loosen the filters.</Empty>
          ) : (
            <div className="stack" data-testid="custom-screen-matches">
              {result.matches.map((m) => {
                const isExpanded = expanded === m.symbol;
                const isTradeOpen = tradeOpen === m.symbol;
                return (
                  <div className="card scan-card" key={m.symbol}>
                    <div className="row">
                      <strong>{m.symbol}</strong>
                      <span className="num">{formatPrice(m.close)}</span>
                      <span className="field-actions">
                        <ScanIconButton kind="chart" open={isExpanded} onClick={() => setExpanded((cur) => (cur === m.symbol ? null : m.symbol))} />
                        <ScanIconButton kind="trade" open={isTradeOpen} onClick={() => setTradeOpen((cur) => (cur === m.symbol ? null : m.symbol))} />
                      </span>
                    </div>
                    {isExpanded && <ScanChartPanel exchange={m.exchange} symbol={m.symbol} />}
                    {isTradeOpen && (
                      <div className="scan-chart">
                        <ScanTradePanel exchange={m.exchange} symbol={m.symbol} />
                      </div>
                    )}
                    {(isExpanded || isTradeOpen) && (
                      <p style={{ margin: "2px 0 0" }}>
                        <Link to={tradeLink(m.symbol)} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">Open the full Trade page →</Link>
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "saved" && (
      <>
      {saved.loading && <Skeleton lines={3} />}
      {saved.error && <ErrorNotice error={saved.error} onRetry={saved.reload} />}
      {saved.data &&
        (sortScreens(saved.data).length === 0 ? (
          <Empty title="No saved screens yet">Build one and save it.</Empty>
        ) : (
          <div className="stack" data-testid="saved-screens">
            {sortScreens(saved.data).map((s) => (
              <div className="card scan-card" key={s.id} data-testid="saved-screen">
                <div className="row">
                  <strong>{s.label}</strong>
                  {filterSummary(defToForm(s)) && <span className="faint" style={{ fontSize: 12 }}>{filterSummary(defToForm(s))}</span>}
                </div>
                <p className="faint num" style={{ margin: "4px 0", fontSize: 13 }}>
                  {s.expression}
                </p>
                <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                  {deletingId === s.id ? (
                    <>
                      <span className="dim" style={{ fontSize: 13 }}>Delete this screen?</span>
                      <button className="btn btn-small" onClick={() => setDeletingId(null)} disabled={busy}>
                        Keep
                      </button>
                      <button className="btn btn-small btn-danger" onClick={() => void remove(s.id)} disabled={busy}>
                        Confirm delete
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-small" onClick={() => edit(s)}>
                        Edit
                      </button>
                      <button className="btn btn-small" onClick={() => void runSaved(s)} disabled={busy}>
                        Run
                      </button>
                      <button className="btn btn-small btn-danger" onClick={() => setDeletingId(s.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </>
      )}
    </div>
  );
}
