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

import type { ReactNode } from "react";

type Plate = {
  name: string;
  tag: "Continuation" | "Reversal";
  marks: string;
  appears: string;
  confused: string;
  art: ReactNode;
};

function Candle({ x, wickTop, wickBottom, bodyTop, height, up }: { x: number; wickTop: number; wickBottom: number; bodyTop: number; height: number; up: boolean }) {
  return (
    <>
      <line className="sg-wick" x1={x + 6} y1={wickTop} x2={x + 6} y2={wickBottom} />
      <rect className={up ? "sg-up" : "sg-down"} x={x} y={bodyTop} width="12" height={height} />
    </>
  );
}

function Dot({ x, y }: { x: number; y: number }) {
  return <circle className="sg-dot" cx={x} cy={y} r="2.6" />;
}

const PLATES: Plate[] = [
  {
    name: "OB retest",
    tag: "Continuation",
    marks:
      "A sharp move leaves a tight base of 1–3 opposite-coloured candles behind. Price later returns to that exact zone, holds it without closing back through, and resumes.",
    appears: "On the first pullback right after an impulsive leg.",
    confused: "A reversal — if price closes straight through the zone, the block failed; that isn't a retest.",
    art: (
      <svg viewBox="0 0 300 140">
        <rect className="sg-zone" x="10" y="90" width="270" height="26" />
        <text className="sg-label sg-label-accent" x="14" y="86">order block</text>
        <Candle x={20} wickTop={88} wickBottom={122} bodyTop={98} height={14} up={false} />
        <Candle x={42} wickTop={86} wickBottom={120} bodyTop={94} height={16} up={true} />
        <Candle x={64} wickTop={90} wickBottom={118} bodyTop={96} height={12} up={false} />
        <Candle x={86} wickTop={60} wickBottom={96} bodyTop={62} height={32} up={true} />
        <Candle x={108} wickTop={34} wickBottom={64} bodyTop={36} height={26} up={true} />
        <Candle x={130} wickTop={18} wickBottom={40} bodyTop={20} height={18} up={true} />
        <Candle x={152} wickTop={24} wickBottom={58} bodyTop={26} height={24} up={false} />
        <Candle x={174} wickTop={46} wickBottom={82} bodyTop={50} height={26} up={false} />
        <Candle x={196} wickTop={72} wickBottom={119} bodyTop={92} height={10} up={true} />
        <Dot x={202} y={115} />
        <Candle x={218} wickTop={62} wickBottom={94} bodyTop={64} height={26} up={true} />
        <Candle x={240} wickTop={40} wickBottom={68} bodyTop={42} height={24} up={true} />
        <Candle x={262} wickTop={20} wickBottom={46} bodyTop={22} height={20} up={true} />
      </svg>
    ),
  },
  {
    name: "BOS continuation",
    tag: "Continuation",
    marks: "Price closes decisively past the most recent swing high (uptrend) or swing low (downtrend) — confirmation the prior trend still has control.",
    appears: "Mid-trend, after a shallow pullback held a higher low (or lower high).",
    confused: "CHoCH — a break in the opposite direction of the trend, which signals reversal, not continuation.",
    art: (
      <svg viewBox="0 0 300 140">
        <line className="sg-level" x1="60" y1="46" x2="230" y2="46" />
        <text className="sg-label" x="64" y="40">prior swing high</text>
        <Candle x={20} wickTop={86} wickBottom={118} bodyTop={90} height={24} up={true} />
        <Candle x={42} wickTop={66} wickBottom={92} bodyTop={68} height={22} up={true} />
        <Candle x={64} wickTop={44} wickBottom={70} bodyTop={46} height={22} up={true} />
        <Candle x={86} wickTop={60} wickBottom={80} bodyTop={62} height={14} up={false} />
        <Candle x={108} wickTop={52} wickBottom={76} bodyTop={54} height={12} up={false} />
        <Candle x={130} wickTop={34} wickBottom={58} bodyTop={36} height={20} up={true} />
        <Candle x={152} wickTop={46} wickBottom={66} bodyTop={48} height={12} up={false} />
        <Candle x={174} wickTop={40} wickBottom={60} bodyTop={42} height={12} up={false} />
        <Candle x={196} wickTop={16} wickBottom={46} bodyTop={18} height={26} up={true} />
        <Dot x={202} y={30} />
        <Candle x={218} wickTop={6} wickBottom={24} bodyTop={8} height={14} up={true} />
        <Candle x={240} wickTop={0} wickBottom={16} bodyTop={2} height={12} up={true} />
        <text className="sg-label sg-label-accent" x="200" y="128">bos</text>
      </svg>
    ),
  },
  {
    name: "FVG fill",
    tag: "Continuation",
    marks: "Three candles where the first candle's high and the third's low don't overlap, leaving a gap. Price later trades partway back into it before continuing.",
    appears: "During fast, one-directional moves — opening drives, news spikes.",
    confused: "A full fill: if price trades all the way through the gap and keeps going, that's a different, weaker signal.",
    art: (
      <svg viewBox="0 0 300 140">
        <Candle x={24} wickTop={78} wickBottom={104} bodyTop={80} height={22} up={true} />
        <Candle x={50} wickTop={34} wickBottom={86} bodyTop={36} height={46} up={true} />
        <Candle x={76} wickTop={24} wickBottom={52} bodyTop={26} height={24} up={true} />
        <rect className="sg-zone" x="24" y="52" width="212" height="26" />
        <text className="sg-label sg-label-accent" x="98" y="70">fair value gap</text>
        <Candle x={102} wickTop={14} wickBottom={40} bodyTop={16} height={22} up={true} />
        <Candle x={128} wickTop={8} wickBottom={30} bodyTop={10} height={18} up={true} />
        <Candle x={154} wickTop={20} wickBottom={46} bodyTop={22} height={18} up={false} />
        <Candle x={180} wickTop={34} wickBottom={64} bodyTop={36} height={22} up={false} />
        <Dot x={186} y={60} />
        <Candle x={206} wickTop={16} wickBottom={40} bodyTop={18} height={18} up={true} />
        <Candle x={232} wickTop={4} wickBottom={24} bodyTop={6} height={16} up={true} />
        <Candle x={258} wickTop={0} wickBottom={16} bodyTop={2} height={12} up={true} />
      </svg>
    ),
  },
  {
    name: "S/R bounce",
    tag: "Reversal",
    marks: "Price reaches a horizontal level that has already reacted once, and shows a clear rejection wick or close back away from it.",
    appears: "Round numbers, prior day's high/low, or the OI page's own R1/S1 walls.",
    confused: "A slow-motion breakout — a level tested repeatedly with shrinking wicks is usually about to break, not hold.",
    art: (
      <svg viewBox="0 0 300 140">
        <line className="sg-level" x1="10" y1="80" x2="290" y2="80" />
        <text className="sg-label" x="14" y="94">s/r level</text>
        <Candle x={20} wickTop={20} wickBottom={52} bodyTop={22} height={24} up={true} />
        <Candle x={42} wickTop={34} wickBottom={64} bodyTop={36} height={22} up={false} />
        <Candle x={64} wickTop={52} wickBottom={82} bodyTop={54} height={18} up={false} />
        <Dot x={70} y={80} />
        <Candle x={86} wickTop={30} wickBottom={66} bodyTop={32} height={28} up={true} />
        <Candle x={108} wickTop={14} wickBottom={40} bodyTop={16} height={18} up={true} />
        <Candle x={130} wickTop={26} wickBottom={56} bodyTop={28} height={20} up={false} />
        <Candle x={152} wickTop={42} wickBottom={70} bodyTop={44} height={20} up={false} />
        <Candle x={174} wickTop={58} wickBottom={82} bodyTop={60} height={16} up={false} />
        <Dot x={180} y={80} />
        <Candle x={196} wickTop={30} wickBottom={64} bodyTop={32} height={26} up={true} />
        <Candle x={218} wickTop={16} wickBottom={40} bodyTop={18} height={16} up={true} />
        <Candle x={240} wickTop={4} wickBottom={26} bodyTop={6} height={16} up={true} />
        <Candle x={262} wickTop={0} wickBottom={16} bodyTop={2} height={10} up={true} />
      </svg>
    ),
  },
  {
    name: "Breakout",
    tag: "Continuation",
    marks: "Price has been contained inside a defined range for several candles, then closes outside it with visibly larger range than the candles that built it.",
    appears: "After a stretch the platform's own regime read would call ranging.",
    confused: "A fakeout — a wick beyond the range that closes back inside it isn't a breakout yet.",
    art: (
      <svg viewBox="0 0 300 140">
        <line className="sg-level" x1="10" y1="42" x2="196" y2="42" />
        <line className="sg-level" x1="10" y1="88" x2="196" y2="88" />
        <text className="sg-label" x="14" y="34">range</text>
        <Candle x={20} wickTop={52} wickBottom={78} bodyTop={54} height={20} up={true} />
        <Candle x={42} wickTop={46} wickBottom={72} bodyTop={48} height={18} up={false} />
        <Candle x={64} wickTop={56} wickBottom={82} bodyTop={58} height={18} up={true} />
        <Candle x={86} wickTop={48} wickBottom={74} bodyTop={50} height={18} up={false} />
        <Candle x={108} wickTop={54} wickBottom={80} bodyTop={56} height={18} up={true} />
        <Candle x={130} wickTop={46} wickBottom={70} bodyTop={48} height={16} up={false} />
        <Candle x={152} wickTop={52} wickBottom={78} bodyTop={54} height={18} up={true} />
        <Candle x={174} wickTop={50} wickBottom={76} bodyTop={52} height={18} up={false} />
        <Candle x={198} wickTop={6} wickBottom={60} bodyTop={8} height={46} up={true} />
        <Dot x={204} y={30} />
        <Candle x={220} wickTop={0} wickBottom={20} bodyTop={2} height={14} up={true} />
        <Candle x={242} wickTop={0} wickBottom={14} bodyTop={1} height={10} up={true} />
        <text className="sg-label sg-label-accent" x="198" y="120">breakout</text>
      </svg>
    ),
  },
  {
    name: "OI reversal",
    tag: "Reversal",
    marks: "The side building open interest fastest at the money — calls or puts — flips against the direction price has just been moving.",
    appears: "Around the OI page's own buildup read flipping — long buildup turning into short covering, or the reverse.",
    confused: "OI growing in the same direction as the move, which confirms the trend rather than warning of a turn.",
    art: (
      <svg viewBox="0 0 300 140">
        <Candle x={24} wickTop={46} wickBottom={72} bodyTop={48} height={22} up={true} />
        <Candle x={50} wickTop={26} wickBottom={52} bodyTop={28} height={20} up={true} />
        <Candle x={76} wickTop={14} wickBottom={36} bodyTop={16} height={18} up={true} />
        <Candle x={102} wickTop={24} wickBottom={50} bodyTop={26} height={18} up={false} />
        <Dot x={108} y={20} />
        <Candle x={128} wickTop={36} wickBottom={62} bodyTop={38} height={20} up={false} />
        <Candle x={154} wickTop={52} wickBottom={80} bodyTop={54} height={22} up={false} />
        <Candle x={180} wickTop={68} wickBottom={96} bodyTop={70} height={22} up={false} />
        <text className="sg-label" x="192" y="88">reversal</text>
        <line x1="0" y1="112" x2="300" y2="112" className="sg-rule" />
        <text className="sg-label" x="14" y="124">ce</text>
        <rect className="sg-up" x="30" y="106" width="10" height="6" />
        <rect className="sg-down" x="44" y="100" width="10" height="12" />
        <text className="sg-label" x="14" y="136">pe</text>
        <rect className="sg-up" x="150" y="98" width="10" height="14" />
        <rect className="sg-down" x="164" y="106" width="10" height="6" />
        <text className="sg-label sg-label-accent" x="182" y="108">flip</text>
      </svg>
    ),
  },
  {
    name: "Trend pullback",
    tag: "Continuation",
    marks: "An established trend retraces toward a rising (or falling) trendline or moving average without breaking its run of higher lows, then resumes.",
    appears: "Throughout a healthy trend, on almost every timeframe.",
    confused: "BOS continuation — a pullback is the wait; BOS is the confirmation once price actually breaks back out.",
    art: (
      <svg viewBox="0 0 300 140">
        <line className="sg-trend" x1="14" y1="112" x2="286" y2="18" />
        <text className="sg-label" x="16" y="106">trendline</text>
        <Candle x={24} wickTop={80} wickBottom={108} bodyTop={82} height={24} up={true} />
        <Candle x={50} wickTop={60} wickBottom={88} bodyTop={62} height={22} up={true} />
        <Candle x={76} wickTop={70} wickBottom={96} bodyTop={72} height={18} up={false} />
        <Candle x={102} wickTop={60} wickBottom={86} bodyTop={62} height={20} up={true} />
        <Candle x={128} wickTop={42} wickBottom={68} bodyTop={44} height={20} up={true} />
        <Candle x={154} wickTop={52} wickBottom={76} bodyTop={54} height={16} up={false} />
        <Dot x={160} y={70} />
        <Candle x={180} wickTop={30} wickBottom={58} bodyTop={32} height={22} up={true} />
        <Candle x={206} wickTop={16} wickBottom={40} bodyTop={18} height={18} up={true} />
        <Candle x={232} wickTop={4} wickBottom={24} bodyTop={6} height={14} up={true} />
        <Candle x={258} wickTop={0} wickBottom={14} bodyTop={1} height={10} up={true} />
      </svg>
    ),
  },
  {
    name: "Range fade",
    tag: "Reversal",
    marks: "Price oscillates between a defined ceiling and floor with no clear bias; the trade fades the extreme back toward the opposite side.",
    appears: "Low-ADX, ranging regime reads — where breakouts tend to fail.",
    confused: "A breakout attempt — fading only works while the range holds; the same entry during a genuine breakout is a loss waiting to happen.",
    art: (
      <svg viewBox="0 0 300 140">
        <line className="sg-level" x1="10" y1="20" x2="290" y2="20" />
        <line className="sg-level" x1="10" y1="94" x2="290" y2="94" />
        <text className="sg-label" x="14" y="14">ceiling</text>
        <text className="sg-label" x="14" y="108">floor</text>
        <Candle x={20} wickTop={60} wickBottom={90} bodyTop={62} height={24} up={false} />
        <Candle x={42} wickTop={30} wickBottom={60} bodyTop={32} height={24} up={true} />
        <Candle x={64} wickTop={20} wickBottom={46} bodyTop={22} height={18} up={false} />
        <Candle x={86} wickTop={46} wickBottom={78} bodyTop={48} height={24} up={false} />
        <Candle x={108} wickTop={66} wickBottom={92} bodyTop={68} height={20} up={true} />
        <Candle x={130} wickTop={36} wickBottom={66} bodyTop={38} height={24} up={true} />
        <Candle x={152} wickTop={20} wickBottom={44} bodyTop={22} height={16} up={false} />
        <Candle x={174} wickTop={42} wickBottom={72} bodyTop={44} height={22} up={false} />
        <Candle x={196} wickTop={20} wickBottom={42} bodyTop={22} height={14} up={false} />
        <Dot x={202} y={20} />
        <text className="sg-label sg-label-accent" x="212" y="30">fade</text>
        <Candle x={218} wickTop={40} wickBottom={70} bodyTop={42} height={22} up={false} />
        <Candle x={240} wickTop={62} wickBottom={92} bodyTop={64} height={22} up={false} />
        <Candle x={262} wickTop={78} wickBottom={94} bodyTop={80} height={12} up={false} />
      </svg>
    ),
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
            <div className="setup-plate-art">{p.art}</div>
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
