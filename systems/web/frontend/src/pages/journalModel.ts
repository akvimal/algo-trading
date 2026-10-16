import type { ChecklistItem, RootCause, Segment } from "../api/types";

// The plan a trade was taken on, picked on the ticket (market state x plan, see tradeModel's planTag): five labels. Results are grouped by these
// exact strings.
export const PLAN_TAGS = ["Trend pullback", "Trend breakout", "Trend reversal", "Range break", "Range fade"] as const;

// What a trade can be tagged with in the journal: the five plans above, and the older reasons the classic app's SETUP_TAGS
// (systems/manual-trading/frontend/src/manualOrder.ts) still uses - old trades keep theirs, and results are grouped by these exact strings.
export const SETUP_TAGS = [
  ...PLAN_TAGS,
  "OB retest",
  "BOS continuation",
  "FVG fill",
  "S/R bounce",
  "Breakout",
  "OI reversal",
  "News",
  "Revenge / FOMO",
  "Other",
] as const;

// "What did you see?" on the ticket: an optional note of the trigger, kept in the order's notes rather than in its tag, so the tag stays one of five.
export const TRIGGERS = ["Order block", "Fair value gap", "Support / resistance", "Break of structure", "Open-interest shift", "News"] as const;

export const NOTES_MAX = 2000;

/** What went wrong, by the step that failed (mirrors the server's app/domain/trade_review.py). A trade is filed under the EARLIEST level that
 * failed: no study explains no plan, and no plan explains the rest. */
export type ReviewLevel = { level: Exclude<RootCause, "clean">; label: string; question: string; tags: { tag: string; label: string }[] };
export const REVIEW_LEVELS: ReviewLevel[] = [
  {
    level: "study", label: "Study", question: "Did you analyse it before entering?",
    tags: [
      { tag: "against_trend", label: "Against the trend" },
      { tag: "ignored_regime", label: "Ignored the regime / OI read" },
      { tag: "event_risk", label: "Traded into news or an event" },
      { tag: "wrong_setup", label: "Wrong setup for the conditions" },
      { tag: "impulse", label: "Impulse or tip, no analysis" },
    ],
  },
  {
    level: "plan", label: "Plan", question: "Did you define the trade before entering?",
    tags: [
      { tag: "no_stop", label: "No stop" },
      { tag: "no_target", label: "No target" },
      { tag: "low_rr", label: "Reward-to-risk below minimum" },
      { tag: "oversized", label: "Oversized" },
      { tag: "chased", label: "Chased the entry" },
      { tag: "no_exit_rule", label: "No exit rule" },
    ],
  },
  {
    level: "execution", label: "Execution", question: "Did you follow the plan?",
    tags: [
      { tag: "stop_moved", label: "Moved or removed the stop" },
      { tag: "exited_early", label: "Exited early" },
      { tag: "held_past_plan", label: "Held past the plan" },
      { tag: "added_to_loser", label: "Added to a loser" },
      { tag: "revenge", label: "Revenge trade or overtrading" },
      { tag: "broke_limits", label: "Broke a limit" },
    ],
  },
];

export const LEVEL_LABEL: Record<RootCause, string> = { study: "Study", plan: "Plan", execution: "Execution", clean: "Clean" };
export const tagLabel = (tag: string): string => REVIEW_LEVELS.flatMap((l) => l.tags).find((t) => t.tag === tag)?.label ?? tag;
const levelOfTag = (tag: string) => REVIEW_LEVELS.find((l) => l.tags.some((t) => t.tag === tag))?.level;

/** The earliest level among the tags, as the server files the trade; null when none. */
export function rootCauseOf(tags: string[]): RootCause | null {
  const levels = new Set(tags.map(levelOfTag));
  return REVIEW_LEVELS.find((l) => levels.has(l.level))?.level ?? null;
}

/** Tap a mistake to add it, tap again to remove it. */
export function toggleTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
}

/** Empty `segments` means every segment. */
export function appliesToSegment(item: ChecklistItem, segment: Segment): boolean {
  return item.segments.length === 0 || item.segments.includes(segment);
}

/** The review-phase checklist for one trade: active items of this segment, in the user's order. */
export function reviewItemsFor(items: ChecklistItem[], segment: Segment): ChecklistItem[] {
  return items
    .filter((i) => i.phase === "review" && i.active && appliesToSegment(i, segment))
    .sort((a, b) => a.sort_order - b.sort_order);
}

export type ReviewInput = {
  /** null until the person answers: submitting is not possible before they do. */
  followedPlan: boolean | null;
  notes: string;
  acceptedLoss: boolean;
  pnl: number;
};

/** Mirrors the server's rules (PUT .../review), so the person hears it before the round trip.
 * The server still enforces them: this only saves a failed request. */
export function validateReview(input: ReviewInput): string | null {
  if (input.followedPlan === null) return "Say whether you followed your plan.";
  if (!input.followedPlan && !input.notes.trim()) return "Describe what you did differently from the plan.";
  if (input.pnl < 0 && !input.acceptedLoss) return 'Tick "I accept this loss" to finish the review.';
  return null;
}

export type ReviewPayload = {
  violation: boolean;
  notes?: string;
  accepted_loss: boolean;
  checklist: { label: string; checked: boolean }[];
};

/** The body for PUT .../review. The checklist is a snapshot of labels, not ids: the server
 * stores what the person actually saw and answered, even if the item is later renamed. */
export function buildReviewPayload(input: ReviewInput, items: ChecklistItem[], checked: Record<string, boolean>): ReviewPayload {
  const notes = input.notes.trim();
  return {
    violation: input.followedPlan === false,
    ...(notes ? { notes } : {}),
    accepted_loss: input.acceptedLoss,
    checklist: items.map((i) => ({ label: i.label, checked: Boolean(checked[i.id]) })),
  };
}

/** Tapping the chosen tag again clears it (the server clears on an empty string). */
export function nextSetupTag(current: string | null, tapped: string): string {
  return current === tapped ? "" : tapped;
}
