import { useState, type ReactNode } from "react";
import { Popover } from "./Popover";
import type { DrawTool } from "./ChartPane";
import { ChannelIcon, CursorIcon, EyeIcon, EyeOffIcon, FibIcon, HLineIcon, BellIcon, MagnetIcon, PriceLineIcon, RayIcon, TextIcon, TrashIcon, TrendLineIcon, XIcon, ZoneIcon } from "./icons";

type ToolDef = { tool: DrawTool; label: string; icon: ReactNode };

const TREND: ToolDef = { tool: "segment", label: "Trend line", icon: <TrendLineIcon /> };
const RAY: ToolDef = { tool: "rayLine", label: "Ray", icon: <RayIcon /> };
const CHANNEL: ToolDef = { tool: "parallelStraightLine", label: "Channel", icon: <ChannelIcon /> };
const HLINE: ToolDef = { tool: "horizontalStraightLine", label: "Horizontal line", icon: <HLineIcon /> };
const PRICE: ToolDef = { tool: "priceLine", label: "Price level", icon: <PriceLineIcon /> };
const ZONE: ToolDef = { tool: "rect", label: "Zone (supply or demand)", icon: <ZoneIcon /> };
const FIB: ToolDef = { tool: "fibonacciLine", label: "Fibonacci retracement", icon: <FibIcon /> };
const TEXT: ToolDef = { tool: "textNote", label: "Text", icon: <TextIcon /> };

/** The drawing tools, grouped by what they are for. A group of several shows as one button that opens its tools (showing the one last used);
 * a group of one is a plain button. A new tool goes into the group it belongs to, so the strip does not grow a button per tool. */
const GROUPS: { name: string; tools: ToolDef[] }[] = [
  { name: "Lines", tools: [TREND, RAY, CHANNEL] },
  { name: "Levels and zones", tools: [HLINE, PRICE, ZONE] },
  { name: "Fibonacci", tools: [FIB] },
  { name: "Text", tools: [TEXT] },
];

type Props = {
  active: DrawTool | null;
  onTool: (tool: DrawTool | null) => void;
  magnet: boolean;
  onMagnet: () => void;
  /** Phone only: whether the chart moves up and down the price scale under a finger (off = the scale fits the candles on screen). */
  pricePan?: boolean;
  onPricePan?: () => void;
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

function ToolGroup({ name, tools, active, onTool }: { name: string; tools: ToolDef[]; active: DrawTool | null; onTool: (tool: DrawTool | null) => void }) {
  const [last, setLast] = useState(0);
  const armed = tools.findIndex((t) => t.tool === active);
  const shown = tools[armed >= 0 ? armed : last];
  return (
    <Popover variant="tool" side="beside" label={name} title={`${name}: ${tools.map((t) => t.label).join(", ")}`} icon={shown.icon} pressed={armed >= 0}>
      {(close) => (
        <div className="tool-options">
          {tools.map((t, i) => (
            <button
              key={t.tool}
              className="tool-option"
              aria-label={t.label}
              aria-pressed={active === t.tool}
              onClick={() => {
                setLast(i);
                onTool(active === t.tool ? null : t.tool);
                close();
              }}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** The vertical strip of drawing tools down the chart's left edge. Picking a tool arms it for the next
 * drag on the chart; picking it again, or the cursor, puts it down. Drawings are saved per instrument. */
export function DrawToolbar({ active, onTool, magnet, onMagnet, pricePan, onPricePan, zoneAlert, onZoneAlert, hidden, onHidden, onClear, hasSelection, onDeleteSelected, analysis }: Props) {
  return (
    <div className="draw-toolbar" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
      <button className="tool" aria-label="Cursor" title="Cursor (stop drawing)" aria-pressed={active === null} onClick={() => onTool(null)}>
        <CursorIcon />
      </button>
      {GROUPS.map((g) =>
        g.tools.length === 1 ? (
          <button key={g.name} className="tool" aria-label={g.tools[0].label} title={g.tools[0].label} aria-pressed={active === g.tools[0].tool} onClick={() => onTool(active === g.tools[0].tool ? null : g.tools[0].tool)}>
            {g.tools[0].icon}
          </button>
        ) : (
          <ToolGroup key={g.name} name={g.name} tools={g.tools} active={active} onTool={onTool} />
        ),
      )}
      <span className="tool-sep" role="separator" />
      <button className="tool" aria-label="Magnet" title="Snap to candle highs, lows and closes" aria-pressed={magnet} onClick={onMagnet}>
        <MagnetIcon />
      </button>
      {onPricePan && (
        <button
          className="tool"
          aria-label="Move chart up and down"
          title={pricePan ? "The chart moves up and down as well as sideways (click to fit the price scale to the candles instead)" : "The price scale fits the candles on screen (click to move the chart up and down)"}
          aria-pressed={pricePan === true}
          onClick={onPricePan}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3" />
          </svg>
        </button>
      )}
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
