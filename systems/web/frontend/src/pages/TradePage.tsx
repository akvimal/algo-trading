import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/http";
import { getAccounts } from "../api/settings";
import { cancelWaitingOrder, listWaitingOrders } from "../api/trade";
import type { OptionGroup, Position } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import type { ChartPaneHandle, DrawTool, PlanLine, PriceField, RangeMsg, StructureReport } from "../chart/ChartPane";
import { STRUCTURE_TIMEFRAMES, loadIndicatorParams, loadIndicators, loadStructure, loadTools, saveIndicatorParams, saveIndicators, saveStructure, saveTools, type StructureConfig } from "../chart/config";
import { ACCENT, BUY, SELL } from "../chart/colors";
import { DrawToolbar } from "../chart/DrawToolbar";
import { IndicatorMenu } from "../chart/IndicatorMenu";
import { StructureMenu } from "../chart/StructureMenu";
import { ErrorNotice, Skeleton } from "../components/bits";
import { ExpandIcon } from "../chart/icons";
import { TradeTicket } from "../components/TradeTicket";
import { CLASSIC_APP_URL } from "../config";
import { formatPrice } from "../format";
import { useQuoteSocket } from "../hooks/useQuoteSocket";
import { useResource } from "../hooks/useResource";
import { agreement, directionOf } from "../workstation/confluence";
import { PaneHeader } from "../workstation/PaneHeader";
import {
  applyPair, isPair, loadWorkstation, paneCount, saveWorkstation, setInterval as setPaneInterval, setLayout, setLinks, setSymbol,
  withUrlSymbol, type Layout, type WorkstationState,
} from "../workstation/state";
import { usePaneData } from "../workstation/usePaneData";
import { WIDE_QUERY, useMediaQuery } from "../workstation/useMediaQuery";
import { dayPnl } from "./todayModel";
import { EMPTY_TICKET, PRESETS, analyzeTicket, defaultLevel, instrumentFor, type Ticket } from "./tradeModel";

// The chart library is large and only this screen needs it, so it loads on demand.
const ChartPane = lazy(() => import("../chart/ChartPane").then((m) => ({ default: m.ChartPane })));

const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "single", label: "One chart" },
  { id: "side", label: "Side by side" },
  { id: "stack", label: "Stacked" },
];

