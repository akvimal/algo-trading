import { TRIGGER_WORDS, type SelectionInfo, type Trigger } from "./alerts";

type Props = {
  /** The selected drawing on the active chart, or null when nothing is selected. */
  selection: SelectionInfo | null;
  /** Drawings with an alert armed, across the charts on screen. */
  armed: number;
  onSet: (trigger: Trigger | null) => void;
};

const CHOICES: { trigger: Trigger; label: string }[] = [
  { trigger: "cross", label: "As it crosses" },
  { trigger: "close", label: "On a candle close" },
];

/** Alerts on drawings. With a line or zone selected it offers to arm one and says how; otherwise it only
 * reminds the person that some are armed. It always says the honest limit: these are watched by this
 * page, so they fire only while it is open. */
export function AlertBar({ selection, armed, onSet }: Props) {
  const offering = selection?.alertable === true;
  if (!offering && armed === 0) return null;
  return (
    <div className="ws-alerts" role="group" aria-label="Alerts on drawings">
      {offering && selection && (
        <>
          <span>
            Selected {selection.level ? <strong className="num">{selection.level}</strong> : "drawing"}
          </span>
          <button className="chip-btn" aria-pressed={selection.trigger != null} onClick={() => onSet(selection.trigger ? null : "cross")}>
            {selection.trigger ? "Alert on" : "Alert me"}
          </button>
          {selection.trigger && (
            <div className="chips" role="group" aria-label="When to alert">
              {CHOICES.map((c) => (
                <button key={c.trigger} aria-pressed={selection.trigger === c.trigger} title={`Tell me ${TRIGGER_WORDS[c.trigger]} it`} onClick={() => onSet(c.trigger)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {armed > 0 && (
        <span className="pill" data-testid="armed">
          {armed} {armed === 1 ? "alert" : "alerts"} armed
        </span>
      )}
      <span className="faint">Alerts fire only while this page is open.</span>
    </div>
  );
}
