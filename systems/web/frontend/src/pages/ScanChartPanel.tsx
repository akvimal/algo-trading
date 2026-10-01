import { Suspense, lazy, useRef, useState } from "react";
import type { ChartPaneHandle, DrawTool } from "../chart/ChartPane";
import { DrawToolbar } from "../chart/DrawToolbar";
import { EMPTY_STRUCTURE, INTERVALS, loadTools, saveTools } from "../chart/config";
import { PaneHeader } from "../workstation/PaneHeader";
import { useScanLivePrice } from "./useScanLivePrice";

// The chart library is large and only a card that is actually expanded needs it.
const ChartPane = lazy(() => import("../chart/ChartPane").then((m) => ({ default: m.ChartPane })));

const DEFAULT_INTERVAL = "daily";

// A scan card is an end-of-day/swing read, not an intraday one - the full seven-size switch (down
// to 1m) is more choice than that view needs. 15m stands in for "zoom into today", daily is the
// default and matches what the card's own numbers are, weekly for the wider swing/positional
// picture - see chart/config.ts's own INTERVALS for the full set every other chart still offers.
const SCAN_INTERVALS = INTERVALS.filter((i) => ["15min", "daily", "weekly"].includes(i.value));

type Props = { exchange: string; symbol: string };

/** The chart inside an expanded OI-buildup card (ScanPage.tsx's OiCard) - a single chart with its
 * own interval switch and the same drawing toolbar the Trade page uses, without the ticket or
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

  const { price, connected } = useScanLivePrice(exchange, symbol);

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
      <PaneHeader index={0} symbol={symbol} interval={interval} onInterval={setInterval} price={price} priceShown live={connected} regime={null} active={false} showActive={false} intervals={SCAN_INTERVALS} />
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
