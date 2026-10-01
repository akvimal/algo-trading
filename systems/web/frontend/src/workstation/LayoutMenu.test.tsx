import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LAYOUT_CHOICES, LayoutMenu } from "./LayoutMenu";
import type { Layout, Links } from "./state";

const LINKS: Links = { crosshair: true, scale: false, interval: true };

function menu(over: Partial<{ layout: Layout; twoUp: boolean; links: Links }> = {}) {
  const handlers = { onChange: vi.fn(), onLinks: vi.fn() };
  render(<LayoutMenu layout={over.layout ?? "single"} twoUp={over.twoUp ?? false} links={over.links ?? LINKS} {...handlers} />);
  return handlers;
}

describe("LayoutMenu", () => {
  it("names the three arrangements by their grid, columns by rows", () => {
    expect(LAYOUT_CHOICES.map((l) => [l.id, l.grid, l.cols, l.rows])).toEqual([
      ["single", "1×1", 1, 1],
      ["side", "2×1", 2, 1],
      ["stack", "1×2", 1, 2],
    ]);
  });

  it("draws each grid as that many boxes - the picture matches the name", async () => {
    menu();
    await userEvent.setup().click(screen.getByRole("button", { name: "1×1" }));
    expect(screen.getByRole("radio", { name: /1×1/ }).querySelectorAll("rect")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /2×1/ }).querySelectorAll("rect")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /1×2/ }).querySelectorAll("rect")).toHaveLength(2);
  });

  it("lays two-column boxes side by side and two-row boxes one above the other", async () => {
    menu();
    await userEvent.setup().click(screen.getByRole("button", { name: "1×1" }));
    const rects = (name: RegExp) => [...screen.getByRole("radio", { name }).querySelectorAll("rect")].map((r) => [Number(r.getAttribute("x")), Number(r.getAttribute("y"))]);
    const [a, b] = rects(/2×1/);
    expect(b[0]).toBeGreaterThan(a[0]);
    expect(b[1]).toBe(a[1]);
    const [c, d] = rects(/1×2/);
    expect(d[1]).toBeGreaterThan(c[1]);
    expect(d[0]).toBe(c[0]);
  });

  it("marks the current one, reports a pick, and closes", async () => {
    const user = userEvent.setup();
    const h = menu({ layout: "side", twoUp: true });
    await user.click(screen.getByRole("button", { name: "2×1" }));
    expect(screen.getByRole("radio", { name: /2×1/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /1×1/ })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: /1×2/ }));
    expect(h.onChange).toHaveBeenCalledWith("stack");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});

describe("LayoutMenu sync switches", () => {
  it("come after the arrangements, as three switches that show what is on", async () => {
    const user = userEvent.setup();
    menu({ layout: "side", twoUp: true });
    await user.click(screen.getByRole("button", { name: "2×1" }));
    expect(screen.getByText("Sync charts")).toBeInTheDocument();
    expect(screen.getByLabelText("Sync crosshair")).toBeChecked();
    expect(screen.getByLabelText("Sync scrolling and zoom")).not.toBeChecked();
    expect(screen.getByLabelText("Same interval")).toBeChecked();
    const order = [...document.querySelectorAll(".popover-panel > *")].map((n) => n.className);
    expect(order.indexOf("layout-list")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("layout-list")).toBeLessThan(order.indexOf("menu-divider")); // arrangements first, the switches after the divider
  });

  it("report a flip as a small change, and leave the list open so several can be changed", async () => {
    const user = userEvent.setup();
    const h = menu({ layout: "side", twoUp: true });
    await user.click(screen.getByRole("button", { name: "2×1" }));
    await user.click(screen.getByLabelText("Sync scrolling and zoom"));
    await user.click(screen.getByLabelText("Sync crosshair"));
    expect(h.onLinks.mock.calls.map((c) => c[0])).toEqual([{ scale: true }, { crosshair: false }]);
    expect(screen.getByRole("radiogroup", { name: "Chart layout" })).toBeInTheDocument(); // still open
  });

  it("are greyed out with one chart, with a line saying when they apply", async () => {
    const user = userEvent.setup();
    const h = menu({ layout: "single", twoUp: false });
    await user.click(screen.getByRole("button", { name: "1×1" }));
    for (const name of ["Sync crosshair", "Sync scrolling and zoom", "Same interval"]) expect(screen.getByLabelText(name)).toBeDisabled();
    expect(screen.getByText("Applies when two charts are showing.")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Sync crosshair"));
    expect(h.onLinks).not.toHaveBeenCalled();
  });

  it("count the links that are on in a badge on the button, only when there are two charts", () => {
    const { unmount } = render(<LayoutMenu layout="side" twoUp links={LINKS} onChange={() => {}} onLinks={() => {}} />);
    expect(screen.getByRole("button", { name: "2×1" })).toHaveTextContent("2×12"); // grid, then the count of links on
    unmount();
    render(<LayoutMenu layout="single" twoUp={false} links={LINKS} onChange={() => {}} onLinks={() => {}} />);
    expect(screen.getByRole("button", { name: "1×1" })).toHaveTextContent(/^1×1 ▾$/);
  });
});
