import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/http";
import { getAccounts } from "../api/settings";
import { cancelWaitingOrder, getCandles, getLtp, getRegime, listWaitingOrders, resolveUnderlying } from "../api/trade";
import type { OptionGroup, Position } from "../api/types";
import { CandleChart, type ChartLine } from "../components/CandleChart";
import { ErrorNotice, Skeleton } from "../components/bits";
import { TradeTicket } from "../components/TradeTicket";
import { CLASSIC_APP_URL } from "../config";
import { formatPrice } from "../format";
import { useResource } from "../hooks/useResource";
import { dayPnl } from "./todayModel";
import { EMPTY_TICKET, INTERVALS, PRESETS, analyzeTicket, instrumentFor, parseTradeParams, type IntervalId, type Ticket } from "./tradeModel";

export function TradePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { symbol, segment } = parseTradeParams(params.get("symbol"), params.get("segment"));
  const [interval, setIntervalId] = useState<IntervalId>("15min");
  const [ticket, setTicket] = useState<Ticket>(EMPTY_TICKET);
  const [search, setSearch] = useState("");

  // A different instrument is a different trade: start the ticket clean.
  useEffect(() => setTicket(EMPTY_TICKET), [symbol, segment]);

  const meta = INTERVALS.find((i) => i.id === interval)!;
  const resolved = useResource(() => resolveUnderlying(segment, symbol), [segment, symbol]);
  const chartEx = resolved.data?.chart_exchange;
  const chartSym = resolved.data?.chart_symbol;
  const ready = Boolean(chartEx && chartSym);

  const ltp = useResource(() => getLtp(chartEx!, chartSym!), [chartEx, chartSym], { pollMs: 5_000, enabled: ready });
  const candles = useResource(() => getCandles(chartEx!, chartSym!, interval, meta.days), [chartEx, chartSym, interval], { pollMs: 30_000, enabled: ready });
  const regime = useResource(() => getRegime(chartEx!, chartSym!, interval), [chartEx, chartSym, interval], { pollMs: 60_000, enabled: ready });
  const accounts = useResource(getAccounts, []);
  const waiting = useResource(listWaitingOrders, [], { pollMs: 15_000 });
  const today = useResource(
    async () => {
      const [positions, groups] = await Promise.all([
        api<Position[]>("execution", `/positions?segment=${segment}&limit=200`),
        api<OptionGroup[]>("execution", `/option-groups?segment=${segment}&limit=200`),
      ]);
      return dayPnl(positions, groups);
    },
    [segment],
  );

  const account = accounts.data?.find((a) => a.segment === segment);
  const price = ltp.data?.ltp ?? null;
  const instrument = instrumentFor(symbol, segment);
  const ctx = account
    ? {
        price, lotSize: resolved.data?.lot_size ?? 1, capital: account.capital_per_trade, riskPct: account.risk_per_trade_pct,
        minRR: account.min_reward_risk_ratio, requireStop: account.require_stop_loss, segment, symbol,
      }
    : null;

  const a = ctx ? analyzeTicket(ticket, ctx) : null;
  const lines: ChartLine[] = [];
  if (price != null) lines.push({ price, label: "Now", tone: "live" });
  if (a) {
    if (ticket.orderType === "limit" && a.entry != null) lines.push({ price: a.entry, label: "Entry", tone: "entry" });
    if (a.stop != null) lines.push({ price: a.stop, label: "Stop", tone: "stop" });
    if (a.target != null) lines.push({ price: a.target, label: "Target", tone: "target" });
  }

  function go(e: FormEvent) {
    e.preventDefault();
    const s = search.trim();
    if (s) navigate(`/trade?symbol=${encodeURIComponent(s.toUpperCase())}&segment=NSE`);
    setSearch("");
  }

  const mine = waiting.data?.filter((w) => w.symbol === symbol) ?? [];
  const live = account?.live_trading_enabled;

  return (
    <div className="stack">
      <h1>Trade</h1>
      <div className="chips" role="group" aria-label="Instrument">
        {PRESETS.map((p) => (
          <button key={p.symbol} aria-pressed={symbol === p.symbol} onClick={() => navigate(`/trade?symbol=${p.symbol}&segment=${p.segment}`)}>
            {p.label}
          </button>
        ))}
      </div>
      <form onSubmit={go} className="row" style={{ gap: 8 }}>
        <label className="select-field" style={{ flex: 1 }}>
          <span className="dim">Or trade a stock</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. RELIANCE" autoComplete="off" />
        </label>
        <button className="btn" style={{ alignSelf: "flex-end" }} type="submit" disabled={!search.trim()}>
          Go
        </button>
      </form>

      <div className="card">
        <div className="row" style={{ alignItems: "baseline" }}>
          <strong style={{ fontSize: 18 }}>{symbol}</strong>
          <span className="num" style={{ fontSize: 22, fontWeight: 600 }} data-testid="price">
            {price == null ? "–" : formatPrice(price)}
          </span>
        </div>
        {resolved.error && <ErrorNotice error={resolved.error} onRetry={resolved.reload} />}
        {ltp.error && <ErrorNotice error={ltp.error} onRetry={ltp.reload} />}
        <div className="chips" role="group" aria-label="Candle size" style={{ margin: "10px 0" }}>
          {INTERVALS.map((i) => (
            <button key={i.id} aria-pressed={interval === i.id} onClick={() => setIntervalId(i.id)}>
              {i.label}
            </button>
          ))}
        </div>
        {candles.loading && ready && <Skeleton lines={4} />}
        {candles.error && !candles.data && <ErrorNotice error={candles.error} onRetry={candles.reload} />}
        {candles.data && <CandleChart candles={candles.data} lines={lines} intraday={interval !== "60min"} />}
        <p className="faint" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Structure zones and drawing tools are in the <a href={CLASSIC_APP_URL}>classic chart</a>.
        </p>
      </div>

      {accounts.loading && <Skeleton lines={5} />}
      {accounts.error && !accounts.data && <ErrorNotice error={accounts.error} onRetry={accounts.reload} />}
      {live && (
        <div className="notice error" role="alert">
          <strong>Your {segment} account is set to live trading.</strong>
          <p style={{ margin: "6px 0 0" }}>
            Orders here would use real money, so this ticket is paper-only for now. Place live orders in the <a href={CLASSIC_APP_URL}>classic app</a>, or switch back to paper in{" "}
            <Link to="/more/settings?tab=broker">Settings</Link>.
          </p>
        </div>
      )}
      {ctx && !live && (
        <TradeTicket
          ticket={ticket}
          onChange={setTicket}
          ctx={ctx}
          meta={{ instrument, interval, trendFollowed: regime.data ? (regime.data.trend === "up") === (ticket.action === "BUY") && regime.data.trend !== "range" : false }}
          regime={regime.data}
          budget={account?.max_daily_loss != null && today.data ? { limit: account.max_daily_loss, lostToday: Math.max(0, -today.data.realized) } : null}
          onPlaced={() => {
            waiting.reload();
            today.reload();
          }}
        />
      )}

      {mine.length > 0 && (
        <>
          <h2 className="section-title">Waiting for a price</h2>
          <div className="card" data-testid="waiting">
            {mine.map((w) => (
              <div className="list-row" key={w.id}>
                <span>
                  <span className={`pill ${w.action === "BUY" ? "up" : "dn"}`}>{w.action}</span> {w.symbol} at <span className="num">{formatPrice(w.trigger_price)}</span>
                  <span className="faint" style={{ display: "block", fontSize: 12 }}>
                    {w.stop_loss_price != null ? `stop ${formatPrice(w.stop_loss_price)}` : "no stop"}
                    {w.target_price != null ? ` · target ${formatPrice(w.target_price)}` : ""}
                  </span>
                </span>
                <button className="btn btn-small" onClick={() => void cancelWaitingOrder(w.id).catch(() => undefined).finally(() => waiting.reload())}>
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
