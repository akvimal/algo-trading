import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as journal from "../api/journal";
import type { Trade } from "../pages/portfolioModel";
import { MistakeReview } from "./MistakeReview";

vi.mock("../api/journal");

const trade: Trade = {
  id: "t1", kind: "position", symbol: "TCS", action: "BUY", pnl: -400, exitTime: "2026-10-16T05:00:00Z", exitReason: "stop_loss", setupTag: null,
  confidence: null, rootCause: null, mistakeTags: [], notes: null, reviewed: false, violation: null, charges: null, autoTraded: false, segment: "NSE",
  manual: true, reviewNotes: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(journal.saveMistakes).mockResolvedValue({});
  vi.mocked(journal.loadSuggestions).mockResolvedValue({
    available: true, had_context: true, root_cause: "study",
    tags: [{ tag: "against_trend", level: "study", label: "Against the trend", why: "The market was trending the other way at entry (ADX 31)." }],
  });
});

describe("MistakeReview", () => {
  it("shows what the order supports, and Use these selects it and files the trade under the earliest step", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<MistakeReview trade={trade} onSaved={onSaved} />);
    expect(await screen.findByText(/trending the other way at entry/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Use these" }));
    await user.click(screen.getByRole("button", { name: "No stop" }));
    expect(screen.getByText(/Filed under: Study/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(journal.saveMistakes).toHaveBeenCalledWith("position", "t1", { mistake_tags: ["against_trend", "no_stop"] }));
    expect(onSaved).toHaveBeenCalled();
  });

  it("saves a clean trade, clears the mistakes it had picked, and a mistake tap un-cleans it", async () => {
    const user = userEvent.setup();
    render(<MistakeReview trade={trade} onSaved={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Exited early" }));
    await user.click(screen.getByRole("button", { name: /clean trade/ }));
    expect(screen.getByRole("button", { name: "Exited early" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(journal.saveMistakes).toHaveBeenCalledWith("position", "t1", { clean: true }));
  });

  it("says so when the trend at entry was not recorded", async () => {
    vi.mocked(journal.loadSuggestions).mockResolvedValue({ available: true, had_context: false, root_cause: null, tags: [] });
    render(<MistakeReview trade={trade} onSaved={() => {}} />);
    expect(await screen.findByText(/trend at entry was not recorded/)).toBeInTheDocument();
  });
});
