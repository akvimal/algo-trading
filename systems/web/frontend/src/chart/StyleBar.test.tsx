import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SelectionInfo } from "./alerts";
import type { DrawingStyle } from "./drawingStyle";
import { StyleBar } from "./StyleBar";

const sel = (name: string, style: DrawingStyle = {}, hasDefault = false): SelectionInfo => ({ alertable: false, trigger: null, level: null, look: { name, style, hasDefault } });

function bar(selection: SelectionInfo | null) {
  const handlers = { onStyle: vi.fn(), onReset: vi.fn(), onDefault: vi.fn() };
  render(<StyleBar selection={selection} {...handlers} />);
  return handlers;
}

describe("StyleBar", () => {
  it("is not there with nothing selected", () => {
    bar(null);
    expect(screen.queryByTestId("style-bar")).not.toBeInTheDocument();
  });

  it("offers colour, thickness and line style for a line - and nothing about fill or text", () => {
    bar(sel("segment"));
    expect(screen.getByRole("group", { name: "Colour" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Thickness" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Line style" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Fill" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Text size" })).not.toBeInTheDocument();
  });

  it("adds a fill for a zone", () => {
    bar(sel("rect"));
    expect(screen.getByRole("group", { name: "Fill" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Thickness" })).toBeInTheDocument();
  });

  it("offers colour, size and bold - not thickness or dashes - for a text label", () => {
    bar(sel("textNote"));
    expect(screen.getByRole("group", { name: "Text size" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Thickness" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Line style" })).not.toBeInTheDocument();
  });

  it("sends each choice as a small change", async () => {
    const user = userEvent.setup();
    const h = bar(sel("segment"));
    await user.click(screen.getByRole("button", { name: "Colour Red" }));
    await user.click(screen.getByRole("button", { name: "Thickness 3" }));
    await user.click(screen.getByRole("button", { name: "Dashed" }));
    expect(h.onStyle.mock.calls.map((c) => c[0])).toEqual([{ color: "#e8586a" }, { width: 3 }, { dash: "dashed" }]);
  });

  it("takes any colour from the picker", () => {
    const h = bar(sel("segment"));
    fireEvent.change(screen.getByLabelText("Custom colour"), { target: { value: "#123456" } });
    expect(h.onStyle).toHaveBeenCalledWith({ color: "#123456" });
  });

  it("shows what is chosen, and nothing as chosen for a drawing nobody restyled", () => {
    bar(sel("segment", { color: "#3ecf8e", width: 2, dash: "dotted" }));
    expect(screen.getByRole("button", { name: "Colour Green" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Colour Red" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Thickness 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Dotted" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sends a zone's fill and a label's size, and toggles bold both ways", async () => {
    const user = userEvent.setup();
    const zone = bar(sel("rect"));
    await user.click(screen.getByRole("button", { name: "Strong" }));
    expect(zone.onStyle).toHaveBeenCalledWith({ fill: 0.5 });
  });

  it("toggles a label's weight: bold is on until it is turned off", async () => {
    const user = userEvent.setup();
    const h = bar(sel("textNote"));
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Bold" }));
    await user.click(screen.getByRole("button", { name: "Large" }));
    expect(h.onStyle.mock.calls.map((c) => c[0])).toEqual([{ bold: false }, { textSize: 16 }]);
  });

  it("resets only when something was changed", async () => {
    const user = userEvent.setup();
    const none = bar(sel("segment"));
    expect(screen.getByRole("button", { name: "Reset look" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Use for new trend lines/ })).toBeDisabled();
    expect(none.onReset).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    const some = bar(sel("segment", { width: 2 }));
    await user.click(screen.getByRole("button", { name: "Reset look" }));
    expect(some.onReset).toHaveBeenCalledTimes(1);
  });

  it("makes the look the default for the kind, and clears it again", async () => {
    const user = userEvent.setup();
    const h = bar(sel("rect", { color: "#ffc83d" }));
    await user.click(screen.getByRole("button", { name: "Use for new zones" }));
    expect(h.onDefault).toHaveBeenCalledWith(true);
    document.body.innerHTML = "";
    const cleared = bar(sel("rect", { color: "#ffc83d" }, true));
    await user.click(screen.getByRole("button", { name: "Clear default for zones" }));
    expect(cleared.onDefault).toHaveBeenCalledWith(false);
  });
});
