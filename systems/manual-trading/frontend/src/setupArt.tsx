// The little candlestick diagrams for the 8 real chart-pattern Setup tags
// (SETUP_TAGS in manualOrder.ts). Shared by the Setup Field Guide page
// (SetupGuidePage.tsx) and the Live Chart's setup-card strip
// (SetupCardRow.tsx). The 3 non-pattern tags (News / Revenge · FOMO /
// Other) have no diagram - callers fall back to a glyph.
//
// SVG semantics (sg-* classes) are styled in index.css under BOTH
// .setup-plate-art and .setup-card-art, using the app's own candle
// colours (--buy / --sell / --accent / --text-dim / --border).

import type { ReactNode } from "react";

export function Candle({
  x,
  wickTop,
  wickBottom,
  bodyTop,
  height,
  up,
}: {
  x: number;
  wickTop: number;
  wickBottom: number;
  bodyTop: number;
  height: number;
  up: boolean;
}) {
  return (
    <>
      <line className="sg-wick" x1={x + 6} y1={wickTop} x2={x + 6} y2={wickBottom} />
      <rect className={up ? "sg-up" : "sg-down"} x={x} y={bodyTop} width="12" height={height} />
    </>
  );
}

export function Dot({ x, y }: { x: number; y: number }) {
  return <circle className="sg-dot" cx={x} cy={y} r="2.6" />;
}

// Keyed by the exact SETUP_TAGS string.
export const SETUP_ART: Record<string, ReactNode> = {
  "OB retest": (
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
  "BOS continuation": (
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
  "FVG fill": (
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
  "S/R bounce": (
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
  Breakout: (
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
  "OI reversal": (
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
  "Trend pullback": (
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
  "Range fade": (
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
};

// Continuation vs Reversal, for the card sub-label (matches the Field
// Guide's own `tag`). The 3 non-pattern tags aren't here.
export const SETUP_KIND: Record<string, "Continuation" | "Reversal"> = {
  "OB retest": "Continuation",
  "BOS continuation": "Continuation",
  "FVG fill": "Continuation",
  "S/R bounce": "Reversal",
  Breakout: "Continuation",
  "OI reversal": "Reversal",
  "Trend pullback": "Continuation",
  "Range fade": "Reversal",
};
