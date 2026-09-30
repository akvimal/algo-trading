import { useState } from "react";
import { Link } from "react-router-dom";
import { getAccounts } from "../api/settings";
import { getRegime } from "../api/trade";
import { useProfile } from "../auth/ProfileContext";
import { Skeleton } from "../components/bits";
import { TradeTicket } from "../components/TradeTicket";
import { useResource } from "../hooks/useResource";
import { ScanOptionBias } from "./ScanOptionBias";
import { EMPTY_TICKET, instrumentFor, type Action, type DefaultOptionStrategy, type Ticket } from "./tradeModel";
import { useScanLivePrice } from "./useScanLivePrice";

// The regime read is for the ticket's own "before you place" checks, not for the chart (which has
// no notion of a single interval here) - a fixed, sensible-for-intraday size, independent of
// whatever candle size ScanChartPanel's own switch happens to be on.
const REGIME_INTERVAL = "15min";

type Props = {
  exchange: string;
  symbol: string;
  /** Bullish/Bearish to start the ticket on - the OI-buildup card's own call/put reading (see
   * scanModel.ts's defaultViewFromOi), not a fixed default. Still just a starting point: the
   * Bullish/Bearish chips inside change it with one click either way. */
  defaultView: Action;
};

/** A fresh ticket for this card - always starting on Option (every OI-buildup row has an option
 * chain by definition, not just the PRESETS index/commodity/crypto handful emptyTicketFor's own
 * optionsAvailable(symbol) check knows about, so that helper isn't used here - it would silently
 * fall back to Future for a plain stock symbol), and on whatever view the OI buildup itself
 * suggests. The Spot/Option chips below still let a person switch to Spot if that's what they
 * actually want. Lots starts at 1, not EMPTY_TICKET's own "" ("size it from my risk", a spot-
 * order concept) - options are always sized by lots directly, set once here rather than via a
 * mount effect in ScanOptionBias.tsx, which would race the same component's own chain-loaded
 * reset effects (both derived from the same pre-update `t` closure on the first render). */
const initialTicket = (defaultOptionStrategy: DefaultOptionStrategy, defaultView: Action): Ticket => ({
  ...EMPTY_TICKET,
  strategy: defaultOptionStrategy,
  action: defaultView,
  lots: "1",
});

/** The order ticket inside an expanded OI-buildup card (ScanPage.tsx's OiCard) - fed from this
 * card's own account/price/regime reads instead of the workstation's, and its own view into an
 * option order: a Spot/Option choice here, then (for Option) ScanOptionBias's Bullish/Bearish
 * picker instead of the Trade page's Future/Option/Option spread chips and a bare moneyness
 * dropdown - see that component's own docstring for why. Placing itself still goes through the
 * real TradeTicket (stop-loss/target/lots/checks/submit) - reusing proven sizing/validation, not
 * duplicating it, is the point; only the strategy-selection step needed rethinking. Paper-only,
 * same as TradeTicket itself - an account with live trading on gets the same notice the Trade
 * page shows instead of a ticket reaching for real money from inside a scan card. */
export function ScanTradePanel({ exchange, symbol, defaultView }: Props) {
  const { defaultOptionStrategy } = useProfile();
  const accounts = useResource(getAccounts, []);
  const { price } = useScanLivePrice(exchange, symbol);
  const regime = useResource(() => getRegime(exchange, symbol, REGIME_INTERVAL), [exchange, symbol]);
  const [ticket, setTicket] = useState<Ticket>(() => initialTicket(defaultOptionStrategy, defaultView));

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

  return (
    <>
      <div className="chips" role="group" aria-label="Instrument" style={{ marginBottom: 12 }}>
        <button aria-pressed={!isOption} onClick={() => setTicket((cur) => ({ ...cur, strategy: "future" }))}>
          Spot
        </button>
        <button aria-pressed={isOption} onClick={() => setTicket((cur) => (cur.strategy === "future" ? { ...cur, strategy: defaultOptionStrategy } : cur))}>
          Option
        </button>
      </div>
      {isOption && <ScanOptionBias exchange={exchange} symbol={symbol} ticket={ticket} onChange={setTicket} />}
      <TradeTicket
        ticket={ticket}
        onChange={setTicket}
        ctx={ctx}
        meta={{ instrument: instrumentFor(symbol, "NSE"), interval: REGIME_INTERVAL, trendFollowed }}
        regime={regime.data}
        budget={null}
        optionsForced
        hideStrategyChips
        hideMoneynessField={isOption}
        hideOptionExtras={isOption}
        onPlaced={() => setTicket(initialTicket(defaultOptionStrategy, defaultView))}
      />
    </>
  );
}
