import { describe, expect, it } from "vitest";
import type { ChecklistItem } from "../api/types";
import { buildReviewPayload, nextSetupTag, reviewItemsFor, validateReview } from "./journalModel";

const item = (over: Partial<ChecklistItem>): ChecklistItem => ({ id: "i", label: "L", phase: "review", segments: [], sort_order: 0, active: true, ...over });

describe("validateReview", () => {
  it("needs an answer first", () => {
    expect(validateReview({ followedPlan: null, notes: "", acceptedLoss: false, pnl: 10 })).toMatch(/whether you followed/);
  });

  it("needs a description when the plan was not followed, and ignores blank space", () => {
    expect(validateReview({ followedPlan: false, notes: "   ", acceptedLoss: false, pnl: 10 })).toMatch(/differently/);
    expect(validateReview({ followedPlan: false, notes: "moved my stop", acceptedLoss: false, pnl: 10 })).toBeNull();
  });

  it("needs the loss accepted, but only for a loss", () => {
    expect(validateReview({ followedPlan: true, notes: "", acceptedLoss: false, pnl: -1 })).toMatch(/accept this loss/);
    expect(validateReview({ followedPlan: true, notes: "", acceptedLoss: true, pnl: -1 })).toBeNull();
    expect(validateReview({ followedPlan: true, notes: "", acceptedLoss: false, pnl: 0 })).toBeNull();
    expect(validateReview({ followedPlan: true, notes: "", acceptedLoss: false, pnl: 5 })).toBeNull();
  });
});

describe("reviewItemsFor", () => {
  it("keeps active review items for this segment, in the person's order", () => {
    const items = [
      item({ id: "b", label: "B", sort_order: 2 }),
      item({ id: "a", label: "A", sort_order: 1, segments: ["NSE"] }),
      item({ id: "mcx", segments: ["MCX"] }),
      item({ id: "off", active: false }),
      item({ id: "plan", phase: "plan" }),
      item({ id: "day", phase: "day" }),
    ];
    expect(reviewItemsFor(items, "NSE").map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("buildReviewPayload", () => {
  const items = [item({ id: "a", label: "Stayed per plan" }), item({ id: "b", label: "Did not move stop" })];

  it("snapshots labels with what was ticked, and flags a violation", () => {
    const payload = buildReviewPayload({ followedPlan: false, notes: "  moved it  ", acceptedLoss: true, pnl: -5 }, items, { a: true });
    expect(payload).toEqual({
      violation: true,
      notes: "moved it",
      accepted_loss: true,
      checklist: [
        { label: "Stayed per plan", checked: true },
        { label: "Did not move stop", checked: false },
      ],
    });
  });

  it("omits blank notes rather than sending an empty string", () => {
    const payload = buildReviewPayload({ followedPlan: true, notes: "  ", acceptedLoss: false, pnl: 5 }, [], {});
    expect(payload.violation).toBe(false);
    expect("notes" in payload).toBe(false);
  });
});

describe("nextSetupTag", () => {
  it("sets a new tag, and clears when the chosen one is tapped again", () => {
    expect(nextSetupTag(null, "Breakout")).toBe("Breakout");
    expect(nextSetupTag("News", "Breakout")).toBe("Breakout");
    expect(nextSetupTag("Breakout", "Breakout")).toBe("");
  });
});
