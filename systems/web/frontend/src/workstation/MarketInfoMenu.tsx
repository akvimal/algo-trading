import { Popover } from "../chart/Popover";
import { MarketsPanel, type MarketSegment } from "../components/MarketsPanel";

/** The "Markets" chip in the Trade top bar (it reads NSE, MCX and crypto alike, opening on the active chart's market): the pre-market report and the
 * headline digest for the symbol on screen, one click away without leaving the chart. The tabs themselves live in `MarketsPanel`, shared with the
 * Today page's Markets card, so both show the same thing. Each tab loads only once opened. */
export function MarketInfoMenu({ segment, symbol, markets }: { segment: MarketSegment; symbol: string; markets: MarketSegment[] }) {
  return (
    <Popover label="Market info" text="Markets" buttonLabel="Market info: pre-market, news and calendar" align="right">
      <MarketsPanel key={`${segment}:${symbol}`} segment={segment} symbol={symbol} markets={markets} />
    </Popover>
  );
}
