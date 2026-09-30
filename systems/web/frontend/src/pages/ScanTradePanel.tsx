import { useState } from "react";
import { Link } from "react-router-dom";
import type { Segment } from "../api/types";
import { getAccounts } from "../api/settings";
import { getOpenOptionGroupsFor, getOpenPositionsFor, getRegime } from "../api/trade";
import { useProfile } from "../auth/ProfileContext";
import { Skeleton } from "../components/bits";
import { PositionCard } from "../components/PositionCard";
import { TradeTicket } from "../components/TradeTicket";
import { useResource } from "../hooks/useResource";
import { ScanOptionBias } from "./ScanOptionBias";
import { EMPTY_TICKET, emptyTicketFor, instrumentFor, optionsAvailable, type Action, type DefaultInstrument, type DefaultOptionStrategy, type Ticket } from "./tradeModel";
import { useScanLivePrice } from "./useScanLivePrice";

// The regime read is for the ticket's own "before you place" checks, not for the chart (which has
// no notion of a single interval here) - a fixed, sensible-for-intraday size, independent of
// whatever candle size ScanChartPanel's own switch happens to be on.
const REGIME_INTERVAL = "15min";

type Props = {
  exchange: string;
  symbol: string;
  /** OI-buildup only: every row there has a real option chain by definition (the scan itself is
   * built from option-chain data), so the ticket always starts on Option, with Bullish/Bearish
   * defaulted from the card's own call/put reading (scanModel.ts's defaultViewFromOi) - still just
   * a starting point, the Bullish/Bearish chips inside change it with one click either way.
   * Omitted for Screener/Custom, where a row's own F&O eligibility isn't known - the ticket starts
   * on whatever the person's own default_instrument preference says instead (optionsAvailable(symbol)-
   * gated, same as a fresh Trade-page ticket), plain Bullish. The Spot/Option chips below always
   * let a person switch either way regardless of how it started. */
  oiDefaultView?: Action;
};

/** A fresh ticket for this card. `oiDefaultView` set (OI buildup) always starts on Option, lots
 * defaulted to 1 (not EMPTY_TICKET's own "" - "size it from my risk", a spot-order concept -
 * since options are always sized by lots directly), and the given view; set once here rather than
 * via a mount effect in ScanOptionBias.tsx, which would race the same component's own chain-loaded
 * reset effects (both derived from the same pre-update `t` closure on the first render). Omitted
 * (Screener/Custom) uses emptyTicketFor's own PRESETS/default_instrument-gated starting point
 * instead - see this file's own Props docstring. */
function initialTicket(symbol: string, defaultInstrument: DefaultInstrument, defaultOptionStrategy: DefaultOptionStrategy, oiDefaultView?: Action): Ticket {
  if (oiDefaultView == null) return emptyTicketFor(symbol, defaultInstrument, defaultOptionStrategy);
  return { ...EMPTY_TICKET, strategy: defaultOptionStrategy, action: oiDefaultView, lots: "1" };
}

/** The order ticket inside an expanded Trade panel (ScanPage.tsx's OiCard/ScreenerCard/
 * CustomScreenCard) - fed from this card's own account/price/regime reads instead of the
 * workstation's, and its own view into an option order: a Spot/Option choice here, then (for
 * Option) ScanOptionBias's Bullish/Bearish picker instead of the Trade page's Future/Option/
 * Option spread chips and a bare moneyness dropdown - see that component's own docstring for why.
 * Whatever's already open on this symbol, on whichever side is selected, shows first (PositionCard,
 * compact - its own live status and a square-off), above the ticket - pyramiding is always allowed
 * for a manual order, so the ticket stays usable underneath rather than being replaced by the
 * existing position. Placing itself still goes through the real TradeTicket (stop-loss/target/
 * lots/checks/submit) - reusing proven sizing/validation, not duplicating it, is the point; only
 * the strategy-selection step needed rethinking. Paper-only, same as TradeTicket itself - an
 * account with live trading on gets the same notice the Trade
 * page shows instead of a ticket reaching for real money from inside a scan card. */
