import { useState, type ReactNode } from "react";
import { getNews } from "../api/news";
import { ApiError } from "../api/http";
import { CalendarTab } from "../workstation/CalendarTab";
import { useResource } from "../hooks/useResource";
import { BIAS_LABEL, nseSessionStarted, shortDate } from "../pages/premarketModel";
import { ErrorNotice, Skeleton } from "./bits";
import { InfoFoot, InfoHead, InfoLead, InfoList, InfoRow } from "./InfoShell";
import { PremarketCard } from "./PremarketCard";
import { CalendarIcon, NewsIcon, PulseIcon, SunriseIcon } from "../chart/icons";

export type MarketSegment = "NSE" | "MCX" | "CRYPTO";
type Tab = "pulse" | "premarket" | "news" | "calendar";

const BIAS_PILL = { bullish: "pill up", bearish: "pill dn", neutral: "pill" } as const;

/** The symbol a market's News tab reads when that market is not the one on the chart. */
const DEFAULT_NEWS_SYMBOL: Record<MarketSegment, string> = { NSE: "NIFTY", MCX: "GOLDM", CRYPTO: "BTCUSD" };
export const SEGMENT_LABEL: Record<MarketSegment, string> = { NSE: "NSE", MCX: "MCX", CRYPTO: "Crypto" };

/** The market reports shared by the Trade page's "Markets" chip and the Today page's Markets card, so the two never drift apart:
 * the pills for the person's markets, then per market the live Pulse (NSE only, from the open), the morning Pre-market report
 * (Brief for crypto), News and the Calendar. `symbol` is the news symbol for `segment` (the chart's symbol on Trade; the market's index
 * where there is no chart). `onViewChange` lets a host (the Today card) show the chosen market's own summary beside the panel. */
export function MarketsPanel({ segment, symbol, markets, onViewChange }: { segment: MarketSegment; symbol?: string; markets: MarketSegment[]; onViewChange?: (s: MarketSegment) => void }) {
  const [tab, setTab] = useState<Tab>(segment === "NSE" && nseSessionStarted() ? "pulse" : "premarket");
  // Opens on the market given (the chart's on Trade, the one trading right now on Today); the pills read any other market.
  const [view, setView] = useState<MarketSegment>(segment);
  // NSE has the live pulse (from the open), the morning report and the news. A tab that does not exist for the market on show falls back to the first.
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    ...(view === "NSE" ? [{ id: "pulse" as const, label: "Pulse", icon: <PulseIcon /> }] : []),
    { id: "premarket", label: view === "CRYPTO" ? "Brief" : "Pre-market", icon: <SunriseIcon /> },
    { id: "news", label: "News", icon: <NewsIcon /> },
    { id: "calendar", label: "Calendar", icon: <CalendarIcon /> },
  ];
  const shown: Tab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const choices = (["NSE", "MCX", "CRYPTO"] as const).filter((s) => markets.includes(s) || s === segment);
  const newsSymbol = symbol && view === segment ? symbol : DEFAULT_NEWS_SYMBOL[view];
  return (
    <div className="market-info">
      {/* The market and the report are one row (it scrolls sideways if it must), not two rows of badges. */}
      <div className="market-info-head">
      {choices.length > 1 && (
        <div className="chips" role="group" aria-label="Market">
          {choices.map((s) => (
            <button
              key={s}
              aria-pressed={view === s}
              onClick={() => {
                setView(s);
                onViewChange?.(s);
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
          <button key={t.id} role="tab" className="icon-tab" aria-label={t.label} title={t.label} aria-selected={shown === t.id} aria-pressed={shown === t.id} onClick={() => setTab(t.id)}>
            {t.icon}
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </div>
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

function NewsTab({ segment, symbol }: { segment: MarketSegment; symbol: string }) {
  const news = useResource(() => getNews(symbol, segment), [symbol, segment], { pollMs: 5 * 60_000 });
  if (news.loading) return <Skeleton lines={4} />;
  if (news.error && !news.data) {
    if (news.error instanceof ApiError && news.error.status === 404) return <p className="dim">No news feed is set up for {symbol}.</p>;
    return <ErrorNotice error={news.error} onRetry={news.reload} />;
  }
  const d = news.data;
  if (!d) return null;
  return (
    <div className="stack info-section" data-testid="news-report">
      <InfoHead title={`News · ${symbol}`} status={<span className={BIAS_PILL[d.bias]}>{BIAS_LABEL[d.bias]}</span>} onRefresh={news.reload} busy={news.refreshing} refreshLabel="Refresh the news" />
      {d.digest ? <InfoLead>{d.digest}</InfoLead> : d.articles.length === 0 ? <InfoLead>No headlines right now.</InfoLead> : null}
      {d.bias_reason && <p className="info-reason">{d.bias_reason}</p>}
      <InfoList label="Headlines">
        {d.articles.map((a) => (
          <InfoRow
            key={a.url}
            primary={<a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>}
            secondary={[a.source, shortDate(a.published_at)].filter(Boolean).join(" · ")}
            tertiary={a.why}
          />
        ))}
      </InfoList>
      <InfoFoot>Headlines from public feeds, read by an AI model. Context, not a recommendation.</InfoFoot>
    </div>
  );
}
