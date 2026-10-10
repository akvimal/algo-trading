import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DrawToolbar } from "./DrawToolbar";

const base = { active: null, onTool: () => {}, magnet: false, onMagnet: () => {}, hidden: false, onHidden: () => {}, onClear: () => {}, hasSelection: false, onDeleteSelected: () => {} };

describe("the zone alert switch", () => {
  it("shows whether new zones are armed, and flips it when pressed", async () => {
    const flip = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<DrawToolbar {...base} zoneAlert onZoneAlert={flip} />);
    const bell = screen.getByRole("button", { name: "Alert on new zones" });
    expect(bell).toHaveAttribute("aria-pressed", "true");
    expect(bell).toHaveAttribute("title", expect.stringMatching(/armed with an alert/));
    await user.click(bell);
    expect(flip).toHaveBeenCalledTimes(1);
    rerender(<DrawToolbar {...base} zoneAlert={false} onZoneAlert={flip} />);
    expect(screen.getByRole("button", { name: "Alert on new zones" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Alert on new zones" })).toHaveAttribute("title", expect.stringMatching(/without an alert/));
  });

  it("is not offered where the page cannot keep the choice", () => {
    render(<DrawToolbar {...base} />);
    expect(screen.queryByRole("button", { name: "Alert on new zones" })).not.toBeInTheDocument();
  });
});
