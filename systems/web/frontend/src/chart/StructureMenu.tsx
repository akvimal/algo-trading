import { STRUCTURE_TIMEFRAMES, type StructureConfig } from "./config";
import { Popover } from "./Popover";

type PanelProps = {
  config: StructureConfig;
  onChange: (c: StructureConfig) => void;
  /** With `onOn`, the panel leads with its own "Show structure" switch (the rail's flyout); without, it is only the settings. */
  on?: boolean;
  onOn?: (on: boolean) => void;
};

/** The structure layer: order blocks (and breakers), fair value gaps, breaks of structure, trend marks
 * and rejection-confirmed setups, detected on whichever timeframes are ticked, independently of the
 * interval on screen. Off until at least one timeframe is chosen. */
export function StructurePanel({ config, onChange, on, onOn }: PanelProps) {
  const toggleTf = (tf: string) => onChange({ ...config, tfs: config.tfs.includes(tf) ? config.tfs.filter((t) => t !== tf) : [...config.tfs, tf] });
  const flag = (key: "breakers" | "fvg" | "breaks" | "trendMarks" | "setups", label: string, hint: string) => (
    <label className="check menu-check" key={key}>
      <input type="checkbox" checked={config[key]} onChange={(e) => onChange({ ...config, [key]: e.target.checked })} />
      <span>
        {label}
        <span className="faint" style={{ display: "block", fontSize: 12 }}>
          {hint}
        </span>
      </span>
    </label>
  );

  const settings = (
    <>
      <div className="menu-heading">Detect on</div>
      <div className="chips" role="group" aria-label="Detection timeframes" style={{ marginBottom: 10 }}>
        {STRUCTURE_TIMEFRAMES.map((t) => (
          <button key={t.value} aria-pressed={config.tfs.includes(t.value)} onClick={() => toggleTf(t.value)}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }}>
        Order blocks are drawn on every timeframe you tick. Pick none to switch the layer off.
      </p>
      {flag("breakers", "Breaker blocks", "Order blocks that failed and flipped")}
      {flag("fvg", "Fair value gaps", "Price gaps left by fast moves")}
      {flag("breaks", "BOS and CHoCH", "Where structure broke, and where the trend changed character")}
      {flag("trendMarks", "Trend marks", "Where the confirmed trend flipped")}
      {flag("setups", "Setups", "Rejection-confirmed entries with stop and target")}
    </>
  );

  return (
    <>
      {onOn && (
        <label className="check menu-check" title="Order blocks, fair value gaps, BOS/CHoCH, trend marks and setups">
          <input type="checkbox" checked={on === true} onChange={(e) => onOn(e.target.checked)} />
          <span>Show structure</span>
        </label>
      )}
      {onOn && !on ? (
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          Switch it on to see order blocks and structure breaks. It starts on this chart's own interval.
        </p>
      ) : (
        settings
      )}
    </>
  );
}

/** The same panel as a top-bar dropdown (a phone has no rail), shown once the layer is on. */
export function StructureMenu({ config, onChange }: { config: StructureConfig; onChange: (c: StructureConfig) => void }) {
  return (
    <Popover label="Structure" badge={config.tfs.length}>
      <StructurePanel config={config} onChange={onChange} />
    </Popover>
  );
}
