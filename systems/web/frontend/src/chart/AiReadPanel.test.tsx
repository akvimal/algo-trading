import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { AiRead } from "../api/types";
import { AiReadButton } from "./AiReadPanel";

const getAiRead = vi.fn();
vi.mock("../api/trade", () => ({ getAiRead: (...a: unknown[]) => getAiRead(...a) }));

const READ: AiRead = {
  underlying: "NIFTY", expiry: "2026-10-06", model: "openai/gpt-6-luna-pro", generated_at: "2026-10-01T10:00:00+05:30",
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

    expect(screen.getByTestId("ai-read-bias")).toHaveTextContent("bearish · 72%");
    expect(getAiRead).not.toHaveBeenCalled();
  });

  it("restores each instrument's own saved read when switching back to it", async () => {
    getAiRead.mockResolvedValue(READ);
    const { rerender } = render(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);
    await userEvent.click(screen.getByTestId("ai-read-btn"));
    await screen.findByTestId("ai-read");

    rerender(<AiReadButton exchange="NSE" symbol="BANKNIFTY" expiry="2026-10-06" />);
    await waitFor(() => expect(screen.queryByTestId("ai-read")).not.toBeInTheDocument());
    rerender(<AiReadButton exchange="NSE" symbol="NIFTY" expiry="2026-10-06" />);

    expect(await screen.findByTestId("ai-read")).toBeInTheDocument();
  });
});
