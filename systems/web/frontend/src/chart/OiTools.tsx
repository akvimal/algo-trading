import { OiLevelsIcon, OiStripIcon, SparkleIcon } from "./icons";

type Props = {
  /** Whether the active instrument has an option chain at all (indices, gold, crude, Bitcoin, Ether): without one these do nothing. */
  available: boolean;
  stripOn: boolean;
  onStrip: (on: boolean) => void;
  levelsOn: boolean;
  onLevels: (on: boolean) => void;
  onAiRead: () => void;
};

/** The OI group on the chart rail: the strip of option-chain readings under each chart's header, the support and
 * resistance lines drawn on the chart, and the AI read - which works with the strip hidden, in a slim row of its own.
 * With nothing on, the option chain is not polled at all. */
export function OiTools({ available, stripOn, onStrip, levelsOn, onLevels, onAiRead }: Props) {
  const none = "No option chain for this instrument";
  return (
    <div className="rail-group" role="group" aria-label="Open interest">
      <button className="tool" aria-label="OI strip" aria-pressed={stripOn} disabled={!available} title={available ? `The option-chain readings under each chart (${stripOn ? "on" : "off"})` : none} onClick={() => onStrip(!stripOn)}>
        <OiStripIcon />
      </button>
      <button className="tool" aria-label="OI levels" aria-pressed={levelsOn} disabled={!available} title={available ? `Support and resistance from option open interest, drawn on the chart (${levelsOn ? "on" : "off"})` : none} onClick={() => onLevels(!levelsOn)}>
        <OiLevelsIcon />
      </button>
      <button className="tool tool-ai" aria-label="AI read" disabled={!available} title={available ? "AI read of this chart's option chain, price and news" : none} onClick={onAiRead}>
        <SparkleIcon />
      </button>
    </div>
  );
}
