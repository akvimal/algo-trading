import { useState } from "react";
import { Link } from "react-router-dom";
import { getAccounts } from "../api/settings";
import { getRegime } from "../api/trade";
import { useProfile } from "../auth/ProfileContext";
import { Skeleton } from "../components/bits";
import { TradeTicket } from "../components/TradeTicket";
import { useResource } from "../hooks/useResource";
import { emptyTicketFor, instrumentFor, type Ticket } from "./tradeModel";
import { useScanLivePrice } from "./useScanLivePrice";

// The regime read is for the ticket's own "before you place" checks, not for the chart (which has
// no notion of a single interval here) - a fixed, sensible-for-intraday size, independent of
// whatever candle size ScanChartPanel's own switch happens to be on.
const REGIME_INTERVAL = "15min";

type Props = { exchange: string; symbol: string };

/** The order ticket inside an expanded OI-buildup card (ScanPage.tsx's OiCard) - the same
 * TradeTicket the Trade page uses (options included: every OI-buildup row has an option chain by
 * definition, so optionsForced skips the usual PRESETS-only check), just fed from this card's own
 * account/price/regime reads instead of the workstation's. Paper-only, same as TradeTicket itself
 * - an account with live trading on gets the same notice the Trade page shows instead of a ticket
 * reaching for real money from inside a scan card. */
export function ScanTradePanel({ exchange, symbol }: Props) {
  const { defaultInstrument, defaultOptionStrategy } = useProfile();
  const accounts = useResource(getAccounts, []);
  const { price } = useScanLivePrice(exchange, symbol);
  const regime = useResource(() => getRegime(exchange, symbol, REGIME_INTERVAL), [exchange, symbol]);
  const [ticket, setTicket] = useState<Ticket>(() => emptyTicketFor(symbol, defaultInstrument, defaultOptionStrategy));

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

  return (
    <TradeTicket
      ticket={ticket}
      onChange={setTicket}
      ctx={ctx}
      meta={{ instrument: instrumentFor(symbol, "NSE"), interval: REGIME_INTERVAL, trendFollowed }}
      regime={regime.data}
      budget={null}
      optionsForced
      onPlaced={() => setTicket(emptyTicketFor(symbol, defaultInstrument, defaultOptionStrategy))}
    />
  );
}
