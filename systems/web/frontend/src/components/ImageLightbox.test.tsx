import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./ImageLightbox";

function open(onClose = vi.fn()) {
  render(<ImageLightbox src="blob:snap" alt="Chart snapshot" fileName="NIFTY-5min-note.png" onClose={onClose} />);
  return onClose;
}

describe("ImageLightbox", () => {
  it("shows the picture large in a dialog, with a download link that names the file", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Chart snapshot" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("img", { name: "Chart snapshot" })).toHaveAttribute("src", "blob:snap");
    const link = screen.getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "blob:snap");
    expect(link).toHaveAttribute("download", "NIFTY-5min-note.png");
  });

  it("puts focus on Close so the keyboard works at once", () => {
    open();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("closes with the Close button, with Escape, and with a click outside the picture", async () => {
    const user = userEvent.setup();
    const onClose = open();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("lightbox"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not close when the picture itself is clicked - that switches between fitting the screen and real size", async () => {
    const user = userEvent.setup();
    const onClose = open();
    const stage = () => document.querySelector(".lightbox-stage")!;
    expect(stage()).not.toHaveClass("actual");
    await user.click(screen.getByRole("img", { name: "Chart snapshot" }));
    expect(stage()).toHaveClass("actual");
    expect(screen.getByText(/Real size/)).toBeInTheDocument();
    await user.click(screen.getByRole("img", { name: "Chart snapshot" }));
    expect(stage()).not.toHaveClass("actual");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops the page behind from scrolling while it is up, and lets it again after", () => {
    document.body.style.overflow = "";
    const { unmount } = render(<ImageLightbox src="blob:x" alt="x" onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("hands focus back to what opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<ImageLightbox src="blob:x" alt="x" onClose={() => {}} />);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
