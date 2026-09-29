import { Suspense, lazy, useRef, useState } from "react";
import { getLtp } from "../api/trade";
import type { ChartPaneHandle, DrawTool } from "../chart/ChartPane";
import { DrawToolbar } from "../chart/DrawToolbar";
import { EMPTY_STRUCTURE, loadTools, saveTools } from "../chart/config";
import { useQuoteSocket } from "../hooks/useQuoteSocket";
import { useResource } from "../hooks/useResource";
import { PaneHeader } from "../workstation/PaneHeader";
import { isFresh } from "./tradeModel";

// The chart library is large and only a card that is actually expanded needs it.
const ChartPane = lazy(() => import("../chart/ChartPane").then((m) => ({ default: m.ChartPane })));

const DEFAULT_INTERVAL = "daily";

type Props = { exchange: string; symbol: string };

/** The chart inside an expanded OI-buildup card (ScanPage.tsx's OiCard) - a single chart with its
 * own candle-size switch and the same drawing toolbar the Trade page uses, without the ticket or
 * the rest of the workstation around it. OiScan only ever expands one card at a time, so this is
 * also the only quote socket/chart instance the Scan page opens. Starts on daily - an OI-buildup
 * read is an end-of-day snapshot, so daily is the size that actually matches what is being shown,
 * not intraday noise - but every other size is one tap away. */
export function ScanChartPanel({ exchange, symbol }: Props) {
  const [interval, setInterval] = useState(DEFAULT_INTERVAL);
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [tools, setTools] = useState(loadTools);
  const [hasSelection, setHasSelection] = useState(false);
  const paneRef = useRef<ChartPaneHandle>(null);

  // Same "socket first, REST underneath" price as the Trade page's own charts (usePaneData +
  // TradePage's priceOf), just for the one symbol this card is showing.
  const ltp = useResource(() => getLtp(exchange, symbol), [exchange, symbol], { pollMs: 30_000 });
  const [pushed, setPushed] = useState<{ price: number; at: number } | null>(null);
  const socket = useQuoteSocket([{ exchange, symbol }], (t) => {
    if (t.exchange === exchange && t.symbol === symbol) setPushed({ price: t.price, at: Date.now() });
  });
  const price = pushed && isFresh(pushed.at, Date.now()) ? pushed.price : (ltp.data?.ltp ?? null);

  const chooseTool = (t: DrawTool | null) => {
    setTool(t);
    if (t) paneRef.current?.startDrawing(t);
    else paneRef.current?.cancelDrawing();
  };
  const toggle = (key: "magnet" | "drawingsHidden") =>
    setTools((t) => {
      const next = { ...t, [key]: !t[key] };
      saveTools(next);
      return next;
    });

  return (
    <div className="scan-chart">
      <PaneHeader index={0} symbol={symbol} interval={interval} onInterval={setInterval} price={price} priceShown live={socket.connected} regime={null} active={false} showActive={false} />
      <div className="scan-chart-body">
        <DrawToolbar
          active={tool}
          onTool={chooseTool}
          magnet={tools.magnet}
          onMagnet={() => toggle("magnet")}
          hidden={tools.drawingsHidden}
          onHidden={() => toggle("drawingsHidden")}
          onClear={() => paneRef.current?.clearDrawings()}
          hasSelection={hasSelection}
          onDeleteSelected={() => paneRef.current?.removeSelected()}
        />
        <Suspense fallback={<div className="chart-status">Loading chart…</div>}>
          <ChartPane
            ref={paneRef}
            exchange={exchange}
            symbol={symbol}
            interval={interval}
            price={price}
            indicators={[]}
            indicatorParams={{}}
            indicatorsHidden
            structure={EMPTY_STRUCTURE}
            plan={[]}
            magnet={tools.magnet}
            drawingsHidden={tools.drawingsHidden}
            pickField={null}
            onPick={() => {}}
            onDrawingChange={(s) => {
              if (!s.drawing) setTool(null);
              setHasSelection(s.selected);
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
