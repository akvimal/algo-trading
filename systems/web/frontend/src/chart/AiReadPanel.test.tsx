import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { AiRead } from "../api/types";
import { createRef } from "react";
import { AiReadButton, type AiReadHandle } from "./AiReadPanel";

const getAiRead = vi.fn();
vi.mock("../api/trade", () => ({ getAiRead: (...a: unknown[]) => getAiRead(...a) }));

const READ: AiRead = {
  underlying: "NIFTY", expiry: "2026-10-06", model: "openai/gpt-6-luna-pro", generated_at: new Date(Date.now() - 60 * 60_000).toISOString(), // an hour ago: always inside the 24-hour age limit
  bias: "bearish", confidence: 72, one_liner: "Sell rallies.", reasoning: ["ADX 33 downtrend"], support: [22553.26], resistance: [22595.2],
  risks: ["Breadth unknown"], wait_for: "5m close below 22508", data_gaps: ["futures OI/volume", "market breadth"],
};

beforeEach(() => {
  getAiRead.mockReset();
  localStorage.clear();
});

describe("AiReadButton", () => {
  it("does nothing until clicked, then shows the read", async () => {
    getAiRead.mockResolvedValue(READ);
    render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    expect(getAiRead).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("ai-read-btn"));

    expect(getAiRead).toHaveBeenCalledWith("NSE", "NIFTY", "2026-10-06");
    expect(await screen.findByTestId("ai-read-bias")).toHaveTextContent("bearish · 72%");
    expect(screen.getByText("Sell rallies.")).toBeInTheDocument();
    expect(screen.getByText(/Not provided to the model: futures OI\/volume, market breadth/)).toBeInTheDocument();
  });

  it("shows the server's message when the read fails, and can retry", async () => {
    getAiRead.mockRejectedValueOnce(new ApiError(400, "No OpenRouter key - add yours in Settings to use the AI read.")).mockResolvedValueOnce(READ);
    render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);

    await userEvent.click(screen.getByTestId("ai-read-btn"));
    expect(await screen.findByTestId("ai-read-error")).toHaveTextContent("No OpenRouter key");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("ai-read")).toBeInTheDocument();
  });

  it("drops a finished read when the instrument changes", async () => {
    getAiRead.mockResolvedValue(READ);
    const { rerender } = render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    await screen.findByTestId("ai-read");

    rerender(<AiReadButton exchange="NSE" symbol="BANKNIFTY" expiry="2026-10-06" />);

    await waitFor(() => expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument());
  });

  it("hides and re-shows a finished read without calling the model again", async () => {
    getAiRead.mockResolvedValue(READ);
    render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    await screen.findByTestId("ai-read");

    await userEvent.click(screen.getByTestId("ai-read-btn"));
    expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("ai-read-btn"));

    expect(await screen.findByTestId("ai-read")).toBeInTheDocument();
    expect(getAiRead).toHaveBeenCalledTimes(1);
  });

  it("brings the last read back after a reload without calling the model", async () => {
    getAiRead.mockResolvedValue(READ);
    const first = render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    await screen.findByTestId("ai-read");
    first.unmount(); // a page reload: nothing in memory, only the browser's storage survives
    getAiRead.mockClear();

    render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);

    // it is there but collapsed: opening a chart does not put a panel in the way
    expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-read-btn")).toHaveTextContent("Show AI read");
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    expect(screen.getByTestId("ai-read-bias")).toHaveTextContent("bearish · 72%");
    expect(getAiRead).not.toHaveBeenCalled();
  });

  it("opens a read the person has just asked for, and collapses it again with Hide", async () => {
    getAiRead.mockResolvedValue(READ);
    render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    expect(screen.getByTestId("ai-read-btn")).toHaveTextContent("✦ AI read");
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    expect(await screen.findByTestId("ai-read")).toBeInTheDocument();
    expect(screen.getByTestId("ai-read-btn")).toHaveTextContent("Hide AI read");
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument();
  });

  it("restores each instrument's own saved read when switching back to it", async () => {
    getAiRead.mockResolvedValue(READ);
    const { rerender } = render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    await screen.findByTestId("ai-read");

    rerender(<AiReadButton exchange="NSE" symbol="BANKNIFTY" expiry="2026-10-06" />);
    await waitFor(() => expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument());
    rerender(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);

    // brought back, but collapsed
    await waitFor(() => expect(screen.getByTestId("ai-read-btn")).toHaveTextContent("Show AI read"));
    expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    expect(await screen.findByTestId("ai-read")).toBeInTheDocument();
  });

  it("can be started from outside, like its own button: runs a read, then shows and hides the one that is there", async () => {
    getAiRead.mockResolvedValue(READ);
    const ref = createRef<AiReadHandle>();
    render(<AiReadButton ref={ref} exchange="NSE" symbol="NIFTY" />);
    await act(async () => ref.current!.activate());
    expect(await screen.findByTestId("ai-read")).toBeInTheDocument();
    await act(async () => ref.current!.activate()); // hide
    expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument();
    await act(async () => ref.current!.activate()); // show again
    expect(screen.getByTestId("ai-read")).toBeInTheDocument();
    expect(getAiRead).toHaveBeenCalledTimes(1);
  });

  it("asks without an expiry when the page has none, and saves the read per instrument rather than per expiry", async () => {
    getAiRead.mockResolvedValue(READ);
    const first = render(<AiReadButton exchange="NSE" symbol="NIFTY" />);
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    await screen.findByTestId("ai-read");
    expect(getAiRead).toHaveBeenCalledWith("NSE", "NIFTY", undefined);
    first.unmount();
    // the same instrument with an expiry (the strip is on and its chain has loaded) finds the same read
    render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    expect(screen.getByTestId("ai-read-btn")).toHaveTextContent("Show AI read");
  });
});
