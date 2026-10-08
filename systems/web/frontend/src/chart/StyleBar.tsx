import type { SelectionInfo } from "./alerts";
import { TEXT_DRAWING_MAX } from "./config";
import { DASHES, FILLS, SWATCHES, TEXT_SIZES, WIDTHS, styleKindOf, type DrawingStyle } from "./drawingStyle";

type Props = {
  /** The selected drawing on the active chart, or null when nothing is selected. */
  selection: SelectionInfo | null;
  onStyle: (patch: DrawingStyle) => void;
  onReset: () => void;
  onDefault: (on: boolean) => void;
  /** Set the selected line, ray, level or zone's label (empty removes it). */
  onLabel: (text: string) => void;
};

/** What a new drawing of each kind is called in "Use for new ...". */
const PLURAL: Record<string, string> = {
  segment: "trend lines",
  rayLine: "rays",
  horizontalStraightLine: "horizontal lines",
  priceLine: "price levels",
  parallelStraightLine: "channels",
  rect: "zones",
  fibonacciLine: "Fibonacci retracements",
  textNote: "text labels",
};

/** The look of the selected drawing: colour, thickness, solid/dashed/dotted, a zone's fill, a label's size and weight.
 * Each choice applies at once and is saved with the drawing; "Use for new ..." makes the look the starting point for the
 * next drawing of the same kind. Shown only while a drawing is selected. */
export function StyleBar({ selection, onStyle, onReset, onDefault, onLabel }: Props) {
  const look = selection?.look;
  if (!look) return null;
  const kind = styleKindOf(look.name);
  const s = look.style;
  const changed = Object.keys(s).length > 0;
  const plural = PLURAL[look.name] ?? "drawings";
  return (
    <div className="ws-style" role="group" aria-label="Drawing style" data-testid="style-bar">
      <span className="faint">Style</span>

      <div className="style-group" role="group" aria-label="Colour">
        {SWATCHES.map((c) => (
          <button key={c.value} className="swatch" style={{ background: c.value }} aria-label={`Colour ${c.label}`} aria-pressed={s.color === c.value} title={c.label} onClick={() => onStyle({ color: c.value })} />
        ))}
        <input className="swatch-custom" type="color" aria-label="Custom colour" title="Any colour" value={s.color ?? "#4cc2ff"} onChange={(e) => onStyle({ color: e.target.value })} />
      </div>

      {kind !== "text" && (
        <div className="chips" role="group" aria-label="Thickness">
          {WIDTHS.map((w) => (
            <button key={w} aria-pressed={s.width === w} aria-label={`Thickness ${w}`} onClick={() => onStyle({ width: w })}>
              {w}
            </button>
          ))}
        </div>
      )}
      {kind !== "text" && (
        <div className="chips" role="group" aria-label="Line style">
          {DASHES.map((d) => (
            <button key={d.value} aria-pressed={s.dash === d.value} onClick={() => onStyle({ dash: d.value })}>
              {d.label}
            </button>
          ))}
        </div>
      )}
      {kind === "zone" && (
        <button className="chip-btn" aria-pressed={s.noMid !== true} title="A dashed line at the zone's 50% level" onClick={() => onStyle({ noMid: s.noMid ? undefined : true })}>
          Midline
        </button>
      )}
      {kind === "zone" && (
        <div className="chips" role="group" aria-label="Fill">
          {FILLS.map((f) => (
            <button key={f.value} aria-pressed={s.fill === f.value} onClick={() => onStyle({ fill: f.value })}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {kind === "text" && (
        <>
          <div className="chips" role="group" aria-label="Text size">
            {TEXT_SIZES.map((t) => (
              <button key={t.value} aria-pressed={s.textSize === t.value} onClick={() => onStyle({ textSize: t.value })}>
                {t.label}
              </button>
            ))}
          </div>
          <button className="chip-btn" aria-pressed={s.bold !== false} onClick={() => onStyle({ bold: s.bold === false })}>
            Bold
          </button>
        </>
      )}

      {kind !== "text" && (
        <input
          key={`${look.name}:${selection.level ?? ""}:${selection.label ?? ""}`}
          className="style-label"
          aria-label="Label on the drawing"
          placeholder="Label (Enter)"
          maxLength={TEXT_DRAWING_MAX}
          defaultValue={selection.label ?? ""}
          onKeyDown={(e) => {
            e.stopPropagation(); // typing must not trigger the chart's own keys (Delete removes a drawing)
            if (e.key === "Enter") onLabel(e.currentTarget.value);
          }}
          onBlur={(e) => {
            if (e.currentTarget.value.trim() !== (selection.label ?? "")) onLabel(e.currentTarget.value);
          }}
        />
      )}

      <button className="link-btn" disabled={!changed} onClick={onReset}>
        Reset look
      </button>
      {look.hasDefault ? (
        <button className="link-btn" onClick={() => onDefault(false)}>
          Clear default for {plural}
        </button>
      ) : (
        <button className="link-btn" disabled={!changed} onClick={() => onDefault(true)} title="New drawings of this kind will start with this look">
          Use for new {plural}
        </button>
      )}
    </div>
  );
}
