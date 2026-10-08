import { useState } from "react";
import { getNews } from "../api/news";
import { ApiError } from "../api/http";
import { Popover } from "../chart/Popover";
import { ErrorNotice, Skeleton } from "../components/bits";
import { PremarketCard } from "../components/PremarketCard";
import { CalendarTab } from "./CalendarTab";
import { useResource } from "../hooks/useResource";
import { BIAS_LABEL, nseSessionStarted, shortDate } from "../pages/premarketModel";

type Segment = "NSE" | "MCX" | "CRYPTO";
type Tab = "pulse" | "premarket" | "news" | "calendar";

const BIAS_PILL = { bullish: "pill up", bearish: "pill dn", neutral: "pill" } as const;

/** The "Markets" chip in the Trade top bar (it reads NSE, MCX and crypto alike, opening on the active chart's market): the pre-market report and the
 * headline digest for the symbol on screen, one click away without leaving the chart. Each segment has its own first
 * tab: NSE's morning pre-market report, an MCX pre-market read (COMEX metals, crude, the dollar, USD/INR) and a crypto
 * brief (coins, US risk, Fear & Greed). Both tabs load only once opened. */
export function MarketInfoMenu({ segment, symbol, markets }: { segment: Segment; symbol: string; markets: Segment[] }) {
  return (
    <Popover label="Market info" text="Markets" buttonLabel="Market info: pre-market, news and calendar" align="right">
      <MarketInfoBody key={`${segment}:${symbol}`} segment={segment} symbol={symbol} markets={markets} />
    </Popover>
  );
}

/** The symbol a market's News tab reads when that market is not the one on the chart. */
const DEFAULT_NEWS_SYMBOL: Record<Segment, string> = { NSE: "NIFTY", MCX: "GOLDM", CRYPTO: "BTCUSD" };
const SEGMENT_LABEL: Record<Segment, string> = { NSE: "NSE", MCX: "MCX", CRYPTO: "Crypto" };

function MarketInfoBody({ segment, symbol, markets }: { segment: Segment; symbol: string; markets: Segment[] }) {
  const [tab, setTab] = useState<Tab>(segment === "NSE" && nseSessionStarted() ? "pulse" : "premarket");
  // Opens on the market of the chart you are looking at; the pills read any other market without leaving the chart.
  const [view, setView] = useState<Segment>(segment);
  // NSE has three tabs: the live pulse (from the open), the morning report, and the news. A tab that does not exist for the market on show falls back to the first.
  const tabs: { id: Tab; label: string }[] = [
    ...(view === "NSE" ? [{ id: "pulse" as const, label: "Pulse" }] : []),
    { id: "premarket", label: view === "CRYPTO" ? "Brief" : "Pre-market" },
    { id: "news", label: "News" },
    { id: "calendar", label: "Calendar" },
  ];
  const shown: Tab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const choices = (["NSE", "MCX", "CRYPTO"] as const).filter((s) => markets.includes(s) || s === segment);
  const newsSymbol = view === segment ? symbol : DEFAULT_NEWS_SYMBOL[view];
  return (
    <div className="market-info">
      {choices.length > 1 && (
        <div className="chips" role="group" aria-label="Market">
          {choices.map((s) => (
            <button
              key={s}
              aria-pressed={view === s}
              onClick={() => {
                setView(s);
                if (s === "NSE" && nseSessionStarted()) setTab("pulse"); // the live read leads once the market is open
              }}
            >
              {SEGMENT_LABEL[s]}
            </button>
          ))}
        </div>
      )}
      <div className="chips" role="tablist" aria-label="Market info">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={shown === t.id} aria-pressed={shown === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {shown === "pulse" ? (
        <PremarketCard key="pulse" segment="NSE_PULSE" />
      ) : shown === "premarket" ? (
        <PremarketCard key={view} segment={view} />
      ) : shown === "calendar" ? (
        <CalendarTab key={view} segment={view} />
      ) : (
        <NewsTab key={`${view}:${newsSymbol}`} segment={view} symbol={newsSymbol} />
      )}
    </div>
  );
}

function NewsTab({ segment, symbol }: { segment: Segment; symbol: string }) {
  const news = useResource(() => getNews(symbol, segment), [symbol, segment], { pollMs: 5 * 60_000 });
  if (news.loading) return <Skeleton lines={4} />;
  if (news.error && !news.data) {
    if (news.error instanceof ApiError && news.error.status === 404) return <p className="dim">No news feed is set up for {symbol}.</p>;
    return <ErrorNotice error={news.error} onRetry={news.reload} />;
  }
  const d = news.data;
  if (!d) return null;
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "baseline" }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          News · {symbol}
        </h2>
        <span className={BIAS_PILL[d.bias]}>{BIAS_LABEL[d.bias]}</span>
      </div>
      {d.digest && <p style={{ margin: 0 }}>{d.digest}</p>}
      {d.bias_reason && <p className="dim" style={{ margin: 0, fontSize: 13 }}>{d.bias_reason}</p>}
      {d.articles.length === 0 && <p className="dim">No headlines right now.</p>}
      <ul className="market-info-news">
        {d.articles.map((a) => (
          <li key={a.url}>
            <a href={a.url} target="_blank" rel="noreferrer">
              {a.title}
            </a>
            <span className="faint" style={{ display: "block", fontSize: 12 }}>
              {[a.source, shortDate(a.published_at)].filter(Boolean).join(" · ")}
            </span>
            {a.why && <span className="dim" style={{ display: "block", fontSize: 12 }}>{a.why}</span>}
          </li>
        ))}
      </ul>
      <span className="faint" style={{ fontSize: 12 }}>Headlines from public feeds, read by an AI model. Context, not a recommendation.</span>
    </div>
  );
}
