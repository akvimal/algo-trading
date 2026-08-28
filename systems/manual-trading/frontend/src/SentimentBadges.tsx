import { useEffect, useRef, useState } from "react";

import { type MarketSentiment, type SentimentDirection, type SentimentStrength, type UnderlyingSentiment, fetchSentiment } from "./api";

// How long a badge keeps its "just changed" highlight - matches the
// shell's own notification for the same event (see shell/index.html's
// pollSentiment), so the visual and the desktop notification/sound land
// as one coherent moment rather than two disconnected signals.
const FLASH_DURATION_MS = 4000;

// Per-asset OI-based sentiment badges in the top row, grouped by segment
// (NSE: NIFTY/BANKNIFTY, MCX: GOLDM/CRUDEOILM) - see market-data's
// app/domain/sentiment.py for the underlying scoring (put-vs-call OI
// shift, 15m primary / 5m confidence check, bucketed into mild/strong/
// very_strong). Deliberately asset-level, not one blended number per
// segment - two assets on the same exchange can read opposite ways, and
// averaging them into a single badge hid that. Polled every 5 minutes:
// each poll is a real Dhan option-chain fetch per watchlist symbol, and
// this bar is mounted for the whole logged-in session, not just while a
// particular tab is open - same Dhan rate-limit caution as the old
// shell-header Dhan-expiry banner this was modeled after.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const STRENGTH_LABEL: Record<SentimentStrength, string> = { mild: "Mild", strong: "Strong", very_strong: "Very Strong" };

function fullLabel(direction: SentimentDirection, strength: SentimentStrength | null): string {
  if (direction === "neutral" || !strength) return "Neutral";
  return `${direction === "bullish" ? "Bullish" : "Bearish"} (${STRENGTH_LABEL[strength]})`;
}

// Arrow count IS the level - 1/2/3 arrows for mild/strong/very_strong, a
// single dot for neutral - so the strength reads at a glance without
// needing the parenthetical text (still available via the title tooltip).
function levelGlyph(direction: SentimentDirection, strength: SentimentStrength | null): string {
  if (direction === "neutral" || !strength) return "•";
  const count = strength === "very_strong" ? 3 : strength === "strong" ? 2 : 1;
  return (direction === "bullish" ? "▲" : "▼").repeat(count);
}

function AssetBadge({ underlying, flashing }: { underlying: UnderlyingSentiment; flashing: boolean }) {
  const glyph = underlying.error ? "?" : levelGlyph(underlying.direction, underlying.strength);
  const title = underlying.error ? `${underlying.symbol}: no data (${underlying.error})` : `${underlying.symbol}: ${fullLabel(underlying.direction, underlying.strength)}`;
  return (
    <span className={`sentiment-badge ${underlying.error ? "neutral" : underlying.direction}${flashing ? " flash" : ""}`} title={title}>
      <span className="symbol">{underlying.symbol}</span>
      <span className="glyph">{glyph}</span>
    </span>
  );
}

// Symbol -> {direction, strength} as of the last poll - a plain key
// (direction+strength), not the whole UnderlyingSentiment, so an
// unrelated field changing (score_5m/score_15m tick slightly without
// crossing a bucket boundary) doesn't itself count as "changed".
function sentimentKey(u: UnderlyingSentiment): string {
  return `${u.direction}:${u.strength ?? ""}`;
}

export function SentimentBadges() {
  const [sentiment, setSentiment] = useState<MarketSentiment | null>(null);
  const [flashingSymbols, setFlashingSymbols] = useState<Set<string>>(new Set());
  // null = not seeded yet - the first poll only records what's already
  // there, it never flashes every badge just because the bar mounted.
  const prevRef = useRef<Map<string, string> | null>(null);
  const flashTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchSentiment();
        if (cancelled) return;
        setSentiment(data);

        const next = new Map<string, string>();
        for (const entry of Object.values(data.exchanges)) {
          for (const u of entry.underlyings) next.set(u.symbol, sentimentKey(u));
        }
        const prev = prevRef.current;
        if (prev) {
          for (const [symbol, key] of next) {
            if (prev.get(symbol) !== key) {
              setFlashingSymbols((s) => new Set(s).add(symbol));
              window.clearTimeout(flashTimersRef.current.get(symbol));
              const timer = window.setTimeout(() => {
                setFlashingSymbols((s) => {
                  if (!s.has(symbol)) return s;
                  const copy = new Set(s);
                  copy.delete(symbol);
                  return copy;
                });
                flashTimersRef.current.delete(symbol);
              }, FLASH_DURATION_MS);
              flashTimersRef.current.set(symbol, timer);
            }
          }
        }
        prevRef.current = next;
      } catch {
        // market-data unreachable or a transient error - leave whatever
        // was last shown rather than flashing the bar empty on one
        // missed poll (same reasoning as the Dhan-expiry banner).
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      flashTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  if (!sentiment) return null;

  return (
    <div className="sentiment-bar">
      {Object.entries(sentiment.exchanges).map(([exchange, entry]) => (
        <span key={exchange} className="sentiment-segment">
          <span className="segment-label">{exchange}</span>
          {entry.underlyings.map((underlying) => (
            <AssetBadge key={underlying.symbol} underlying={underlying} flashing={flashingSymbols.has(underlying.symbol)} />
          ))}
        </span>
      ))}
    </div>
  );
}
