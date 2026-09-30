import { useState } from "react";
import { Link } from "react-router-dom";
import { firstWeekDone, type FirstWeekStep } from "../pages/onboardingModel";

const KEY = "web.firstWeekHidden";

const hidden = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/** A short list of habits for a new person's first week, ticked off as they actually do them (the
 * screen notices; nobody is asked to tick a box). Goes away when finished, or when hidden. */
export function FirstWeekCard({ steps }: { steps: FirstWeekStep[] }) {
  const [gone, setGone] = useState(hidden);
  const done = firstWeekDone(steps);
  if (gone || done === steps.length) return null;

  function hide() {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* the card just comes back next visit */
    }
    setGone(true);
  }

  return (
    <div className="card" data-testid="first-week">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>
          Your first week
        </h2>
        <span className="pill">
          {done} of {steps.length} done
        </span>
      </div>
      <ul className="steps">
        {steps.map((s) => (
          <li key={s.id}>
            <span className={`mark ${s.done ? "good" : "na"}`} role="img" aria-label={s.done ? "Done" : "Not done yet"}>
              {s.done ? "✓" : ""}
            </span>
            <span style={{ flex: 1 }}>
              {s.done ? (
                <span className="dim">{s.title}</span>
              ) : (
                <Link to={s.to} style={{ color: "var(--text)" }}>
                  {s.title}
                </Link>
              )}
              {!s.done && (
                <span className="faint" style={{ display: "block", fontSize: 12 }}>
                  {s.hint}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <button className="btn btn-small" style={{ border: 0, background: "none", color: "var(--text-dim)", padding: 0 }} onClick={hide}>
        Hide this
      </button>
    </div>
  );
}
