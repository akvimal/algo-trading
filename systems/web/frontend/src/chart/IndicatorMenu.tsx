import { useState } from "react";
import { INDICATORS, effectiveParams, parseParamList } from "./config";
import { Popover } from "./Popover";

type Props = {
  selected: string[];
  onSelected: (names: string[]) => void;
  params: Record<string, number[]>;
  onParams: (p: Record<string, number[]>) => void;
  hidden: boolean;
  onHidden: (h: boolean) => void;
  /** The structure layer's own on/off, as a quick switch beside "Hide all indicators" - only offered where Structure
   * has no menu of its own (a phone); on a wide screen it has its own button on the rail. Turning it back on seeds a
   * single fresh timeframe (the active chart's own interval) rather than restoring a stale accumulated list. */
  structureOn?: boolean;
  onStructureOn?: (on: boolean) => void;
};

/** Which indicators are on the chart, and their numbers. Indicators that draw on the price pane sit
 * first; the rest each get a pane of their own beneath. "Hide all" keeps the choices but clears the chart. */
export function IndicatorsPanel({ selected, onSelected, params, onParams, hidden, onHidden, structureOn, onStructureOn }: Props) {
  const toggle = (name: string) => onSelected(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  return (
    <>
      <label className="check menu-check">
        <input type="checkbox" checked={hidden} onChange={(e) => onHidden(e.target.checked)} />
        <span>Hide all indicators</span>
      </label>
      {onStructureOn && (
        <label className="check menu-check" title="Order blocks, FVGs, BOS/CHoCH, trend marks and setups - the Structure dropdown itself shows once this is on">
          <input type="checkbox" checked={structureOn === true} onChange={(e) => onStructureOn(e.target.checked)} />
          <span>Structure</span>
        </label>
      )}
      <div className="menu-list">
        {INDICATORS.map((ind) => (
          <div key={ind.name} className="menu-row">
            <label className="check menu-check">
              <input type="checkbox" checked={selected.includes(ind.name)} onChange={() => toggle(ind.name)} />
              <span>{ind.label}</span>
            </label>
            {ind.params && selected.includes(ind.name) && <ParamBox name={ind.name} value={effectiveParams(ind.name, params) ?? []} onCommit={(v) => onParams({ ...params, [ind.name]: v })} />}
          </div>
        ))}
      </div>
    </>
  );
}

/** The same panel as a top-bar dropdown (a phone has no rail). */
export function IndicatorMenu(props: Props) {
  return (
    <Popover label="Indicators" badge={props.selected.length}>
      <IndicatorsPanel {...props} />
    </Popover>
  );
}

/** A comma list of numbers. It is edited as text and applied on blur or Enter, so a half-typed value
 * (a 1 on the way to 14) never reaches the chart. */
function ParamBox({ name, value, onCommit }: { name: string; value: number[]; onCommit: (v: number[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  const commit = () => {
    const parsed = parseParamList(text);
    setText(parsed.join(", "));
    onCommit(parsed);
  };
  return (
    <input
      className="param-box"
      aria-label={`${name} settings`}
      value={text}
      inputMode="decimal"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}
