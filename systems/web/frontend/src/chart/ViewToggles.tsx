import type { ReactNode } from "react";
import { OiLevelsIcon, PriceTagIcon, TicketPanelIcon, TradesIcon } from "./icons";

type TicketProps = { open: boolean; onToggle: (open: boolean) => void };

type Props = {
  tradesOn: boolean;
  onTradesOn: (on: boolean) => void;
  oiLevelsOn: boolean;
  onOiLevelsOn: (on: boolean) => void;
  priceShown: boolean;
  onPriceShown: (on: boolean) => void;
  /** Omitted on a phone: the ticket there is always shown, so there is nothing to toggle. */
  ticket?: TicketProps;
};

function Toggle({ on, onChange, label, hint, icon }: { on: boolean; onChange: (on: boolean) => void; label: string; hint: string; icon: ReactNode }) {
  return (
    <button className="tool" aria-pressed={on} aria-label={label} title={`${hint} (${on ? "on" : "off"})`} onClick={() => onChange(!on)}>
      {icon}
    </button>
  );
}

/** What the chart screen shows, as icon switches at the end of the top bar: the option-chain levels on the chart, your
 * own trades, the live price in each chart's header, and (on a wide screen) the order ticket. Each says what it is in
 * its name and tooltip and shows whether it is on by being highlighted. */
export function ViewToggles({ tradesOn, onTradesOn, oiLevelsOn, onOiLevelsOn, priceShown, onPriceShown, ticket }: Props) {
  return (
    <div className="view-toggles" role="group" aria-label="View">
      <Toggle on={oiLevelsOn} onChange={onOiLevelsOn} label="OI levels" hint="Support and resistance from option open interest (indices, gold, crude, Bitcoin, Ether)" icon={<OiLevelsIcon />} />
      <Toggle on={tradesOn} onChange={onTradesOn} label="My trades" hint="Your own trades on the chart" icon={<TradesIcon />} />
      <Toggle on={priceShown} onChange={onPriceShown} label="Price in header" hint="The live price and its dot in each chart's own header" icon={<PriceTagIcon />} />
      {ticket && <Toggle on={ticket.open} onChange={ticket.onToggle} label="Show ticket" hint="The order ticket panel" icon={<TicketPanelIcon />} />}
    </div>
  );
}
