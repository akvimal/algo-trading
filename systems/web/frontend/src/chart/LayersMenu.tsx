import { Popover } from "./Popover";

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

/** The chart's own on/off layers — trades, OI levels, the header's live price, and (on a wide screen) the
 * ticket panel — folded into one compact menu instead of separate always-visible chips, so the toolbar has
 * room to breathe. Indicators and Structure keep their own menus: each already carries real per-item state
 * (which indicators, their numbers; which timeframes) that reads better as its own popover than a
 * section buried inside a bigger one. */
export function LayersMenu({ tradesOn, onTradesOn, oiLevelsOn, onOiLevelsOn, priceShown, onPriceShown, ticket }: Props) {
  const badge = [tradesOn, oiLevelsOn, !priceShown, ticket?.open].filter(Boolean).length;
  return (
    <Popover label="Layers" badge={badge}>
      <label className="check menu-check" title="Show your own trades on the chart">
        <input type="checkbox" checked={tradesOn} onChange={(e) => onTradesOn(e.target.checked)} />
        <span>My trades</span>
      </label>
      <label className="check menu-check" title="Support and resistance from option open interest (indices, gold, crude, Bitcoin, Ether)">
        <input type="checkbox" checked={oiLevelsOn} onChange={(e) => onOiLevelsOn(e.target.checked)} />
        <span>OI levels</span>
      </label>
      <label className="check menu-check" title="The live price and its dot in each chart's own header">
        <input type="checkbox" checked={priceShown} onChange={(e) => onPriceShown(e.target.checked)} />
        <span>Price in header</span>
      </label>
      {ticket && (
        <label className="check menu-check">
          <input type="checkbox" checked={ticket.open} onChange={(e) => ticket.onToggle(e.target.checked)} />
          <span>Show ticket</span>
        </label>
      )}
    </Popover>
  );
}
