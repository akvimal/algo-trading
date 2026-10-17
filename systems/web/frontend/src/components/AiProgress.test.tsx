import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PremarketReport } from "../api/types";
import { AiProgress, progressSteps } from "./AiProgress";

const report = (over: Partial<PremarketReport> = {}) =>
  ({
    day: "2026-10-17", generated_at: "2026-10-17T05:00:00Z", bias: "bearish", agree: null, model: null, ai_error: null, ai_pending: true,
    inputs: [{ ok: true }, { ok: true }, { ok: false }], rules: { score: -0.42, bias: "bearish", coverage: 0.66, gift_gap_pct: null, factors: [] },
    ai: null, ai_requested_at: "2026-10-17T05:00:00Z", ai_model: "deepseek/deepseek-v4-flash", ...over,
  }) as unknown as PremarketReport;

describe("AI progress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists what is done and what is running, from what the server already has", () => {
    const steps = progressSteps(report());
    expect(steps.map((s) => [s.key, s.state])).toEqual([["inputs", "done"], ["rules", "done"], ["ai", "active"]]);
    expect(steps[0].detail).toBe("2 of 3 inputs");
    expect(steps[1].detail).toBe("Bearish (score -0.42)");
    expect(steps[2].detail).toBe("deepseek/deepseek-v4-flash is reading the numbers");
  });

  it("counts the seconds since the model was asked, live", () => {
    vi.setSystemTime(new Date("2026-10-17T05:00:12Z"));
    render(<AiProgress report={report()} />);
    expect(screen.getByTestId("ai-pending")).toHaveTextContent("12s");
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId("ai-pending")).toHaveTextContent("15s");
  });

  it("copes with no model name or start time", () => {
    vi.setSystemTime(new Date("2026-10-17T05:00:00Z"));
    render(<AiProgress report={report({ ai_requested_at: null, ai_model: null })} />);
    expect(screen.getByTestId("ai-pending")).toHaveTextContent("The model is reading the numbers");
    expect(screen.getByTestId("ai-pending")).toHaveTextContent("0s");
  });
});