export function TradePage() {
  const [params] = useSearchParams();
  const wide = useMediaQuery(WIDE_QUERY);
  const { markets } = useProfile();

  const urlSymbol = params.get("symbol");
  const urlSegment = params.get("segment");
  const [ws, setWs] = useState<WorkstationState>(() => withUrlSymbol(loadWorkstation(), urlSymbol, urlSegment));
  useEffect(() => saveWorkstation(ws), [ws]);
  // A link from Scan while this screen is already open changes the first chart.
  const lastUrl = useRef(`${urlSymbol}|${urlSegment}`);
  useEffect(() => {
    const key = `${urlSymbol}|${urlSegment}`;
    if (key === lastUrl.current) return;
    lastUrl.current = key;
    setWs((cur) => withUrlSymbol(cur, urlSymbol, urlSegment));
  }, [urlSymbol, urlSegment]);

  // ---- what the person has switched on the charts (shared by both) ----
  const [indicators, setIndicators] = useState<string[]>(() => loadIndicators());
  const [indicatorParams, setIndicatorParams] = useState<Record<string, number[]>>(() => loadIndicatorParams());
  const [structure, setStructure] = useState<StructureConfig>(() => loadStructure());
  const [tools, setTools] = useState(() => loadTools());
  useEffect(() => saveIndicators(indicators), [indicators]);
  useEffect(() => saveIndicatorParams(indicatorParams), [indicatorParams]);
  useEffect(() => saveStructure(structure), [structure]);
  useEffect(() => saveTools(tools), [tools]);

  // ---- data per chart ----
  const twoUp = wide && paneCount(ws) === 2;
  const active = (twoUp ? ws.active : 0) as 0 | 1;
  const [socketUp, setSocketUp] = useState(false);
  const dataA = usePaneData(ws.panes[0], true, socketUp);
  const dataB = usePaneData(twoUp ? ws.panes[1] : null, twoUp, socketUp);
  const datas = [dataA, dataB];

  const [pushed, setPushed] = useState<Record<string, number>>({});
  const subs = datas.flatMap((d, i) => (d.exchange && d.symbol && (i === 0 || twoUp) ? [{ exchange: d.exchange, symbol: d.symbol }] : []));
  const socket = useQuoteSocket(subs, (t) => setPushed((cur) => ({ ...cur, [`${t.exchange}:${t.symbol}`]: t.price })));
  useEffect(() => setSocketUp(socket.connected), [socket.connected]);
  const priceOf = (i: 0 | 1): number | null => {
    const d = datas[i];
    return (d.exchange && d.symbol ? pushed[`${d.exchange}:${d.symbol}`] : undefined) ?? d.polledPrice ?? null;
  };

  // ---- account, budget, waiting orders ----
  const accounts = useResource(getAccounts, []);
  const waiting = useResource(listWaitingOrders, [], { pollMs: 15_000 });
  const activeSpec = ws.panes[active];
  const today = useResource(
    async () => {
      const [positions, groups] = await Promise.all([
        api<Position[]>("execution", `/positions?segment=${activeSpec.segment}&limit=200`),
        api<OptionGroup[]>("execution", `/option-groups?segment=${activeSpec.segment}&limit=200`),
      ]);
      return dayPnl(positions, groups);
    },
    [activeSpec.segment],
  );
  const account = accounts.data?.find((a) => a.segment === activeSpec.segment);
  const live = account?.live_trading_enabled;

  // ---- the ticket belongs to the active chart ----
  const [ticket, setTicket] = useState<Ticket>(EMPTY_TICKET);
  const [pickField, setPickField] = useState<PriceField | null>(null);
  useEffect(() => {
    setTicket(EMPTY_TICKET);
    setPickField(null);
  }, [activeSpec.symbol, activeSpec.segment]);

  const activeData = datas[active];
  const activePrice = priceOf(active);
  const ctx = account
    ? {
        price: activePrice, lotSize: activeData.resolved?.lot_size ?? 1, capital: account.capital_per_trade, riskPct: account.risk_per_trade_pct,
        minRR: account.min_reward_risk_ratio, requireStop: account.require_stop_loss, segment: activeSpec.segment, symbol: activeSpec.symbol,
      }
    : null;
  const analysis = ctx ? analyzeTicket(ticket, ctx) : null;

  const plan: PlanLine[] = useMemo(() => {
    const lines: PlanLine[] = [];
    if (!analysis) return lines;
    if (ticket.orderType === "limit" && analysis.entry != null) lines.push({ key: "entry", price: analysis.entry, label: "Entry", color: ACCENT });
    if (analysis.stop != null) lines.push({ key: "stop", price: analysis.stop, label: "Stop", color: SELL });
    if (analysis.target != null) lines.push({ key: "target", price: analysis.target, label: "Target", color: BUY });
    return lines;
  }, [analysis?.entry, analysis?.stop, analysis?.target, ticket.orderType]); // eslint-disable-line react-hooks/exhaustive-deps

  function onPick(price: number) {
    if (!pickField) return;
    setTicket((t) => ({ ...t, [pickField]: String(price), ...(pickField === "entry" ? { orderType: "limit" as const } : {}) }));
    setPickField(null);
  }

  // A plan line dragged on the chart (or added with "Add line") sets the ticket's price for that field.
  function setLevel(field: PriceField, price: number) {
    setTicket((t) => ({ ...t, [field]: String(price), ...(field === "entry" ? { orderType: "limit" as const } : {}) }));
  }
  function addLine(field: PriceField) {
    const level = defaultLevel(field, ticket.action, activePrice);
    if (level != null) setLevel(field, level);
  }

  // ---- drawing tools act on the active chart ----
  const paneRefs = [useRef<ChartPaneHandle>(null), useRef<ChartPaneHandle>(null)];
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const chooseTool = (t: DrawTool | null) => {
    setTool(t);
    if (t) paneRefs[active].current?.startDrawing(t);
    else paneRefs[active].current?.cancelDrawing();
  };
  useEffect(() => {
    // Changing which chart is active puts a half-armed tool down.
    setTool(null);
    setHasSelection(false);
  }, [active]);

  // ---- linked crosshair and scrolling ----
  const [cursor, setCursor] = useState<{ from: 0 | 1; ts: number | null }>({ from: 0, ts: null });
  const [range, setRange] = useState<{ from: 0 | 1; msg: RangeMsg } | null>(null);

  // ---- structure readout per chart ----
  const [reports, setReports] = useState<[StructureReport | null, StructureReport | null]>([null, null]);
  const tfLabel = (tf: string) => STRUCTURE_TIMEFRAMES.find((t) => t.value === tf)?.label ?? tf;
  const trendFor = (i: 0 | 1) => Object.fromEntries(Object.entries(reports[i]?.trendByTf ?? {}).map(([tf, t]) => [tfLabel(tf), t]));

  // ---- confluence between the two charts ----
  const peerIndex = (active === 0 ? 1 : 0) as 0 | 1;
  const havePeer = twoUp && ws.panes[peerIndex].symbol !== activeSpec.symbol;
  const peer = havePeer ? { symbol: ws.panes[peerIndex].symbol, direction: directionOf(datas[peerIndex].regime) } : null;
  const agree = twoUp ? agreement({ symbol: ws.panes[0].symbol, regime: dataA.regime }, { symbol: ws.panes[1].symbol, regime: dataB.regime }) : null;

  // ---- search, waiting orders, fullscreen ----
  const [search, setSearch] = useState("");
  const go = (e: FormEvent) => {
    e.preventDefault();
    const s = search.trim();
    if (s) setWs((cur) => setSymbol(cur, active, s.toUpperCase(), "NSE"));
    setSearch("");
  };
  const mine = waiting.data?.filter((w) => w.symbol === activeSpec.symbol) ?? [];

  const stage = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void stage.current?.requestFullscreen?.();
  };

  const shown: (0 | 1)[] = twoUp ? [0, 1] : [0];
  const ticketOpen = ws.ticketOpen || !wide;
  const linkCrosshair = twoUp && ws.links.crosshair;
  const linkScale = twoUp && ws.links.scale;

  return (
    <div className={`workstation ${wide ? "wide" : ""} ${fullscreen ? "fullscreen" : ""}`} ref={stage}>
      <div className="ws-bar">
        <div className="chips" role="group" aria-label="Instrument">
          {PRESETS.filter((p) => markets.includes(p.segment) || p.symbol === activeSpec.symbol).map((p) => (
            <button key={p.symbol} aria-pressed={activeSpec.symbol === p.symbol} onClick={() => setWs((cur) => setSymbol(cur, active, p.symbol, p.segment))}>
              {p.label}
            </button>
          ))}
        </div>
        <form onSubmit={go} className="ws-search">
          <label className="sr-only" htmlFor="ws-stock">
            Trade a stock
          </label>
          <input id="ws-stock" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Stock, e.g. RELIANCE" autoComplete="off" />
          <button className="btn btn-small" type="submit" disabled={!search.trim()}>
            Go
          </button>
        </form>

        <div className="ws-tools">
          {wide && (
            <div className="chips" role="group" aria-label="Layout">
              {LAYOUTS.map((l) => (
                <button key={l.id} aria-pressed={ws.layout === l.id} onClick={() => setWs((cur) => setLayout(cur, l.id))}>
                  {l.label}
                </button>
              ))}
              <button aria-pressed={isPair(ws) && twoUp} title="Show NIFTY and BANKNIFTY together, linked" onClick={() => setWs((cur) => applyPair(cur))}>
                NIFTY + BANKNIFTY
              </button>
            </div>
          )}
          <IndicatorMenu
            selected={indicators}
            onSelected={setIndicators}
            params={indicatorParams}
            onParams={setIndicatorParams}
            hidden={tools.indicatorsHidden}
            onHidden={(h) => setTools((t) => ({ ...t, indicatorsHidden: h }))}
          />
          <StructureMenu config={structure} onChange={setStructure} />
          {wide && (
            <>
              <button className="chip-btn" aria-pressed={ws.ticketOpen} onClick={() => setWs((cur) => ({ ...cur, ticketOpen: !cur.ticketOpen }))}>
                {ws.ticketOpen ? "Hide ticket" : "Show ticket"}
              </button>
              <button className="chip-btn" aria-label={fullscreen ? "Exit full screen" : "Full screen"} title={fullscreen ? "Exit full screen" : "Full screen"} aria-pressed={fullscreen} onClick={toggleFullscreen}>
                <ExpandIcon />
              </button>
            </>
          )}
        </div>
      </div>

      {twoUp && (
        <div className="ws-links" role="group" aria-label="Linked charts">
          <label className="check">
            <input type="checkbox" checked={ws.links.crosshair} onChange={(e) => setWs((cur) => setLinks(cur, { ...cur.links, crosshair: e.target.checked }))} />
            <span>Sync crosshair</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={ws.links.scale} onChange={(e) => setWs((cur) => setLinks(cur, { ...cur.links, scale: e.target.checked }))} />
            <span>Sync scrolling and zoom</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={ws.links.interval} onChange={(e) => setWs((cur) => setLinks(cur, { ...cur.links, interval: e.target.checked }))} />
            <span>Same candle size</span>
          </label>
          {agree && (
            <span className={`pill confluence ${agree.verdict === "aligned-up" ? "up" : agree.verdict === "aligned-down" ? "dn" : agree.verdict === "mixed" ? "warn" : ""}`} data-testid="agreement">
              {agree.text}
            </span>
          )}
        </div>
      )}

      <div className="ws-body">
        {wide && (
          <DrawToolbar
            active={tool}
            onTool={chooseTool}
            magnet={tools.magnet}
            onMagnet={() => setTools((t) => ({ ...t, magnet: !t.magnet }))}
            hidden={tools.drawingsHidden}
            onHidden={() => setTools((t) => ({ ...t, drawingsHidden: !t.drawingsHidden }))}
            onClear={() => paneRefs[active].current?.clearDrawings()}
            hasSelection={hasSelection}
            onDeleteSelected={() => paneRefs[active].current?.removeSelected()}
          />
        )}

        <div className="ws-charts">
          <div className={`ws-grid layout-${twoUp ? ws.layout : "single"}`}>
          {shown.map((i) => {
            const d = datas[i];
            const spec = ws.panes[i];
            return (
              <section
                key={i}
                className={`ws-pane ${twoUp && active === i ? "active" : ""}`}
                aria-label={`${spec.symbol} chart`}
                onMouseDownCapture={() => twoUp && ws.active !== i && setWs((cur) => ({ ...cur, active: i }))}
              >
                <PaneHeader
                  index={i}
                  symbol={spec.symbol}
                  interval={spec.interval}
                  onInterval={(iv) => setWs((cur) => setPaneInterval(cur, i, iv))}
                  price={priceOf(i)}
                  live={socket.connected}
                  regime={d.regime}
                  structureTrend={trendFor(i)}
                  active={active === i}
                  showActive={twoUp}
                />
                {d.error && !d.exchange && <ErrorNotice error={d.error as never} onRetry={d.reloadResolve} />}
                {d.exchange && d.symbol ? (
                  <Suspense fallback={<div className="chart-status">Loading chart…</div>}>
                    <ChartPane
                      ref={paneRefs[i]}
                      exchange={d.exchange}
                      symbol={d.symbol}
                      interval={spec.interval}
                      price={priceOf(i)}
                      indicators={indicators}
                      indicatorParams={indicatorParams}
                      indicatorsHidden={tools.indicatorsHidden}
                      structure={structure}
                      plan={active === i ? plan : []}
                      magnet={tools.magnet}
                      drawingsHidden={tools.drawingsHidden}
                      pickField={active === i ? pickField : null}
                      onPick={onPick}
                      onPlanMove={setLevel}
                      onDrawingChange={(s) => {
                        if (active !== i) return;
                        if (!s.drawing) setTool(null);
                        setHasSelection(s.selected);
                      }}
                      onStructure={(r) => setReports((cur) => (i === 0 ? [r, cur[1]] : [cur[0], r]))}
                      onCursor={linkCrosshair ? (ts) => setCursor({ from: i, ts }) : undefined}
                      peerCursor={linkCrosshair && cursor.from !== i ? cursor.ts : null}
                      onRange={linkScale ? (msg) => setRange({ from: i, msg }) : undefined}
                      peerRange={linkScale && range && range.from !== i ? range.msg : null}
                    />
                  </Suspense>
                ) : (
                  !d.error && <Skeleton lines={4} />
                )}
              </section>
            );
          })}
          </div>
          {structure.tfs.length > 0 && structure.setups && (reports[active]?.setups.length ?? 0) > 0 && (
            <div className="ws-setups" data-testid="setups">
              {reports[active]!.setups.map((s) => (
                <span key={s.key} className={`pill ${s.direction === "long" ? "up" : "dn"}`}>
                  {s.tf} {s.direction} {s.status} · entry {formatPrice(s.entry)} · stop {formatPrice(s.stop)} · target {formatPrice(s.target)} · {s.rr.toFixed(1)}R
                </span>
              ))}
            </div>
          )}
          <p className="faint ws-note">
            Drawings are saved per instrument. Right-click a drawing, or select it and press Delete, to remove it. The intraday auto-trader and price-alert drawings are still in the{" "}
            <a href={CLASSIC_APP_URL}>classic app</a>.
          </p>
        </div>

        {ticketOpen && (
          <aside className="ws-ticket" aria-label="Order ticket">
            <h1 className="ws-h1">Trade {activeSpec.symbol}</h1>
            {accounts.loading && <Skeleton lines={5} />}
            {accounts.error && !accounts.data && <ErrorNotice error={accounts.error} onRetry={accounts.reload} />}
            {live && (
              <div className="notice error" role="alert">
                <strong>Your {activeSpec.segment} account is set to live trading.</strong>
                <p style={{ margin: "6px 0 0" }}>
                  Orders here would use real money, so this ticket is paper-only for now. Place live orders in the <a href={CLASSIC_APP_URL}>classic app</a>, or switch back to paper in{" "}
                  <Link to="/more/settings?tab=broker">Settings</Link>.
                </p>
              </div>
            )}
            {ctx && !live && (
              <TradeTicket
                ticket={ticket}
                onChange={setTicket}
                ctx={ctx}
                meta={{
                  instrument: instrumentFor(activeSpec.symbol, activeSpec.segment),
                  interval: activeSpec.interval,
                  trendFollowed: activeData.regime ? activeData.regime.trend !== "range" && (activeData.regime.trend === "up") === (ticket.action === "BUY") : false,
                }}
                regime={activeData.regime}
                budget={account?.max_daily_loss != null && today.data ? { limit: account.max_daily_loss, lostToday: Math.max(0, -today.data.realized) } : null}
                peer={peer}
                pickField={pickField}
                onPickField={setPickField}
                onAddLine={addLine}
                onPlaced={() => {
                  waiting.reload();
                  today.reload();
                }}
              />
            )}
            {mine.length > 0 && (
              <>
                <h2 className="section-title">Waiting for a price</h2>
                <div className="card" data-testid="waiting">
                  {mine.map((w) => (
                    <div className="list-row" key={w.id}>
                      <span>
                        <span className={`pill ${w.action === "BUY" ? "up" : "dn"}`}>{w.action}</span> {w.symbol} at <span className="num">{formatPrice(w.trigger_price)}</span>
                        <span className="faint" style={{ display: "block", fontSize: 12 }}>
                          {w.stop_loss_price != null ? `stop ${formatPrice(w.stop_loss_price)}` : "no stop"}
                          {w.target_price != null ? ` · target ${formatPrice(w.target_price)}` : ""}
                        </span>
                      </span>
                      <button className="btn btn-small" onClick={() => void cancelWaitingOrder(w.id).catch(() => undefined).finally(() => waiting.reload())}>
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
