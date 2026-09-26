import { CLASSIC_APP_URL } from "../config";

/** Screens from the redesign that are not ported yet. They point at the classic app so no
 * capability is lost while the new one grows, and say so plainly instead of pretending. */
export function ComingPage({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="stack">
      <h1>{title}</h1>
      <div className="card">
        <p style={{ marginTop: 0 }}>{blurb}</p>
        <p className="dim">This screen is being rebuilt. Until then it works in the classic app.</p>
        <a className="btn" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }} href={CLASSIC_APP_URL}>
          Open classic app
        </a>
      </div>
    </div>
  );
}
