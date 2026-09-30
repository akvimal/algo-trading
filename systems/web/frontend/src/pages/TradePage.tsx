import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/http";
import { getAccounts } from "../api/settings";
import { cancelWaitingOrder, listWaitingOrders, loadChartTrades, moveOpenLevel } from "../api/trade";
import type { OptionGroup, Position, Segment } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import type { ChartPaneHandle, DrawTool, PlanLine, PriceField, RangeMsg, StructureReport } from "../chart/ChartPane";
import { STRUCTURE_TIMEFRAMES, loadIndicatorParams, loadIndicators, loadStructure, loadTools, saveIndicatorParams, saveIndicators, saveStructure, saveTools, type StructureConfig } from "../chart/config";
import { ACCENT, BUY, SELL } from "../chart/colors";
import { AlertBar } from "../chart/AlertBar";
import type { SelectionInfo, Trigger } from "../chart/alerts";
import { DrawToolbar } from "../chart/DrawToolbar";
import { IndicatorMenu } from "../chart/IndicatorMenu";
import { LayersMenu } from "../chart/LayersMenu";
import { LinksMenu } from "../workstation/LinksMenu";
import { announceAlert, prepareAlertChannel } from "../chart/notify";
import { StructureMenu } from "../chart/StructureMenu";
import { AutoTrader } from "../components/AutoTrader";
import { loadAutoTraderVisible } from "../autotrader/model";
import { ErrorNotice, Signed, Skeleton } from "../components/bits";
import { ExpandIcon } from "../chart/icons";
import { checkLevelMove, isContractOf, openLevels, toChartTrades, type OpenLevel } from "../chart/trades";
import { PositionCard } from "../components/PositionCard";
import { TradeTicket } from "../components/TradeTicket";
import { formatPnl, formatPrice } from "../format";
import { useQuoteSocket } from "../hooks/useQuoteSocket";
import { useResource } from "../hooks/useResource";
import { agreement, directionOf } from "../workstation/confluence";
import { PaneHeader } from "../workstation/PaneHeader";
import { CombosMenu } from "../workstation/CombosMenu";
import { addCombo, applyCombo, loadCombos, removeCombo, saveCombos, type Combo } from "../workstation/combos";
import {
  loadWorkstation, paneCount, saveWorkstation, setInterval as setPaneInterval, setLayout, setLinks, setSymbol,
  withUrlSymbol, type Layout, type WorkstationState,
} from "../workstation/state";
import { OiStrip } from "../chart/OiStrip";
import { useOiData } from "../workstation/useOiData";
import { usePaneData } from "../workstation/usePaneData";
import { WIDE_QUERY, useMediaQuery } from "../workstation/useMediaQuery";
import { dayPnl } from "./todayModel";
import { PRESETS, analyzeTicket, defaultLevel, emptyTicketFor, instrumentFor, isFresh, type Ticket } from "./tradeModel";

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
  const { markets, defaultInstrument, defaultOptionStrategy } = useProfile();

  const urlSymbol = params.get("symbol");
  const urlSegment = params.get("segment");
  // Off by default; turned on in Settings — see autotrader/model.ts.
  const [autoTraderVisible] = useState(loadAutoTraderVisible);
  const [ws, setWs] = useState<WorkstationState>(() => withUrlSymbol(loadWorkstation(), urlSymbol, urlSegment));
  useEffect(() => saveWorkstation(ws), [ws]);
  const [combos, setCombos] = useState<Combo[]>(loadCombos);
  useEffect(() => saveCombos(combos), [combos]);
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
  // Always fetched for an eligible instrument (the strip is not opt-in); only the "OI levels" toggle
  // decides whether the derived lines are also drawn on the chart itself. Called unconditionally for
  // both panes, same as usePaneData above: dataB's own fields are null while the second pane is not
  // shown, so its own `enabled` check inside useOiData already costs nothing.
  const oiA = useOiData(dataA, ws.panes[0].symbol);
  const oiB = useOiData(dataB, ws.panes[1].symbol);
  const oi = [oiA, oiB];
  const oiLevels = [tools.oiLevelsOn ? oiA.levels : [], tools.oiLevelsOn && twoUp ? oiB.levels : []];

  const [pushed, setPushed] = useState<Record<string, number>>({});
  const [pushedAt, setPushedAt] = useState<Record<string, number>>({});
  const subs = datas.flatMap((d, i) => (d.exchange && d.symbol && (i === 0 || twoUp) ? [{ exchange: d.exchange, symbol: d.symbol }] : []));
  const socket = useQuoteSocket(subs, (t) => {
    const key = `${t.exchange}:${t.symbol}`;
    setPushed((cur) => ({ ...cur, [key]: t.price }));
    // A tick already passed the socket's own freshness gate (useQuoteSocket) when it arrived, but
    // that only checks it at receipt - if the feed then goes quiet, the last value would otherwise
    // sit in `pushed` looking just as live a minute or an hour later. Track receipt time here too,
    // same "stale at READ time, not just at arrival" gate as `polledAt` below.
    setPushedAt((cur) => ({ ...cur, [key]: Date.now() }));
  });
  useEffect(() => setSocketUp(socket.connected), [socket.connected]);
  const priceOf = (i: 0 | 1): number | null => {
    const d = datas[i];
    const key = d.exchange && d.symbol ? `${d.exchange}:${d.symbol}` : null;
    const now = Date.now();
    const live = key != null && isFresh(pushedAt[key] ?? null, now) ? pushed[key] : undefined;
    const polled = isFresh(d.polledAt, now) ? d.polledPrice : null;
    return live ?? polled ?? null;
  };

  // ---- the person's own trades, drawn on the charts and listed in the ticket ----
  const ticketOpen = ws.ticketOpen || !wide;
  const segmentKey = (twoUp ? [ws.panes[0].segment, ws.panes[1].segment] : [ws.panes[0].segment]).filter((s, i, a) => a.indexOf(s) === i).join(",");
  // Needed whenever the "My trades" chart overlay is on OR the ticket is open (which shows the
  // active instrument's own open positions/groups beneath the order form) - either on its own
  // already justifies the fetch, so this is not gated behind both.
  const tradeRows = useResource(() => loadChartTrades(segmentKey.split(",") as Segment[]), [segmentKey], { pollMs: 15_000, enabled: tools.tradesOn || ticketOpen });
  const chartTrades = useMemo(
    () => [0, 1].map((i) => (tools.tradesOn && tradeRows.data ? toChartTrades(ws.panes[i].symbol, tradeRows.data.positions, tradeRows.data.groups, 0) : [])),
    [tools.tradesOn, tradeRows.data, ws.panes[0].symbol, ws.panes[1].symbol], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The stop and target of open trades, as lines the person can drag.
  const chartLevels = useMemo(
    () => [0, 1].map((i) => (tools.tradesOn && tradeRows.data ? openLevels(ws.panes[i].symbol, tradeRows.data.positions, tradeRows.data.groups) : [])),
    [tools.tradesOn, tradeRows.data, ws.panes[0].symbol, ws.panes[1].symbol], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [levelNote, setLevelNote] = useState<{ text: string; error: boolean } | null>(null);
  async function moveLevel(pane: 0 | 1, level: OpenLevel, price: number): Promise<boolean> {
    const word = level.field === "stop" ? "Stop-loss" : "Target";
    const problem = checkLevelMove(level, price, priceOf(pane));
    if (problem) {
      setLevelNote({ text: problem, error: true });
      return false;
    }
    try {
      await moveOpenLevel(level, price);
    } catch (e) {
      setLevelNote({ text: e instanceof Error ? e.message : "Could not move it. Try again.", error: true });
      return false;
    }
    setLevelNote({ text: `${word} moved to ${formatPrice(price)}.`, error: false });
    tradeRows.reload();
    return true;
  }

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
    { pollMs: 30_000 },
  );
  const account = accounts.data?.find((a) => a.segment === activeSpec.segment);
  const live = account?.live_trading_enabled;

  // ---- the ticket belongs to the active chart ----
  const [ticket, setTicket] = useState<Ticket>(() => emptyTicketFor(activeSpec.symbol, defaultInstrument, defaultOptionStrategy));
  const [pickField, setPickField] = useState<PriceField | null>(null);
  // The order form is hidden once something is already open on this instrument - the open
  // position(s) are almost always what the person came to look at then, and a bare order form
  // above them just pushes that down. "+ Place another order" reveals it again for pyramiding, and
  // resets with everything else the moment the instrument changes.
  const [showFormAnyway, setShowFormAnyway] = useState(false);
  useEffect(() => {
    setTicket(emptyTicketFor(activeSpec.symbol, defaultInstrument, defaultOptionStrategy));
    setPickField(null);
    setShowFormAnyway(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaultInstrument/defaultOptionStrategy
    // intentionally excluded: changing the preference mid-session (e.g. from another tab) should
    // not yank a ticket already in progress here; it takes effect on the next instrument change.
  }, [activeSpec.symbol, activeSpec.segment]);

  const activeData = datas[active];
  const activePrice = priceOf(active);
  // Open positions/groups for the active instrument specifically, shown compactly in the ticket -
  // filtered from the same fetch chartTrades/chartLevels above already use, not a second one. Same
  // matching rules as toChartTrades: a position by its resolved contract, a group by its bare
  // underlying (an option group has no per-contract symbol of its own).
  const activeTrades = useMemo(() => {
    if (!tradeRows.data) return { positions: [] as Position[], groups: [] as OptionGroup[] };
    const want = activeSpec.symbol.trim().toUpperCase();
    return {
      positions: tradeRows.data.positions.filter((p) => p.status === "OPEN" && p.option_group_id == null && isContractOf(p.symbol, want)),
      groups: tradeRows.data.groups.filter((g) => g.status === "OPEN" && g.underlying_symbol.toUpperCase() === want),
    };
  }, [tradeRows.data, activeSpec.symbol]);
  const hasOpenForInstrument = activeTrades.positions.length > 0 || activeTrades.groups.length > 0;
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
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  // ---- alerts on drawings: watched by the chart, announced here ----
  const [armed, setArmed] = useState<[number, number]>([0, 0]);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  function fireAlert(message: string) {
    announceAlert(message);
    setFlash(message);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 8_000);
  }
  function setAlert(trigger: Trigger | null) {
    if (trigger) prepareAlertChannel(); // a click, so the browser lets it wake the sound and ask about notifications
    paneRefs[active].current?.setSelectedAlert(trigger);
  }
  const chooseTool = (t: DrawTool | null) => {
    setTool(t);
    if (t) paneRefs[active].current?.startDrawing(t);
    else paneRefs[active].current?.cancelDrawing();
  };
  useEffect(() => {
    // Changing which chart is active puts a half-armed tool down.
    setTool(null);
    setHasSelection(false);
    setSelection(null);
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

  // Which panel the aside shows when the auto-trader is visible at all - otherwise there is
  // nothing to switch between, the aside is just the ticket, same as before. Not persisted:
  // starting back on Manual every visit is the safer default (an accidental view of an
  // auto-trader you forgot was on is a worse surprise than one extra tap).
  const [asideTab, setAsideTab] = useState<"manual" | "auto">("manual");

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
            </div>
          )}
          {wide && (
            <CombosMenu
              ws={ws}
              combos={combos}
              onApply={(c) => setWs((cur) => applyCombo(cur, c))}
              onRemove={(id) => setCombos((cur) => removeCombo(cur, id))}
              onSave={() => setCombos((cur) => addCombo(cur, ws.panes[0], ws.panes[1]))}
            />
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
          {twoUp && (
            <LinksMenu
              crosshair={ws.links.crosshair}
              onCrosshair={(v) => setWs((cur) => setLinks(cur, { ...cur.links, crosshair: v }))}
              scale={ws.links.scale}
              onScale={(v) => setWs((cur) => setLinks(cur, { ...cur.links, scale: v }))}
              interval={ws.links.interval}
              onInterval={(v) => setWs((cur) => setLinks(cur, { ...cur.links, interval: v }))}
            />
          )}
          <LayersMenu
            tradesOn={tools.tradesOn}
            onTradesOn={(on) => setTools((t) => ({ ...t, tradesOn: on }))}
            oiLevelsOn={tools.oiLevelsOn}
            onOiLevelsOn={(on) => setTools((t) => ({ ...t, oiLevelsOn: on }))}
            priceShown={!tools.priceHidden}
            onPriceShown={(shown) => setTools((t) => ({ ...t, priceHidden: !shown }))}
            ticket={wide ? { open: ws.ticketOpen, onToggle: (open) => setWs((cur) => ({ ...cur, ticketOpen: open })) } : undefined}
          />
          {wide && (
            <button className="chip-btn" aria-label={fullscreen ? "Exit full screen" : "Full screen"} title={fullscreen ? "Exit full screen" : "Full screen"} aria-pressed={fullscreen} onClick={toggleFullscreen}>
              <ExpandIcon />
            </button>
          )}
        </div>
      </div>

      {twoUp && agree && (
        <div className="ws-links" role="group" aria-label="Linked charts">
          <span className={`pill confluence ${agree.verdict === "aligned-up" ? "up" : agree.verdict === "aligned-down" ? "dn" : agree.verdict === "mixed" ? "warn" : ""}`} data-testid="agreement">
            {agree.text}
          </span>
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
          <AlertBar selection={selection} armed={shown.reduce<number>((n, i) => n + armed[i], 0)} onSet={setAlert} />
          {levelNote && (
            <div className={`ws-flash ${levelNote.error ? "error" : ""}`} role={levelNote.error ? "alert" : "status"} data-testid="level-note">
              {levelNote.text}
              <button className="link-btn" onClick={() => setLevelNote(null)}>
                Dismiss
              </button>
            </div>
          )}
          {flash && (
            <div className="ws-flash" role="status" aria-live="polite" data-testid="alert-flash">
              <strong>Price alert</strong> {flash}
              <button className="link-btn" onClick={() => setFlash(null)}>
                Dismiss
              </button>
            </div>
          )}
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
                  priceShown={!tools.priceHidden}
                  live={socket.connected}
                  regime={d.regime}
                  structureTrend={trendFor(i)}
                  active={active === i}
                  showActive={twoUp}
                />
                {d.error && !d.exchange && <ErrorNotice error={d.error as never} onRetry={d.reloadResolve} />}
                <OiStrip summary={oi[i].summary} sentiment={oi[i].sentiment} levels={oi[i].levels} onChartLevelsOn={tools.oiLevelsOn} />
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
                      trades={chartTrades[i]}
                      levels={chartLevels[i]}
                      onLevelMove={(l, p) => moveLevel(i, l, p)}
                      oiLevels={oiLevels[i]}
                      magnet={tools.magnet}
                      drawingsHidden={tools.drawingsHidden}
                      pickField={active === i ? pickField : null}
                      onPick={onPick}
                      onPlanMove={setLevel}
                      onDrawingChange={(s) => {
                        if (active !== i) return;
                        if (!s.drawing) setTool(null);
                        setHasSelection(s.selected);
                        setSelection(s.selection);
                      }}
                      onAlert={fireAlert}
                      onArmed={(n) => setArmed((cur) => (i === 0 ? [n, cur[1]] : [cur[0], n]))}
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
            Drawings are saved per instrument. Right-click a drawing, or select it and press Delete, to remove it. Select a line or zone to be alerted when the price crosses it.
          </p>
        </div>

        {(autoTraderVisible || ticketOpen) && (
          <aside className="ws-ticket" aria-label={autoTraderVisible ? "Trade panel" : "Order ticket"}>
            {autoTraderVisible && (
              <div className="chips" role="tablist" aria-label="Trade panel" style={{ marginBottom: 12 }}>
                <button role="tab" aria-selected={asideTab === "manual"} onClick={() => setAsideTab("manual")}>
                  Manual
                </button>
                <button role="tab" aria-selected={asideTab === "auto"} onClick={() => setAsideTab("auto")}>
                  Auto-trader
                </button>
              </div>
            )}
            {autoTraderVisible && asideTab === "auto" ? (
              <AutoTrader segment={activeSpec.segment} symbol={activeSpec.symbol} contracts={instrumentFor(activeSpec.symbol, activeSpec.segment) === "future"} />
            ) : !ticketOpen ? (
              <p className="dim">The ticket is hidden - turn it back on from Layers ▾.</p>
            ) : (
              <>
            <h1 className="ws-h1">Trade {activeSpec.symbol}</h1>
            {today.data && (
              <p className="ws-today-pnl" data-testid="ws-today-pnl">
                Today on {activeSpec.segment}: <Signed value={today.data.total} text={formatPnl(today.data.total)} /> ·{" "}
                <span className="faint">
                  {formatPnl(today.data.realized)} booked from {today.data.closedToday} closed, {formatPnl(today.data.unrealized)} open
                </span>
              </p>
            )}
            {accounts.loading && <Skeleton lines={5} />}
            {accounts.error && !accounts.data && <ErrorNotice error={accounts.error} onRetry={accounts.reload} />}
            {live && (
              <div className="notice error" role="alert">
                <strong>Your {activeSpec.segment} account is set to live trading.</strong>
                <p style={{ margin: "6px 0 0" }}>
                  Orders here would use real money, so this ticket is paper-only for now. Live order placement isn't built yet - switch back to paper in{" "}
                  <Link to="/more/settings?tab=broker">Settings</Link>.
                </p>
              </div>
            )}
            {ctx && !live && (!hasOpenForInstrument || showFormAnyway) && (
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
                  tradeRows.reload();
                  // The chart's "plan" lines (entry/stop/target) are drawn straight from this
                  // draft - left alone, they kept showing the just-placed order's prices
                  // indefinitely (nothing else ever cleared them; the ticket itself only resets
                  // on a symbol/segment change, not on a successful placement).
                  setTicket(emptyTicketFor(activeSpec.symbol, defaultInstrument, defaultOptionStrategy));
                  setPickField(null);
                }}
              />
            )}
            {hasOpenForInstrument && (
              <>
                <div className="row">
                  <h2 className="section-title">Open positions</h2>
                  {ctx && !live && !showFormAnyway && (
                    <button className="link-btn" onClick={() => setShowFormAnyway(true)}>
                      + Place another order
                    </button>
                  )}
                </div>
                <div className="stack" data-testid="ticket-positions">
                  {activeTrades.positions.map((p) => (
                    <PositionCard key={p.id} kind="position" item={p} compact onChanged={tradeRows.reload} />
                  ))}
                  {activeTrades.groups.map((g) => (
                    <PositionCard key={g.id} kind="group" item={g} compact onChanged={tradeRows.reload} />
                  ))}
                </div>
              </>
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
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