export function ScanTradePanel({ exchange, symbol, oiDefaultView }: Props) {
  const { defaultInstrument, defaultOptionStrategy } = useProfile();
  const accounts = useResource(getAccounts, []);
  const { price } = useScanLivePrice(exchange, symbol);
  const regime = useResource(() => getRegime(exchange, symbol, REGIME_INTERVAL), [exchange, symbol]);
  const [ticket, setTicket] = useState<Ticket>(() => initialTicket(symbol, defaultInstrument, defaultOptionStrategy, oiDefaultView));
  // Whatever's already open for this symbol, on whichever side (Spot/Option) is currently
  // selected below - shown above the ticket with its own live status and a square-off, per
  // PositionCard. Manual orders always allow pyramiding, so this can be more than one row; the
  // ticket itself stays available underneath for exactly that (adding to, not just viewing, what's
  // already open).
  const openPositions = useResource(() => getOpenPositionsFor(exchange as Segment, symbol), [exchange, symbol]);
  const openGroups = useResource(() => getOpenOptionGroupsFor(exchange as Segment, symbol), [exchange, symbol]);

  if (accounts.loading) return <Skeleton lines={5} />;
  if (accounts.error && !accounts.data) return null; // the card still works without a ticket; OiScan already shows the row itself

  const account = accounts.data?.find((a) => a.segment === exchange);
  if (!account) return null;

  if (account.live_trading_enabled) {
    return (
      <div className="notice error" role="alert">
        <strong>Your {exchange} account is set to live trading.</strong>
        <p style={{ margin: "6px 0 0" }}>
          Orders here would use real money, so this ticket is paper-only. Switch back to paper in <Link to="/more/settings?tab=broker">Settings</Link>.
        </p>
      </div>
    );
  }

  // Anything already open on this symbol (either side) - shown with its own live status and a
  // square-off. When there IS one, that's the whole panel: no Spot/Option toggle, no Bullish/
  // Bearish view, no ticket - a person watching an open position wants its status and a way to
  // close it, not another order form pushed below it. (Pyramiding still works from Portfolio's own
  // positions list; this panel just stops offering it inline.)
  const hasActive = (openPositions.data?.length ?? 0) + (openGroups.data?.length ?? 0) > 0;
  if (hasActive) {
    return (
      <>
        {(openPositions.data ?? []).map((p) => (
          <PositionCard key={p.id} kind="position" item={p} onChanged={() => openPositions.reload()} compact />
        ))}
        {(openGroups.data ?? []).map((g) => (
          <PositionCard key={g.id} kind="group" item={g} onChanged={() => openGroups.reload()} compact />
        ))}
      </>
    );
  }

  const ctx = {
    price,
    lotSize: 1, // every OI-buildup row is a plain NSE stock - shares, never a lot-sized contract
    capital: account.capital_per_trade,
    riskPct: account.risk_per_trade_pct,
    minRR: account.min_reward_risk_ratio,
    requireStop: account.require_stop_loss,
    segment: exchange as "NSE",
    symbol,
  };
  const trendFollowed = regime.data ? regime.data.trend !== "range" && (regime.data.trend === "up") === (ticket.action === "BUY") : false;
  const isOption = ticket.strategy !== "future";
  // OI-buildup rows are guaranteed real F&O (the scan itself is built from option-chain data);
  // Screener/Custom rows aren't, so fall back to optionsAvailable's own PRESETS check. When false,
  // a plain cash-equity stock: no Option side to switch to (the toggle stays hidden, strategy
  // stays "future"), and no Sell either - shorting a stock needs margin/derivatives this platform
  // doesn't offer, so only a long (BUY) position is ever placeable.
  const isFno = oiDefaultView != null || optionsAvailable(symbol);

  return (
    <>
      {isFno && (
        <div className="chips" role="group" aria-label="Instrument" style={{ marginBottom: 12 }}>
          <button aria-pressed={!isOption} onClick={() => setTicket((cur) => ({ ...cur, strategy: "future" }))}>
            Spot
          </button>
          <button aria-pressed={isOption} onClick={() => setTicket((cur) => (cur.strategy === "future" ? { ...cur, strategy: defaultOptionStrategy } : cur))}>
            Option
          </button>
        </div>
      )}
      {isFno && isOption && <ScanOptionBias exchange={exchange} symbol={symbol} ticket={ticket} onChange={setTicket} />}
      <TradeTicket
        ticket={ticket}
        onChange={setTicket}
        ctx={ctx}
        meta={{ instrument: instrumentFor(symbol, "NSE"), interval: REGIME_INTERVAL, trendFollowed }}
        regime={regime.data}
        budget={null}
        optionsForced
        hideStrategyChips
        hideSideChips={!isFno}
        hideMoneynessField={isOption}
        hideOptionExtras={isOption}
        onPlaced={() => {
          setTicket(initialTicket(symbol, defaultInstrument, defaultOptionStrategy, oiDefaultView));
          openPositions.reload();
          openGroups.reload();
        }}
      />
    </>
  );
}
