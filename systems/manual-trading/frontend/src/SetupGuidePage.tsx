// A static reference page for the 11 tags in the Setup dropdown
// (SETUP_TAGS, manualOrder.ts) - what each pattern actually looks like,
// so "By setup" on the Performance page (and the Discipline page's own
// setup-adjacent reads) keeps meaning something. Linked from the Setup
// field itself in ChartTradePanel (both the order form and the History
// journal editor) and from ManualStatsPage's "By setup" section - opened
// in a new tab (?tab=setup-guide) rather than folded into the shell's top
// nav, since it's reference material you check occasionally, not a page
// you navigate to daily. See docs/architecture.md § "Setup field guide".
//
// Deliberately no web fonts / bespoke palette - this reuses the app's own
// dark theme tokens (--buy/--sell/--accent/--text/--text-dim/--border)
// exactly, the same candle colours the real Live Chart draws, so the
// diagrams read as "this app's own chart" rather than an imported doc.

import { SETUP_ART } from "./setupArt";

type Plate = {
  name: string;
  tag: "Continuation" | "Reversal";
  marks: string;
  appears: string;
  confused: string;
};

const PLATES: Plate[] = [
  {
    name: "OB retest",
    tag: "Continuation",
    marks:
      "A sharp move leaves a tight base of 1–3 opposite-coloured candles behind. Price later returns to that exact zone, holds it without closing back through, and resumes.",
    appears: "On the first pullback right after an impulsive leg.",
    confused: "A reversal — if price closes straight through the zone, the block failed; that isn't a retest.",
  },
  {
    name: "BOS continuation",
    tag: "Continuation",
    marks: "Price closes decisively past the most recent swing high (uptrend) or swing low (downtrend) — confirmation the prior trend still has control.",
    appears: "Mid-trend, after a shallow pullback held a higher low (or lower high).",
    confused: "CHoCH — a break in the opposite direction of the trend, which signals reversal, not continuation.",
  },
  {
    name: "FVG fill",
    tag: "Continuation",
    marks: "Three candles where the first candle's high and the third's low don't overlap, leaving a gap. Price later trades partway back into it before continuing.",
    appears: "During fast, one-directional moves — opening drives, news spikes.",
    confused: "A full fill: if price trades all the way through the gap and keeps going, that's a different, weaker signal.",
  },
  {
    name: "S/R bounce",
    tag: "Reversal",
    marks: "Price reaches a horizontal level that has already reacted once, and shows a clear rejection wick or close back away from it.",
    appears: "Round numbers, prior day's high/low, or the OI page's own R1/S1 walls.",
    confused: "A slow-motion breakout — a level tested repeatedly with shrinking wicks is usually about to break, not hold.",
  },
  {
    name: "Breakout",
    tag: "Continuation",
    marks: "Price has been contained inside a defined range for several candles, then closes outside it with visibly larger range than the candles that built it.",
    appears: "After a stretch the platform's own regime read would call ranging.",
    confused: "A fakeout — a wick beyond the range that closes back inside it isn't a breakout yet.",
  },
  {
    name: "OI reversal",
    tag: "Reversal",
    marks: "The side building open interest fastest at the money — calls or puts — flips against the direction price has just been moving.",
    appears: "Around the OI page's own buildup read flipping — long buildup turning into short covering, or the reverse.",
    confused: "OI growing in the same direction as the move, which confirms the trend rather than warning of a turn.",
  },
  {
    name: "Trend pullback",
    tag: "Continuation",
    marks: "An established trend retraces toward a rising (or falling) trendline or moving average without breaking its run of higher lows, then resumes.",
    appears: "Throughout a healthy trend, on almost every timeframe.",
    confused: "BOS continuation — a pullback is the wait; BOS is the confirmation once price actually breaks back out.",
  },
  {
    name: "Range fade",
    tag: "Reversal",
    marks: "Price oscillates between a defined ceiling and floor with no clear bias; the trade fades the extreme back toward the opposite side.",
    appears: "Low-ADX, ranging regime reads — where breakouts tend to fail.",
    confused: "A breakout attempt — fading only works while the range holds; the same entry during a genuine breakout is a loss waiting to happen.",
  },
];

const NOTES = [
  {
    name: "News",
    text: "The real edge (or the real risk) that trade carried was an external catalyst — an earnings print, a rate decision, a headline — not anything visible in the candles beforehand. Tag it here so the setup-based stats aren't diluted by trades that had nothing to do with structure.",
  },
  {
    name: "Revenge / FOMO",
    text: "The one tag that isn't describing an edge at all — it's a confession. Use it the moment you notice you're placing a trade to get back at the market, or because you're afraid of missing a move, and not because any of the eight patterns above actually formed. Tagging these honestly is worth more than never having any.",
  },
  {
    name: "Other",
    text: "Anything real that doesn't fit the list above. If Other starts showing up often in the By-setup breakdown, that's usually a sign the list itself needs a new entry — not that your trading doesn't fit patterns.",
  },
];

export default function SetupGuidePage() {
  return (
    <div className="manual-wide-page setup-guide">
      <div className="manual-page-header">
        <h3>Setup Field Guide</h3>
      </div>
      <p className="muted setup-guide-lede">
        Every closed trade carries one <b>Setup</b> tag, and Performance's "By setup" breakdown
        slices its numbers by exactly that field. Eight of the eleven tags describe a real,
        recognisable shape in price — this is what each one actually looks like. The other three
        aren't patterns at all, and are covered separately below.
      </p>

      <div className="setup-guide-grid">
        {PLATES.map((p) => (
          <article className="setup-plate" key={p.name}>
            <div className="setup-plate-art">{SETUP_ART[p.name]}</div>
            <div className="setup-plate-body">
              <div className="setup-plate-head">
                <h4>{p.name}</h4>
                <span className="setup-plate-tag">{p.tag}</span>
              </div>
              <dl className="setup-plate-fields">
                <dt>Field marks</dt>
                <dd>{p.marks}</dd>
                <dt>Appears</dt>
                <dd>{p.appears}</dd>
                <dt>Confused with</dt>
                <dd>{p.confused}</dd>
              </dl>
            </div>
          </article>
        ))}
      </div>

      <section className="manual-settings-section setup-guide-notes-section">
        <h4>Not a pattern — three field notes</h4>
        <p className="muted">
          These don't describe a shape in price, so they don't get a plate. They exist so a trade
          that didn't start with a pattern still gets recorded honestly — which is exactly what the
          Discipline page's habit and outcome reads depend on.
        </p>
        <div className="setup-guide-notes">
          {NOTES.map((n) => (
            <div className="setup-note" key={n.name}>
              <h5>{n.name}</h5>
              <p>{n.text}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="muted setup-guide-footer">
        Diagrams here are illustrative, not screenshots — for the live version of any of these, open
        the Structure ▾ menu on the Live Chart.
      </p>
    </div>
  );
}
