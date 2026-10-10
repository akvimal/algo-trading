import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/http";
import { getAccounts, getUsdInr } from "../api/settings";
import { cancelWaitingOrder, listWaitingOrders, loadChartTrades, moveOpenLevel, moveWaitingOrder } from "../api/trade";
import type { OptionGroup, Position, Pretrade, Segment } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import type { ChartPaneHandle, DrawTool, PlanLine, PriceField, RangeMsg, StructureReport } from "../chart/ChartPane";
import { STRUCTURE_TIMEFRAMES, loadIndicatorParams, loadIndicators, loadStructure, loadTools, resetStructureForInterval, saveIndicatorParams, saveIndicators, saveStructure, saveTools, structureIsOn, toggleStructureOn, type StructureConfig } from "../chart/config";
import { ACCENT, BUY, SELL } from "../chart/colors";
import { AlertBar } from "../chart/AlertBar";
import { AnalysisTools } from "../chart/AnalysisTools";
import type { AiReadHandle } from "../chart/AiReadPanel";
import { OiTools } from "../chart/OiTools";
import { hasOiChain } from "../chart/oiLevels";
import { StyleBar } from "../chart/StyleBar";
import type { SelectionInfo, Trigger } from "../chart/alerts";
import { DrawToolbar } from "../chart/DrawToolbar";
import { IndicatorMenu } from "../chart/IndicatorMenu";
import { ViewToggles } from "../chart/ViewToggles";
import { announceAlert, prepareAlertChannel } from "../chart/notify";
import { StructureMenu } from "../chart/StructureMenu";
import { AutoTrader } from "../components/AutoTrader";
import { loadAutoTraderVisible } from "../autotrader/model";
import { ErrorNotice, Signed, Skeleton } from "../components/bits";
import { ExpandIcon } from "../chart/icons";
import { checkLevelMove, checkWaitingMove, isContractOf, openLevels, toChartTrades, waitingLevels, type OpenLevel } from "../chart/trades";
import { NotesPanel } from "../components/NotesPanel";
import { buildNoteContext } from "../components/notesModel";
import { loadAiRead } from "../chart/aiReadStore";
import { PositionCard } from "../components/PositionCard";
import { TradeTicket } from "../components/TradeTicket";
import { formatPnl, formatPrice } from "../format";
import { useQuoteSocket } from "../hooks/useQuoteSocket";
import { useResource } from "../hooks/useResource";
import { LayoutMenu } from "../workstation/LayoutMenu";
import { PaneHeader } from "../workstation/PaneHeader";
import { CombosMenu } from "../workstation/CombosMenu";
import { MarketInfoMenu } from "../workstation/MarketInfoMenu";
import { addCombo, applyCombo, loadCombos, removeCombo, saveCombos, type Combo } from "../workstation/combos";
import {
  loadWorkstation, paneCount, saveWorkstation, setInterval as setPaneInterval, setLayout, setLinks, setSplit, setSymbol,
  withUrlLayout, withUrlSymbol, urlAsksForLayout, type WorkstationState,
} from "../workstation/state";
import { OiStrip } from "../chart/OiStrip";
import { oiStripItems } from "../chart/oiStripModel";
import { useOiData } from "../workstation/useOiData";
import { usePaneData } from "../workstation/usePaneData";
import { WIDE_QUERY, useMediaQuery } from "../workstation/useMediaQuery";
import { dayPnl } from "./todayModel";
import { PRESETS, analyzeTicket, defaultLevel, emptyTicketFor, instrumentFor, isFresh, type Ticket } from "./tradeModel";
import { groupsApi, positionsApi } from "../api/rupees";

// The chart library is large and only this screen needs it, so it loads on demand.
const ChartPane = lazy(() => import("../chart/ChartPane").then((m) => ({ default: m.ChartPane })));

