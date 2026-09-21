import { SETUP_TAGS } from "./manualOrder";
import { SETUP_ART, SETUP_KIND } from "./setupArt";

// Setup cards, rendered as the "Setup" tab of ChartTradePanel. One card per chart-pattern tag
// that has a Field-Guide diagram - the 3 non-pattern tags (News /
// Revenge · FOMO / Other) are deliberately left out of the strip; pick
// those from the panel's Setup dropdown or the History journal editor.
// Clicking a card sets the setup tag: on the open trade (PUT .../tags) if
// one is running, else on the next order the panel / auto-trader will
// place. Click the active card again to clear.

// Reversal setups first, then continuation - the order a discretionary
// trader scans them (is this a turn? no -> is the trend still on?).
// Array.sort is stable, so the SETUP_TAGS order holds within each group.
const CARD_TAGS = SETUP_TAGS.filter((tag) => SETUP_ART[tag]).sort(
  (a, b) => (SETUP_KIND[a] === "Reversal" ? 0 : 1) - (SETUP_KIND[b] === "Reversal" ? 0 : 1),
);

export default function SetupCardRow({
  selected,
  onSelect,
  context,
  busy = false,
}: {
  selected: string; // "" = none
  onSelect: (tag: string) => void;
  // Where the tag lands - drives the one-line hint only.
  context: "entry" | "open" | "auto";
  busy?: boolean;
}) {
  const hint =
    context === "open"
      ? "tags the open trade"
      : context === "auto"
        ? "tags each auto-trade fill"
        : "tags your next order";

  return (
    <div className="setup-card-row">
      <div className="setup-card-row-head">
        <span className="setup-card-row-hint muted">{hint}</span>
        <a
          className="ctp-help-link"
          href="?tab=setup-guide"
          target="_blank"
          rel="noopener"
          title="What each setup actually looks like"
        >
          ?
        </a>
      </div>
      <div className="setup-card-strip" role="radiogroup" aria-label="Setup type">
        {CARD_TAGS.map((tag) => {
          const active = selected === tag;
          return (
            <button
              key={tag}
              type="button"
              role="radio"
              aria-checked={active}
              className={`setup-card${active ? " active" : ""}`}
              disabled={busy}
              title={busy ? "Saving…" : tag}
              onClick={() => onSelect(active ? "" : tag)}
            >
              <span className="setup-card-art">{SETUP_ART[tag]}</span>
              <span className="setup-card-name">{tag}</span>
              <span className="setup-card-kind muted">{SETUP_KIND[tag]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
