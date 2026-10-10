import type { ReactNode } from "react";
import type { DrawTool } from "./ChartPane";
import { ChannelIcon, CursorIcon, EyeIcon, EyeOffIcon, FibIcon, HLineIcon, BellIcon, MagnetIcon, PriceLineIcon, RayIcon, TextIcon, TrashIcon, TrendLineIcon, XIcon, ZoneIcon } from "./icons";

const TOOLS: { tool: DrawTool; label: string; icon: ReactNode }[] = [
  { tool: "segment", label: "Trend line", icon: <TrendLineIcon /> },
  { tool: "rayLine", label: "Ray", icon: <RayIcon /> },
  { tool: "horizontalStraightLine", label: "Horizontal line", icon: <HLineIcon /> },
  { tool: "priceLine", label: "Price level", icon: <PriceLineIcon /> },
  { tool: "parallelStraightLine", label: "Channel", icon: <ChannelIcon /> },
  { tool: "rect", label: "Zone (supply or demand)", icon: <ZoneIcon /> },
  { tool: "fibonacciLine", label: "Fibonacci retracement", icon: <FibIcon /> },
  { tool: "textNote", label: "Text", icon: <TextIcon /> },
];

type Props = {
  active: DrawTool | null;
  onTool: (tool: DrawTool | null) => void;
  magnet: boolean;
  onMagnet: () => void;
  /** Whether a new zone is armed with an alert as it is drawn; the button is shown only where the page can keep the choice. */
  zoneAlert?: boolean;
  onZoneAlert?: () => void;
  hidden: boolean;
  onHidden: () => void;
  onClear: () => void;
  hasSelection: boolean;
  onDeleteSelected: () => void;
  /** Further groups of tools shown beneath the drawing tools (the Indicators and Structure buttons). */
  analysis?: ReactNode;
};

/** The vertical strip of drawing tools down the chart's left edge. Picking a tool arms it for the next
 * drag on the chart; picking it again, or the cursor, puts it down. Drawings are saved per instrument. */
export function DrawToolbar({ active, onTool, magnet, onMagnet, zoneAlert, onZoneAlert, hidden, onHidden, onClear, hasSelection, onDeleteSelected, analysis }: Props) {
  return (
    <div className="draw-toolbar" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
      <button className="tool" aria-label="Cursor" title="Cursor (stop drawing)" aria-pressed={active === null} onClick={() => onTool(null)}>
        <CursorIcon />
      </button>
      {TOOLS.map((t) => (
        <button key={t.tool} className="tool" aria-label={t.label} title={t.label} aria-pressed={active === t.tool} onClick={() => onTool(active === t.tool ? null : t.tool)}>
          {t.icon}
        </button>
      ))}
      <span className="tool-sep" role="separator" />
      <button className="tool" aria-label="Magnet" title="Snap to candle highs, lows and closes" aria-pressed={magnet} onClick={onMagnet}>
        <MagnetIcon />
      </button>
      {onZoneAlert && (
        <button
          className="tool"
          aria-label="Alert on new zones"
          title={zoneAlert ? "New zones are armed with an alert as you draw them (click to switch this off)" : "New zones are drawn without an alert (click to arm them as you draw)"}
          aria-pressed={zoneAlert === true}
          onClick={onZoneAlert}
        >
          <BellIcon />
        </button>
      )}
      <button className="tool" aria-label={hidden ? "Show drawings" : "Hide drawings"} title={hidden ? "Show drawings" : "Hide drawings"} aria-pressed={hidden} onClick={onHidden}>
        {hidden ? <EyeOffIcon /> : <EyeIcon />}
      </button>
      <button className="tool" aria-label="Delete selected drawing" title="Delete the selected drawing (or press Delete)" disabled={!hasSelection} onClick={onDeleteSelected}>
        <XIcon />
      </button>
      <button className="tool" aria-label="Clear all drawings" title="Clear all drawings on this instrument" onClick={onClear}>
        <TrashIcon />
      </button>
      {analysis && (
        <>
          <span className="tool-sep" role="separator" />
          {analysis}
        </>
      )}
    </div>
  );
}
