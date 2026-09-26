import { STRUCTURE_TIMEFRAMES, type StructureConfig } from "./config";
import { Popover } from "./Popover";

/** The structure layer: order blocks (and breakers), fair value gaps, breaks of structure, trend marks
 * and rejection-confirmed setups, detected on whichever timeframes are ticked, independently of the
 * candle size on screen. Off until at least one timeframe is chosen. */
export function StructureMenu({ config, onChange }: { config: StructureConfig; onChange: (c: StructureConfig) => void }) {
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
  return (
    <Popover label="Structure" badge={config.tfs.length}>
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
    </Popover>
  );
}
