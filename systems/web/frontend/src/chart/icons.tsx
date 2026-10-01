import type { ReactNode } from "react";

const props = { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

const wrap = (children: ReactNode) => <svg {...props}>{children}</svg>;

export const CursorIcon = () => wrap(<path d="M5 3l14 8-6 2-2 6z" />);
export const TrendLineIcon = () => wrap(<><path d="M4 18L20 6" /><circle cx="4" cy="18" r="1.6" /><circle cx="20" cy="6" r="1.6" /></>);
export const RayIcon = () => wrap(<><path d="M4 17L21 7" /><circle cx="4" cy="17" r="1.6" /><path d="M17 5l4 2-2 4" /></>);
export const HLineIcon = () => wrap(<><path d="M3 12h18" /><circle cx="12" cy="12" r="1.6" /></>);
export const PriceLineIcon = () => wrap(<><path d="M3 12h13" /><path d="M16 8h5v8h-5l-2-4z" /></>);
export const ChannelIcon = () => wrap(<><path d="M4 15L18 7" /><path d="M6 20L20 12" /></>);
export const ZoneIcon = () => wrap(<rect x="4" y="7" width="16" height="10" rx="1" />);
export const FibIcon = () => wrap(<><path d="M3 5h18" /><path d="M3 10h18" /><path d="M3 15h18" /><path d="M3 20h18" /></>);
export const TextIcon = () => wrap(<><path d="M5 6V4h14v2" /><path d="M12 4v16" /><path d="M9 20h6" /></>);
/** A small picture of a chart grid: 1x1 one chart, 2x1 two side by side (two columns), 1x2 two stacked (two rows). */
export const GridIcon = ({ cols, rows }: { cols: 1 | 2; rows: 1 | 2 }) => {
  const gap = 2;
  const x0 = 3;
  const y0 = 4;
  const w = 18;
  const h = 16;
  const cw = (w - gap * (cols - 1)) / cols;
  const ch = (h - gap * (rows - 1)) / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push(<rect key={`${r}${c}`} x={x0 + c * (cw + gap)} y={y0 + r * (ch + gap)} width={cw} height={ch} rx="1.5" />);
  return wrap(<>{cells}</>);
};
export const OiLevelsIcon = () => wrap(<><path d="M3 6h18" /><path d="M3 18h18" /><path d="M8 10v4M12 9v6M16 10v4" /></>);
export const TradesIcon = () => wrap(<><path d="M12 5l5.5 8h-11z" /><path d="M4 18h16" /></>);
export const PriceTagIcon = () => wrap(<><path d="M4 12l8-8h8v8l-8 8z" /><circle cx="16" cy="8" r="1.3" /></>);
export const TicketPanelIcon = () => wrap(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>);
export const IndicatorsIcon = () => wrap(<><path d="M3 17l5-6 4 3 5-8 4 5" /><path d="M3 21h18" /></>);
export const StructureIcon = () => wrap(<><rect x="4" y="4" width="16" height="5" rx="1" /><rect x="4" y="11" width="10" height="4" rx="1" /><rect x="4" y="17" width="14" height="3" rx="1" /></>);
export const OiStripIcon = () => wrap(<><rect x="3" y="7" width="18" height="10" rx="2" /><path d="M7 14v-2M11 14v-4M15 14v-3" /></>);
export const SparkleIcon = () => wrap(<><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></>);
export const MagnetIcon = () => wrap(<><path d="M6 4v8a6 6 0 0012 0V4" /><path d="M6 8h4M14 8h4" /></>);
export const EyeIcon = () => wrap(<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const EyeOffIcon = () => wrap(<><path d="M3 3l18 18" /><path d="M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3 3.6M6.6 6.6A16 16 0 002 12s4 7 10 7c1.6 0 3-.4 4.3-1" /></>);
export const TrashIcon = () => wrap(<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>);
export const XIcon = () => wrap(<path d="M6 6l12 12M18 6L6 18" />);
export const ExpandIcon = () => wrap(<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>);

const small = { ...props, width: 13, height: 13 } as const;
/** A small sparkle: "suggest a price for me". */
export const SparkIcon = () => (
  <svg {...small}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </svg>
);
/** A small crosshair: "pick the price on the chart". */
export const CrosshairIcon = () => (
  <svg {...small}>
    <circle cx="12" cy="12" r="6" />
    <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
  </svg>
);
