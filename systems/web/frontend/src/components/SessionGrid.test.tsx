import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { BotSession, GridCell, ManualSession } from "../api/types";
import { BotGrid, ManualGrid, hasSessions } from "./SessionGrid";

const cell = (ok: number, of: number): GridCell => {
  const rate = of === 0 ? null : ok / of;
  return { ok, of, rate, band: rate == null ? "none" : rate > 0.8 ? "good" : rate >= 0.5 ? "mid" : "poor" };
};
const session = (date: string, over: Partial<ManualSession> = {}): ManualSession => ({ date, trades: 3, unreviewed: 0, study: cell(3, 3), plan: cell(2, 3), trade: cell(1, 3), ...over });
const renderManual = (sessions: ManualSession[]) => render(<MemoryRouter><ManualGrid sessions={sessions} /></MemoryRouter>);

describe("ManualGrid", () => {
  it("draws a coloured cell per level per session, newest first, with the date over each column", () => {
    renderManual([session("2026-10-03"), session("2026-09-30")]);
    const grid = within(screen.getByTestId("manual-grid"));
    expect(grid.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Oct3", "Sep30"]);
    expect(grid.getByLabelText(/Study, 2026-10-03/)).toHaveClass("good");
    expect(grid.getByLabelText(/Plan, 2026-10-03/)).toHaveClass("mid");
    expect(grid.getByLabelText(/Trade, 2026-10-03/)).toHaveClass("poor");
    expect(grid.getByLabelText(/Trade, 2026-10-03/)).toHaveAttribute("title", "1 of 3 reviewed trades followed the plan");
  });

  it("shows a session that is not reviewed as hatched grey and says how many are waiting", () => {
    renderManual([session("2026-10-03", { trades: 2, unreviewed: 2, study: cell(0, 0), plan: cell(0, 0), trade: cell(0, 0) })]);
    const study = screen.getByLabelText(/Study, 2026-10-03/);
    expect(study).toHaveClass("none", "hatched");
    expect(study).toHaveAttribute("title", "2 of 2 not reviewed yet: no verdict");
    expect(screen.getByRole("link", { name: /2 not reviewed/ })).toHaveAttribute("href", "/performance?tab=review&section=journal");
  });

  it("flags the unreviewed part of a session that is partly reviewed, without hiding the verdict", () => {
    renderManual([session("2026-10-03", { unreviewed: 1, study: cell(2, 2), plan: cell(2, 2), trade: cell(2, 2) })]);
    expect(screen.getByLabelText(/Study, 2026-10-03/)).toHaveClass("good");
    expect(screen.getByLabelText(/Study, 2026-10-03/)).toHaveAttribute("title", "2 of 2 reviewed trades were analysed before entry (1 not reviewed yet)");
    expect(screen.getByRole("link", { name: /1 not reviewed/ })).toBeInTheDocument();
  });

  it("shows the override record, and says in the Study cell how many overrides paid off", () => {
    render(<MemoryRouter><ManualGrid sessions={[session("2026-10-03", { overrides: 2, paid_off: 1 })]} overrides={{ total: 2, paid_off: 1 }} /></MemoryRouter>);
    expect(screen.getByTestId("override-record")).toHaveTextContent("Your overrides: 1 of 2 paid off");
    expect(screen.getByLabelText(/Study, 2026-10-03/)).toHaveAttribute("title", "3 of 3 reviewed trades were analysed before entry (1 override paid off)");
  });

  it("shows no override record when there were no overrides", () => {
    render(<MemoryRouter><ManualGrid sessions={[session("2026-10-03")]} overrides={{ total: 0, paid_off: 0 }} /></MemoryRouter>);
    expect(screen.queryByTestId("override-record")).not.toBeInTheDocument();
  });

  it("shows no review chip when everything is reviewed", () => {
    renderManual([session("2026-10-03")]);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("BotGrid", () => {
  const bot = (over: Partial<BotSession> = {}): BotSession => ({ date: "2026-10-03", trades: 2, pnl: 450, wins: 1, win_rate: 0.5, result: "good", wins_band: "mid", clean: "good", no_stop: 0, failed: 0, ...over });

  it("judges result, wins and a clean run, and explains a failure in the cell", () => {
    render(<BotGrid sessions={[bot(), bot({ date: "2026-10-02", pnl: -200, result: "poor", wins: 0, win_rate: 0, wins_band: "poor", clean: "poor", failed: 2 })]} />);
    expect(screen.getByLabelText(/Result, 2026-10-03/)).toHaveClass("good");
    expect(screen.getByLabelText(/Result, 2026-10-03/)).toHaveAttribute("title", "+₹450 from 2 trades");
    expect(screen.getByLabelText(/Wins, 2026-10-03/)).toHaveAttribute("title", "1 of 2 won");
    expect(screen.getByLabelText(/Clean run, 2026-10-02/)).toHaveClass("poor");
    expect(screen.getByLabelText(/Clean run, 2026-10-02/)).toHaveAttribute("title", "2 decisions failed");
  });
});

describe("hasSessions", () => {
  it("is true when either grid has a session", () => {
    expect(hasSessions(null)).toBe(false);
    expect(hasSessions({ manual: [], bot: [] })).toBe(false);
    expect(hasSessions({ manual: [], bot: [{} as BotSession] })).toBe(true);
  });
});
