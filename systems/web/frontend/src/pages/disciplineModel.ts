import type { DisciplineV2 } from "../api/types";

export const EMOTION_ROWS = [
  { key: "greed", label: "Greed", help: "Sizing up, widening a stop, pushing a target out, overtrading, trading past your loss limit" },
  { key: "fear", label: "Fear", help: "Trailing a stop too tight, closing winners early, pulling a target in, sizing down after losses" },
  { key: "patience", label: "Patience", help: "A planned stop and target, a tagged setup, waiting for your price, not re-entering right after a loss" },
] as const;

/** What each exit looked like, in the trader's words. */
export const EXIT_WORDS: Record<string, string> = {
  target: "Target hit",
  clean_stop: "Stopped out as planned",
  trail_beyond_plan: "Trail beat the plan",
  rule_trail: "Trailed out by rule",
  tight_trail: "Trailed too tight",
  scalp_trail: "Scalp, trailed out",
  trail_loss: "Stop tightened, small loss",
  manual_at_plan: "Closed at the plan",
  early_exit: "Closed early by hand",
  square_off: "Closed at square-off",
  counter_signal: "Reversed by a signal",
  liquidation: "Liquidated",
};

/** What each mistake means, in the trader's words (the server sends a short key). */
export const MISTAKE_WORDS: Record<string, string> = {
  oversized: "Sized above plan",
  undersized_habit: "Habitually sized down",
  no_stop: "No stop",
  unplanned_reward: "No target",
  low_rr: "Reward under minimum",
  untagged: "Setup not tagged",
  tight_trail: "Trailed too tight",
  early_exit: "Closed early",
  liquidated: "Liquidated",
  widen_attempt: "Tried to widen a stop",
  target_pushed: "Pushed the target out",
  target_pulled: "Pulled the target in",
  revenge: "Re-entered right after a loss",
  off_window: "Traded at the open or close",
  overtrade: "Over the daily trade cap",
  past_loss_limit: "Traded past the loss limit",
  no_review: "Not reviewed",
};

export const mistakeWord = (key: string) => MISTAKE_WORDS[key] ?? key.replace(/_/g, " ");

/** The mistakes of the window, most frequent first. */
export function topMistakes(d: DisciplineV2, limit = 4): { key: string; count: number }[] {
  return Object.entries(d.mistakes)
    .filter(([key]) => key in MISTAKE_WORDS)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** "left 1.4R on the table" after an early exit, or the mirror case when price kept going against it. */
export function whatIfText(w: { extra_r: number; target_reached: boolean | null } | null): string | null {
  if (!w) return null;
  if (w.extra_r <= 0) return "Price did not go further your way after you left.";
  return `Price went another ${w.extra_r.toFixed(1)}R your way after you left${w.target_reached ? ", and reached your target" : ""}.`;
}
