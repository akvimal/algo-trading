import type { ReactNode } from "react";

// Small icons for badges and status marks: the chart icons' stroke style at 14px. They are decoration (aria-hidden): the badge's text, or the
// status's own accessible name, says the same thing, so an icon is never the only signal.
const svg = (children: ReactNode, size = 14) => (
  <svg className="badge-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export const TrendingIcon = () => svg(<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>);
export const RangingIcon = () => svg(<><path d="M3 8h18" /><path d="M3 16h18" /><path d="M8 12h8" /></>);
export const PullbackIcon = () => svg(<path d="M3 19l5-10 4 5 3-4 6-8" />);
export const BreakoutIcon = () => svg(<><path d="M3 12h18" /><path d="M12 21V7" /><path d="M8 11l4-4 4 4" /></>);
export const ReversalIcon = () => svg(<><path d="M7 21V10a5 5 0 0110 0v5" /><path d="M13 12l4 4 4-4" /></>);
export const BuyIcon = () => svg(<path d="M12 5l7 13H5z" />);
export const SellIcon = () => svg(<path d="M12 19L5 6h14z" />);
export const BoltIcon = () => svg(<path d="M13 3L5 14h6l-1 7 8-11h-6z" />);
export const ClockIcon = () => svg(<><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>);
export const FutureIcon = () => svg(<><path d="M7 4v16" /><path d="M17 4v16" /><rect x="5" y="9" width="4" height="6" /><rect x="15" y="7" width="4" height="8" /></>);
export const OptionIcon = () => svg(<><circle cx="12" cy="12" r="7" /><path d="M12 8v8M8 12h8" /></>);
export const SpreadIcon = () => svg(<><circle cx="8" cy="12" r="5" /><circle cx="16" cy="12" r="5" /></>);
export const CheckIcon = () => svg(<path d="M5 12l5 5 9-10" />);
export const WarnIcon = () => svg(<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.2v.1" /></>);
export const CrossIcon = () => svg(<path d="M6 6l12 12M18 6L6 18" />);
