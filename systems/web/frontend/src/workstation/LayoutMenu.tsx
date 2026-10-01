import { Popover } from "../chart/Popover";
import { GridIcon } from "../chart/icons";
import type { Layout } from "./state";

/** The chart arrangements, named by their grid (columns x rows). */
export const LAYOUT_CHOICES: { id: Layout; grid: string; label: string; cols: 1 | 2; rows: 1 | 2 }[] = [
  { id: "single", grid: "1×1", label: "One chart", cols: 1, rows: 1 },
  { id: "side", grid: "2×1", label: "Side by side", cols: 2, rows: 1 },
  { id: "stack", grid: "1×2", label: "Stacked", cols: 1, rows: 2 },
];

/** How many charts, and how they are laid out: a dropdown whose button shows the current grid, and whose list shows each
 * arrangement as a small picture of the grid with its name. Picking one closes the list. */
export function LayoutMenu({ layout, onChange }: { layout: Layout; onChange: (layout: Layout) => void }) {
  const current = LAYOUT_CHOICES.find((l) => l.id === layout) ?? LAYOUT_CHOICES[0];
  return (
    <Popover label="Layout" icon={<GridIcon cols={current.cols} rows={current.rows} />} text={current.grid}>
      {(close) => (
        <div className="layout-list" role="radiogroup" aria-label="Chart layout">
          {LAYOUT_CHOICES.map((l) => (
            <button
              key={l.id}
              role="radio"
              aria-checked={l.id === layout}
              className="layout-option"
              onClick={() => {
                onChange(l.id);
                close();
              }}
            >
              <GridIcon cols={l.cols} rows={l.rows} />
              <span className="layout-grid">{l.grid}</span>
              <span className="faint">{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
