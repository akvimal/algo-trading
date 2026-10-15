import { useState } from "react";
import { BellOffIcon } from "./icons";
import { ALERT_TOOL_NAME, TRIGGER_WORDS, type ArmedAlert, type SelectionInfo, type Trigger } from "./alerts";

type Props = {
  /** The selected drawing on the active chart, or null when nothing is selected. */
  selection: SelectionInfo | null;
  /** Drawings with an alert armed, across the charts on screen. */
  armed: number;
  onSet: (trigger: Trigger | null) => void;
  /** Every armed alert on the charts on screen, read when the list is open; `where` names the instrument when more than one chart is shown. */
  getAlerts?: () => (ArmedAlert & { where?: string })[];
  /** Switch one of them off. */
  onDisarm?: (alert: ArmedAlert & { where?: string }) => void;
};

const CHOICES: { trigger: Trigger; label: string }[] = [
  { trigger: "cross", label: "As it crosses" },
  { trigger: "close", label: "On a candle close" },
];

/** Alerts on drawings. With a line or zone selected it offers to arm one and says how; otherwise it only
 * reminds the person that some are armed. It always says the honest limit: a zone or horizontal level is
 * also watched by the server (Telegram, page closed), a sloped line only by this page. */
export function AlertBar({ selection, armed, onSet, getAlerts, onDisarm }: Props) {
  const [listOpen, setListOpen] = useState(false);
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
        <button className="pill alert-count" data-testid="armed" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)} title="Show every alert armed on this instrument">
          {armed} {armed === 1 ? "alert" : "alerts"} armed <span aria-hidden="true">{listOpen ? "▴" : "▾"}</span>
        </button>
      )}
      {armed > 0 && listOpen && getAlerts && (
        <ul className="alert-list" aria-label="Armed alerts" data-testid="alert-list">
          {getAlerts().map((a) => (
            <li key={`${a.where ?? ""}${a.id}`}>
              <span>
                {a.where ? <b>{a.where} · </b> : null}
                {ALERT_TOOL_NAME[a.name] ?? "Drawing"}
                {a.label ? ` “${a.label}”` : ""} {a.level ? <strong className="num">{a.level}</strong> : null}
                <span className="faint"> · {a.trigger === "close" ? "on a candle close" : "as it crosses"}</span>
              </span>
              {onDisarm && (
                <button className="tool" aria-label={`Switch off the alert on ${ALERT_TOOL_NAME[a.name] ?? "drawing"} ${a.level ?? ""}`} title="Switch this alert off (the drawing stays)" onClick={() => onDisarm(a)}>
                  <BellOffIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="faint" data-testid="alert-limits">
        Zones and horizontal levels are also watched by the server and sent to your Telegram, with this page closed. A sloped line fires only while this page is open.
      </span>
    </div>
  );
}
