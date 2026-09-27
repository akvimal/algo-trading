import { useState } from "react";
import { loadAutoTraderVisible, saveAutoTraderVisible } from "../../autotrader/model";

/** Power-user features that stay out of the way until asked for. Off by default; each choice is a
 * per-browser preference (localStorage), not account state. */
export function AdvancedSection() {
  const [autoTraderVisible, setAutoTraderVisible] = useState(loadAutoTraderVisible);

  function toggle(v: boolean) {
    setAutoTraderVisible(v);
    saveAutoTraderVisible(v);
  }

  return (
    <div className="stack">
      <div className="card">
        <label className="check" htmlFor="show-autotrader" style={{ alignItems: "flex-start" }}>
          <input id="show-autotrader" type="checkbox" checked={autoTraderVisible} onChange={(e) => toggle(e.target.checked)} />
          <span>
            <strong style={{ color: "var(--text)" }}>Show the auto-trader on Trade</strong>
            <span className="faint" style={{ display: "block", fontSize: 13, marginTop: 2 }}>
              Adds a card under the chart for an index, gold, crude, Bitcoin or Ether that can watch a SuperTrend flip and place orders on its own, on its own practice account. Off by default. Turning
              this off again only hides the card — it does not pause an auto-trader that is already armed.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