export function TradePage() {
  const [params] = useSearchParams();
  const wide = useMediaQuery(WIDE_QUERY);
  const { markets, defaultsFor } = useProfile();

  const urlSymbol = params.get("symbol");
  const urlSegment = params.get("segment");
  const urlLayout = params.get("layout");
  const urlIntervals = params.get("intervals");
  // Off by default; turned on in Settings — see autotrader/model.ts.
  const [autoTraderVisible] = useState(loadAutoTraderVisible);
  const [ws, setWs] = useState<WorkstationState>(() => withUrlLayout(withUrlSymbol(loadWorkstation(), urlSymbol, urlSegment), urlLayout, urlIntervals));
  // A link that asked for its own layout (weekly + daily side by side) must not overwrite the setup the person saved just by being opened: it is
  // kept for this tab, and saved from the first change the person makes themselves.
  const skipSave = useRef(urlAsksForLayout(urlLayout, urlIntervals));
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    saveWorkstation(ws);
  }, [ws]);
  const [combos, setCombos] = useState<Combo[]>(loadCombos);
  useEffect(() => saveCombos(combos), [combos]);
  // A link from Scan while this screen is already open changes the first chart.
  const lastUrl = useRef(`${urlSymbol}|${urlSegment}|${urlLayout}|${urlIntervals}`);
  useEffect(() => {
    const key = `${urlSymbol}|${urlSegment}|${urlLayout}|${urlIntervals}`;
    if (key === lastUrl.current) return;
    lastUrl.current = key;
    if (urlAsksForLayout(urlLayout, urlIntervals)) skipSave.current = true;
    setWs((cur) => withUrlLayout(withUrlSymbol(cur, urlSymbol, urlSegment), urlLayout, urlIntervals));
  }, [urlSymbol, urlSegment, urlLayout, urlIntervals]);

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
  // One chart can fill the area for a closer look; the other stays loaded underneath, so coming back is instant.
  const [maximized, setMaximized] = useState<0 | 1 | null>(null);
  const focus = twoUp ? maximized : null;
  const active = (twoUp ? (focus ?? ws.active) : 0) as 0 | 1;
  const setStructureOn = (on: boolean) => setStructure((s) => ({ ...s, tfs: toggleStructureOn(on, ws.panes[active].interval) }));
  const [socketUp, setSocketUp] = useState(false);
  const dataA = usePaneData(ws.panes[0], true, socketUp);
  const dataB = usePaneData(twoUp ? ws.panes[1] : null, twoUp, socketUp);
  const datas = [dataA, dataB];
  // Always fetched for an eligible instrument (the strip is not opt-in); only the "OI levels" toggle
  // decides whether the derived lines are also drawn on the chart itself. Called unconditionally for
  // both panes, same as usePaneData above: dataB's own fields are null while the second pane is not
  // shown, so its own `enabled` check inside useOiData already costs nothing.
  const oiWanted = tools.oiStripOn || tools.oiLevelsOn; // with both off nothing reads the option chain, so it is not polled
  const oiA = useOiData(dataA, ws.panes[0].symbol, oiWanted);
  const oiB = useOiData(dataB, ws.panes[1].symbol, oiWanted);
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

  // Orders still waiting for their price: listed beside the ticket, and drawn on the chart with the open trades' levels.
  const waiting = useResource(listWaitingOrders, [], { pollMs: 15_000 });

  // The stop and target of open trades, as lines the person can drag.
  const chartLevels = useMemo(
    () =>
      [0, 1].map((i) => [
        ...(tools.tradesOn && tradeRows.data ? openLevels(ws.panes[i].symbol, tradeRows.data.positions, tradeRows.data.groups) : []),
        ...(tools.tradesOn && waiting.data ? waitingLevels(ws.panes[i].symbol, waiting.data) : []), // an order still waiting for its price is part of the plan too
      ]),
    [tools.tradesOn, tradeRows.data, waiting.data, ws.panes[0].symbol, ws.panes[1].symbol], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // ---- the notes panel: what the market looks like on the active chart, read when a note is sent ----
  function aiReadFor(i: 0 | 1) {
    const s = oi[i].summary;
    return s ? loadAiRead(`${s.underlying_exchange}:${s.underlying_symbol}:${s.expiry}`) : null;
  }
  function noteContextFor() {
    const i = active;
    const base = ws.panes[i].symbol.trim().toUpperCase();
    const open = tradeRows.data
      ? tradeRows.data.positions.filter((p) => p.status === "OPEN" && p.option_group_id == null && isContractOf(p.symbol, base)).length +
        tradeRows.data.groups.filter((g) => g.status === "OPEN" && g.underlying_symbol.toUpperCase() === base).length
      : 0;
    return buildNoteContext({
      price: priceOf(i),
      interval: ws.panes[i].interval,
      regime: datas[i].regime,
      structure: trendFor(i),
      oi: oi[i].summary,
      aiRead: aiReadFor(i),
      holding: open > 0 ? `${open} open ${base} position${open === 1 ? "" : "s"}` : null,
    });
  }
  // What dragging a line said. `tradeId` ties it to the trade it was about: once that trade is no longer on the chart (it hit its stop, was
  // closed or cancelled) the message goes with it, instead of "Stop-loss moved to ..." sitting there about a trade that is over. A confirmation
  // also fades after a few seconds; an error stays until dismissed (or its trade is gone).
  const [levelNote, setLevelNote] = useState<{ text: string; error: boolean; tradeId?: string } | null>(null);
  async function moveLevel(pane: 0 | 1, level: Pick<OpenLevel, "kind" | "field" | "tradeId" | "long">, price: number): Promise<boolean> {
    const word = level.field === "stop" ? "Stop-loss" : level.field === "target" ? "Target" : "Trigger price";
    if (level.kind === "waiting") return moveWaitingLevel(pane, level, price, word);
    const current = chartLevels[pane].find((l) => l.tradeId === level.tradeId && l.field === level.field)?.price ?? null;
    const problem = checkLevelMove(level, price, priceOf(pane), current);
    if (problem) {
      setLevelNote({ text: problem, error: true, tradeId: level.tradeId });
      return false;
    }
    try {
      await moveOpenLevel(level, price, ws.panes[pane].interval);
    } catch (e) {
      setLevelNote({ text: e instanceof Error ? e.message : "Could not move it. Try again.", error: true, tradeId: level.tradeId });
      return false;
    }
    setLevelNote({ text: `${word} moved to ${formatPrice(price)}.`, error: false, tradeId: level.tradeId });
    tradeRows.reload();
    return true;
  }

  useEffect(() => {
    if (!levelNote) return;
    if (levelNote.tradeId && !chartLevels.some((levels) => levels.some((l) => l.tradeId === levelNote.tradeId))) {
      setLevelNote(null); // its trade is over
      return;
    }
    if (levelNote.error) return;
    const timer = window.setTimeout(() => setLevelNote(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [levelNote, chartLevels]);

  // An order still waiting for its price: its lines move on the server (which re-checks them) and the list reloads; the × on its entry line cancels it.
  async function moveWaitingLevel(pane: 0 | 1, level: Pick<OpenLevel, "field" | "tradeId" | "long">, price: number, word: string): Promise<boolean> {
    const mine = chartLevels[pane].filter((l) => l.kind === "waiting" && l.tradeId === level.tradeId);
    const at = (f: OpenLevel["field"]) => mine.find((l) => l.field === f)?.price ?? null;
    const entry = at("entry");
    const problem = entry == null ? "That order is no longer waiting." : checkWaitingMove(level, price, { entry, stop: at("stop"), target: at("target") });
    if (problem) {
      setLevelNote({ text: problem, error: true, tradeId: level.tradeId });
      return false;
    }
    try {
      await moveWaitingOrder(level.tradeId, level.field, price);
    } catch (e) {
      setLevelNote({ text: e instanceof Error ? e.message : "Could not move it. Try again.", error: true, tradeId: level.tradeId });
      waiting.reload();
      return false;
    }
    setLevelNote({ text: `${word} of the waiting order moved to ${formatPrice(price)}.`, error: false, tradeId: level.tradeId });
    waiting.reload();
    return true;
  }
  async function cancelWaitingLevel(level: Pick<OpenLevel, "tradeId">) {
    try {
      await cancelWaitingOrder(level.tradeId);
      setLevelNote({ text: "Waiting order cancelled.", error: false });
    } catch (e) {
      setLevelNote({ text: e instanceof Error ? e.message : "Could not cancel it. Try again.", error: true });
    }
    waiting.reload();
  }

  // ---- account, budget, waiting orders ----
  // What today looks like for the ticket's plan block (cooldown, trades so far, loss-limit room): the server's rules, the same ones the score uses.
  const pretrade = useResource(
    () => api<Pretrade>("execution", `/discipline/${ws.panes[active].segment}/today?symbol=${encodeURIComponent(ws.panes[active].symbol)}`),
    [ws.panes[active].segment, ws.panes[active].symbol],
    { pollMs: 30_000 },
  );
  const accounts = useResource(getAccounts, []);
  const activeSpec = ws.panes[active];
  const today = useResource(
    async () => {
      const [positions, groups] = await Promise.all([
        positionsApi(`/positions?segment=${activeSpec.segment}&limit=200`),
        groupsApi(`/option-groups?segment=${activeSpec.segment}&limit=200`),
      ]);
      return dayPnl(positions, groups);
    },
    [activeSpec.segment],
    { pollMs: 30_000 },
  );
  const account = accounts.data?.find((a) => a.segment === activeSpec.segment);
  const live = account?.live_trading_enabled;

  // ---- the ticket belongs to the active chart ----
  const { instrument: defaultInstrument, optionStrategy: defaultOptionStrategy } = defaultsFor(activeSpec.segment); // this market's own default
  const [ticket, setTicket] = useState<Ticket>(() => emptyTicketFor(activeSpec.symbol, defaultInstrument, defaultOptionStrategy));
  const [pickField, setPickField] = useState<PriceField | null>(null);
  // The same chart click can instead set the stop or target of an OPEN trade (saved straight away, like
  // dragging its line) - never both at once.
  const [levelPick, setLevelPick] = useState<{ kind: "position" | "group"; tradeId: string; long: boolean; field: "stop" | "target" } | null>(null);
  // The order form is hidden once something is already open on this instrument: the open position(s) are what the person came to
  // look at, and a second order on top of one is how a plan turns into averaging in. To add, close it first or let its stop or target
  // do it. (There used to be a "+ Place another order" link here; it is gone by decision.)
  useEffect(() => {
    setTicket(emptyTicketFor(activeSpec.symbol, defaultInstrument, defaultOptionStrategy));
    setSuggested({});
    setPickField(null);
    setLevelPick(null);
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
  // Until the first answer about the person's open trades and waiting orders is in, "nothing is open here" is only an assumption. Showing the
  // new-trade form on it meant the form was on screen at load and then, a moment later, was replaced by the open trade's card (or folded away
  // for a waiting order). A failed load counts as an answer: the form is then the best that can be offered.
  const tradesKnown = !(tradeRows.loading && !tradeRows.data) && !(waiting.loading && !waiting.data);
  const usdinr = useResource(getUsdInr, [], { enabled: activeSpec.segment === "CRYPTO" }); // crypto is priced in dollars; capital and every total are rupees
  const ctx = account
    ? {
        price: activePrice, lotSize: activeData.resolved?.lot_size ?? 1, capital: account.capital_per_trade, riskPct: account.risk_per_trade_pct,
        minRR: account.min_reward_risk_ratio, requireStop: account.require_stop_loss, segment: activeSpec.segment, symbol: activeSpec.symbol,
        usdinr: activeSpec.segment === "CRYPTO" ? (usdinr.data ?? null) : undefined, leverage: activeSpec.segment === "CRYPTO" ? (account.leverage ?? 1) : undefined,
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
    if (levelPick) {
      const level = levelPick;
      setLevelPick(null);
      void moveLevel(active, level, price);
      return;
    }
    if (!pickField) return;
    setTicket((t) => ({ ...t, [pickField]: String(price), ...(pickField === "entry" ? { orderType: "limit" as const } : {}) }));
    setPickField(null);
  }

  // A plan line dragged on the chart (or suggested with "Suggest") sets the ticket's price for that field.
  function setLevel(field: PriceField, price: number) {
    setTicket((t) => ({ ...t, [field]: String(price), ...(field === "entry" ? { orderType: "limit" as const } : {}) }));
  }
  // "Suggest" on an open trade: save a starting stop/target at the usual distance, then it is a line to drag.
  function addOpenLevel(kind: "position" | "group", tradeId: string, long: boolean, field: "stop" | "target") {
    const level = defaultLevel(field, long ? "BUY" : "SELL", activePrice, paneRefs[active].current?.typicalMove() ?? null, ctx?.minRR);
    if (level != null) void moveLevel(active, { kind, tradeId, long, field }, level);
  }
  const openTradeHelp = (kind: "position" | "group", tradeId: string, long: boolean) => ({
    pickingField: levelPick && levelPick.tradeId === tradeId ? levelPick.field : null,
    onAddLine: (field: "stop" | "target") => addOpenLevel(kind, tradeId, long, field),
    onPick: (field: "stop" | "target" | null) => {
      setPickField(null);
      setLevelPick(field ? { kind, tradeId, long, field } : null);
    },
  });
  // One click fills the stop and target that are still empty from the chart's typical move and the person's minimum reward-to-risk.
  // The price "Suggest" first put on each field, so the ticket can offer a way back to it after the person has dragged or typed over it.
  const [suggested, setSuggested] = useState<Partial<Record<PriceField, number>>>({});
  function addLine(field: PriceField) {
    const level = defaultLevel(field, ticket.action, activePrice, paneRefs[active].current?.typicalMove() ?? null, ctx?.minRR);
    if (level != null) {
      setSuggested((cur) => ({ ...cur, [field]: level }));
      setLevel(field, level);
    }
  }

  // ---- drawing tools act on the active chart ----
  const paneRefs = [useRef<ChartPaneHandle>(null), useRef<ChartPaneHandle>(null)];
  const aiRefs = [useRef<AiReadHandle>(null), useRef<AiReadHandle>(null)];
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
  // The time clicked on either chart, while two are linked: marked on both, and the other one pans to it.
  const [picked, setPicked] = useState<{ ts: number; seq: number; from: 0 | 1 } | null>(null);
  const [range, setRange] = useState<{ from: 0 | 1; msg: RangeMsg } | null>(null);

  // ---- structure readout per chart ----
  const [reports, setReports] = useState<[StructureReport | null, StructureReport | null]>([null, null]);
  const tfLabel = (tf: string) => STRUCTURE_TIMEFRAMES.find((t) => t.value === tf)?.label ?? tf;
  const trendFor = (i: 0 | 1) => Object.fromEntries(Object.entries(reports[i]?.trendByTf ?? {}).map(([tf, t]) => [tfLabel(tf), t]));

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
  const gridRef = useRef<HTMLDivElement>(null);
  const dragSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = gridRef.current?.getBoundingClientRect();
    if (!box) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const stacked = ws.layout === "stack";
    const move = (ev: PointerEvent) => {
      const r = stacked ? (ev.clientY - box.top) / box.height : (ev.clientX - box.left) / box.width;
      setWs((cur) => setSplit(cur, r));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const linkCrosshair = twoUp && ws.links.crosshair;
  useEffect(() => {
    if (!twoUp) setMaximized(null);
  }, [twoUp]);
  useEffect(() => {
    if (!twoUp || !linkCrosshair) setPicked(null);
  }, [twoUp, linkCrosshair]);
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
          <MarketInfoMenu segment={activeSpec.segment} symbol={activeSpec.symbol} markets={markets} />
          {wide && (
            <LayoutMenu
              layout={ws.layout}
              onChange={(layout) => setWs((cur) => setLayout(cur, layout))}
              twoUp={twoUp}
              links={ws.links}
              onLinks={(patch) => setWs((cur) => setLinks(cur, { ...cur.links, ...patch }))}
            />
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
          {!wide && (
            <>
              <IndicatorMenu
                selected={indicators}
                onSelected={setIndicators}
                params={indicatorParams}
                onParams={setIndicatorParams}
                hidden={tools.indicatorsHidden}
                onHidden={(h) => setTools((t) => ({ ...t, indicatorsHidden: h }))}
                structureOn={structureIsOn(structure)}
                onStructureOn={setStructureOn}
              />
              {structureIsOn(structure) && <StructureMenu config={structure} onChange={setStructure} />}
            </>
          )}
          <ViewToggles
            tradesOn={tools.tradesOn}
            onTradesOn={(on) => setTools((t) => ({ ...t, tradesOn: on }))}
            oi={
              wide
                ? undefined
                : {
                    stripOn: tools.oiStripOn,
                    onStripOn: (on) => setTools((t) => ({ ...t, oiStripOn: on })),
                    levelsOn: tools.oiLevelsOn,
                    onLevelsOn: (on) => setTools((t) => ({ ...t, oiLevelsOn: on })),
                  }
            }
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
            analysis={
              <>
              <AnalysisTools
                selected={indicators}
                onSelected={setIndicators}
                params={indicatorParams}
                onParams={setIndicatorParams}
                indicatorsHidden={tools.indicatorsHidden}
                onIndicatorsHidden={(h) => setTools((t) => ({ ...t, indicatorsHidden: h }))}
                structure={structure}
                onStructure={setStructure}
                structureOn={structureIsOn(structure)}
                onStructureOn={setStructureOn}
              />
              <span className="tool-sep" role="separator" />
              <OiTools
                available={hasOiChain(activeSpec.symbol)}
                stripOn={tools.oiStripOn}
                onStrip={(on) => setTools((t) => ({ ...t, oiStripOn: on }))}
                levelsOn={tools.oiLevelsOn}
                onLevels={(on) => setTools((t) => ({ ...t, oiLevelsOn: on }))}
                onAiRead={() => aiRefs[active].current?.activate()}
              />
              </>
            }
          />
        )}

        <div className="ws-charts">
          <StyleBar
            selection={selection}
            onStyle={(patch) => paneRefs[active].current?.setSelectedStyle(patch)}
            onReset={() => paneRefs[active].current?.resetSelectedStyle()}
            onDefault={(on) => paneRefs[active].current?.setSelectedStyleAsDefault(on)}
            onLabel={(text) => paneRefs[active].current?.setSelectedLabel(text)}
          />
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
          <div
            ref={gridRef}
            className={`ws-grid layout-${twoUp ? ws.layout : "single"} ${focus != null ? "focused" : ""}`}
            style={twoUp && focus == null ? ({ "--split-a": `${ws.split}fr`, "--split-b": `${1 - ws.split}fr` } as CSSProperties) : undefined}
          >
          {shown.map((i) => {
            const d = datas[i];
            const spec = ws.panes[i];
            return (
              <section
                key={i}
                className={`ws-pane ${twoUp && active === i ? "active" : ""} ${focus != null && focus !== i ? "ws-pane-hidden" : ""}`}
                aria-label={`${spec.symbol} chart`}
                onMouseDownCapture={() => twoUp && ws.active !== i && setWs((cur) => ({ ...cur, active: i }))}
              >
                <PaneHeader
                  index={i}
                  symbol={spec.symbol}
                  interval={spec.interval}
                  onInterval={(iv) => {
                    setWs((cur) => setPaneInterval(cur, i, iv));
                    setStructure((cur) => ({ ...cur, tfs: resetStructureForInterval(cur.tfs, iv) }));
                  }}
                  price={priceOf(i)}
                  priceShown={!tools.priceHidden}
                  live={socket.connected}
                  regime={d.regime}
                  contract={d.resolved?.trade_symbol ?? null}
                  expiry={d.resolved?.expiry ?? null}
                  structureTrend={trendFor(i)}
                  active={active === i}
                  showActive={twoUp}
                  maximized={focus === i}
                  onToggleMaximize={twoUp ? () => setMaximized((m) => (m === i ? null : i)) : undefined}
                />
                {d.error && !d.exchange && <ErrorNotice error={d.error as never} onRetry={d.reloadResolve} />}
                <OiStrip
                  summary={oi[i].summary}
                  sentiment={oi[i].sentiment}
                  levels={oi[i].levels}
                  onChartLevelsOn={tools.oiLevelsOn}
                  stripOn={tools.oiStripOn}
                  aiTarget={hasOiChain(spec.symbol) && d.exchange && d.symbol ? { exchange: d.exchange, symbol: d.symbol } : null}
                  aiRef={aiRefs[i]}
                />
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
                      onLevelCancel={(l) => void cancelWaitingLevel(l)}
                      oiLevels={oiLevels[i]}
                      magnet={tools.magnet}
                      drawingsHidden={tools.drawingsHidden}
                      pickField={active === i ? (levelPick?.field ?? pickField) : null}
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
                      onTimeClick={twoUp && linkCrosshair ? (ts) => setPicked((p) => ({ ts, seq: (p?.seq ?? 0) + 1, from: i })) : undefined}
                      panTo={twoUp && linkCrosshair && picked && picked.from !== i ? { ts: picked.ts, seq: picked.seq } : null}
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
          {twoUp && focus == null && (
            <div
              className="ws-splitter"
              role="separator"
              aria-label="Resize charts"
              aria-orientation={ws.layout === "stack" ? "horizontal" : "vertical"}
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(ws.split * 100)}
              tabIndex={0}
              title="Drag to resize the charts; double-click to even them out"
              onPointerDown={dragSplit}
              onDoubleClick={() => setWs((cur) => setSplit(cur, 0.5))}
              onKeyDown={(e: ReactKeyboardEvent) => {
                const back = ws.layout === "stack" ? "ArrowUp" : "ArrowLeft";
                const fwd = ws.layout === "stack" ? "ArrowDown" : "ArrowRight";
                if (e.key === back || e.key === fwd) {
                  e.preventDefault();
                  setWs((cur) => setSplit(cur, cur.split + (e.key === fwd ? 0.05 : -0.05)));
                }
              }}
            />
          )}
          </div>
          {/* No key on the instrument: it remounted the panel (folding it shut) whenever a click made the other chart active. The panel
              clears its own draft when the segment or symbol changes. */}
          <NotesPanel
            segment={ws.panes[active].segment}
            symbol={ws.panes[active].symbol}
            interval={ws.panes[active].interval}
            getContext={noteContextFor}
            getChartImage={(opts) => paneRefs[active].current?.snapshot(opts) ?? { problem: datas[active].error ? `the chart did not load (${datas[active].error!.message})` : "the chart is not on screen yet" }}
            getOiItems={() => (tools.oiStripOn ? oiStripItems(oi[active].summary, oi[active].sentiment, oi[active].levels, tools.oiLevelsOn, formatPrice) : null)}
            aiRead={aiReadFor(active)}
          />
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
            {ctx && !live && !hasOpenForInstrument && !tradesKnown && <Skeleton lines={6} />}
            {ctx && !live && !hasOpenForInstrument && tradesKnown && (
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
                pickField={pickField}
                onPickField={(f) => {
                  setLevelPick(null);
                  setPickField(f);
                }}
                onAddLine={addLine}
                today={pretrade.data ?? null}
                waitingHere={
                  mine.length > 0
                    ? {
                        text: mine.length === 1 ? `a waiting ${mine[0].action} order at ${formatPrice(mine[0].trigger_price)}` : `${mine.length} waiting orders`,
                        cancel: () => void Promise.all(mine.map((w) => cancelWaitingOrder(w.id).catch(() => undefined))).finally(() => waiting.reload()),
                      }
                    : null
                }
                suggested={suggested}
                onPlaced={() => {
                  waiting.reload();
                  today.reload();
                  tradeRows.reload();
                  pretrade.reload();
                  // The chart's "plan" lines (entry/stop/target) are drawn straight from this
                  // draft - left alone, they kept showing the just-placed order's prices
                  // indefinitely (nothing else ever cleared them; the ticket itself only resets
                  // on a symbol/segment change, not on a successful placement).
                  setTicket(emptyTicketFor(activeSpec.symbol, defaultInstrument, defaultOptionStrategy));
                  setSuggested({});
                  setPickField(null);
                }}
              />
            )}
            {hasOpenForInstrument && (
              <>
                <h2 className="section-title" style={{ marginBottom: 2 }}>Open positions</h2>
                <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }} data-testid="no-second-order">
                  To add to it, close it first or let its stop or target do it.
                </p>
                <div className="stack" data-testid="ticket-positions">
                  {activeTrades.positions.map((p) => (
                    <PositionCard key={p.id} kind="position" item={p} compact interval={activeSpec.interval} onChanged={tradeRows.reload} chart={openTradeHelp("position", p.id, p.action === "BUY")} />
                  ))}
                  {activeTrades.groups.map((g) => (
                    <PositionCard key={g.id} kind="group" item={g} compact interval={activeSpec.interval} onChanged={tradeRows.reload} chart={openTradeHelp("group", g.id, g.action === "BUY")} />
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
