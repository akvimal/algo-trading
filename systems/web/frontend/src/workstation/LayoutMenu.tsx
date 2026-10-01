import { Popover } from "../chart/Popover";
import { GridIcon } from "../chart/icons";
import type { Layout, Links } from "./state";

/** The chart arrangements, named by their grid (columns x rows). */
export const LAYOUT_CHOICES: { id: Layout; grid: string; label: string; cols: 1 | 2; rows: 1 | 2 }[] = [
  { id: "single", grid: "1×1", label: "One chart", cols: 1, rows: 1 },
  { id: "side", grid: "2×1", label: "Side by side", cols: 2, rows: 1 },
  { id: "stack", grid: "1×2", label: "Stacked", cols: 1, rows: 2 },
];

type Props = {
  layout: Layout;
  onChange: (layout: Layout) => void;
  /** Whether two charts are on screen: the sync switches only mean something then. */
  twoUp: boolean;
  links: Links;
  onLinks: (patch: Partial<Links>) => void;
};

const SYNC: { key: keyof Links; label: string }[] = [
  { key: "crosshair", label: "Sync crosshair" },
  { key: "scale", label: "Sync scrolling and zoom" },
  { key: "interval", label: "Same interval" },
];

/** How many charts, how they are laid out, and (with two) how they stay in step: a dropdown whose button shows the
 * current grid - with a count of the sync links that are on, when there are two charts - and whose list shows each
 * arrangement as a small picture of the grid, then the sync switches at the end. Picking an arrangement closes the list;
 * flipping a sync switch does not, so more than one can be changed at once. The switches are kept (greyed out) with one
 * chart, so they can be seen and are in place the moment a second chart is added. */
export function LayoutMenu({ layout, onChange, twoUp, links, onLinks }: Props) {
  const current = LAYOUT_CHOICES.find((l) => l.id === layout) ?? LAYOUT_CHOICES[0];
  const syncing = SYNC.filter((s) => links[s.key]).length;
  return (
    <Popover label="Layout" icon={<GridIcon cols={current.cols} rows={current.rows} />} text={current.grid} buttonLabel={current.grid} badge={twoUp ? syncing : undefined}>
      {(close) => (
        <>
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
          <div className="menu-divider" role="separator" />
          <div className="menu-heading">Sync charts</div>
          {SYNC.map((s) => (
            <label key={s.key} className="check menu-check">
              <input type="checkbox" checked={links[s.key]} disabled={!twoUp} onChange={(e) => onLinks({ [s.key]: e.target.checked })} />
              <span>{s.label}</span>
            </label>
          ))}
          {!twoUp && <p className="faint menu-note">Applies when two charts are showing.</p>}
        </>
      )}
    </Popover>
  );
}
