import { Popover } from "../chart/Popover";
import { hasCombo, isActiveCombo, type Combo } from "./combos";
import { paneCount, type WorkstationState } from "./state";

type Props = {
  ws: WorkstationState;
  combos: Combo[];
  onApply: (combo: Combo) => void;
  onRemove: (id: string) => void;
  onSave: () => void;
};

/** Saved instrument pairs for the two-chart layouts - replaces the old single hardcoded
 * "NIFTY + BANKNIFTY" button. Applying one switches to a two-chart layout (or keeps the current
 * one, if already two-up); saving offers the two charts on screen right now, once they are showing
 * two different instruments and that exact pair is not already saved. */
export function CombosMenu({ ws, combos, onApply, onRemove, onSave }: Props) {
  const canSave = paneCount(ws) === 2 && ws.panes[0].symbol !== ws.panes[1].symbol && !hasCombo(combos, ws.panes[0], ws.panes[1]);
  return (
    <Popover label="Combos" badge={combos.length || undefined}>
      {combos.length === 0 && (
        <p className="faint" style={{ margin: "0 0 8px" }}>
          No saved combos yet.
        </p>
      )}
      {combos.map((c) => (
        <div className="menu-row" key={c.id}>
          <button type="button" className="link-btn" aria-pressed={isActiveCombo(ws, c)} title={`Show ${c.label} together, linked`} onClick={() => onApply(c)}>
            {c.label}
          </button>
          <button type="button" className="icon-btn" aria-label={`Remove ${c.label}`} onClick={() => onRemove(c.id)}>
            ✕
          </button>
        </div>
      ))}
      {canSave && (
        <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={onSave}>
          + Save {ws.panes[0].symbol} + {ws.panes[1].symbol}
        </button>
      )}
    </Popover>
  );
}
