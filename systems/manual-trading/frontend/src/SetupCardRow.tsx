import { SETUP_TAGS } from "./manualOrder";
import { SETUP_ART, SETUP_KIND } from "./setupArt";

// A full-width strip of Setup cards below the Live Chart (LiveChartPage
// renders it under .live-chart-layout). One card per SETUP_TAGS entry -
// the 8 chart patterns show their Field-Guide diagram, the 3 non-pattern
// tags (News / Revenge · FOMO / Other) show a glyph. Clicking a card sets
// the setup tag: on the open trade (PUT .../tags) if one is running, else
// on the next order the panel / auto-trader will place. Click the active
// card again to clear.

const NOTE_GLYPH: Record<string, string> = {
  News: "📰",
  "Revenge / FOMO": "⚠",
  Other: "•",
};

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
        <span className="setup-card-row-title">Setup</span>
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
        {SETUP_TAGS.map((tag) => {
          const active = selected === tag;
          const art = SETUP_ART[tag];
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
              <span className="setup-card-art">
                {art ?? <span className="setup-card-glyph">{NOTE_GLYPH[tag] ?? "•"}</span>}
              </span>
              <span className="setup-card-name">{tag}</span>
              <span className="setup-card-kind muted">{SETUP_KIND[tag] ?? "Note"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
