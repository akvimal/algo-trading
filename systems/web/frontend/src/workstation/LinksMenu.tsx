import { Popover } from "../chart/Popover";

type Props = {
  crosshair: boolean;
  onCrosshair: (on: boolean) => void;
  scale: boolean;
  onScale: (on: boolean) => void;
  interval: boolean;
  onInterval: (on: boolean) => void;
};

/** Whether (and how) the two charts in Side by side/Stacked stay in step - folded into one popover
 * instead of three always-visible checkboxes taking their own row above the charts, only ever
 * relevant with two panes on screen (the caller renders this only when `twoUp`). */
export function LinksMenu({ crosshair, onCrosshair, scale, onScale, interval, onInterval }: Props) {
  const badge = [crosshair, scale, interval].filter(Boolean).length;
  return (
    <Popover label="Sync" badge={badge}>
      <label className="check menu-check">
        <input type="checkbox" checked={crosshair} onChange={(e) => onCrosshair(e.target.checked)} />
        <span>Sync crosshair</span>
      </label>
      <label className="check menu-check">
        <input type="checkbox" checked={scale} onChange={(e) => onScale(e.target.checked)} />
        <span>Sync scrolling and zoom</span>
      </label>
      <label className="check menu-check">
        <input type="checkbox" checked={interval} onChange={(e) => onInterval(e.target.checked)} />
        <span>Same interval</span>
      </label>
    </Popover>
  );
}
