import type { ChecklistItem, Segment } from "../api/types";

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
