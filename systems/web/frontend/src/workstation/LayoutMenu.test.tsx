import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LAYOUT_CHOICES, LayoutMenu } from "./LayoutMenu";

describe("LayoutMenu", () => {
  it("names the three arrangements by their grid, columns by rows", () => {
    expect(LAYOUT_CHOICES.map((l) => [l.id, l.grid, l.cols, l.rows])).toEqual([
      ["single", "1×1", 1, 1],
      ["side", "2×1", 2, 1],
      ["stack", "1×2", 1, 2],
    ]);
  });

  it("draws each grid as that many boxes - the picture matches the name", async () => {
    render(<LayoutMenu layout="single" onChange={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "1×1" }));
    expect(screen.getByRole("radio", { name: /1×1/ }).querySelectorAll("rect")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /2×1/ }).querySelectorAll("rect")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /1×2/ }).querySelectorAll("rect")).toHaveLength(2);
  });

  it("lays two-column boxes side by side and two-row boxes one above the other", async () => {
    render(<LayoutMenu layout="single" onChange={() => {}} />);
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
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<LayoutMenu layout="side" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "2×1" }));
    expect(screen.getByRole("radio", { name: /2×1/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /1×1/ })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: /1×2/ }));
    expect(onChange).toHaveBeenCalledWith("stack");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});
