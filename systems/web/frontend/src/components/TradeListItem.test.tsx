import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TradeListItem } from "./TradeListItem";

vi.mock("./TradeSnapshots", () => ({ TradeSnapshots: (p: { trade: { kind: string; id: string } }) => <div data-testid="snapshots">{p.trade.kind}:{p.trade.id}</div> }));
vi.mock("./TradeJournal", () => ({ TradeJournal: () => <div data-testid="journal" /> }));

const trade = { id: "t1", kind: "group", symbol: "ADANIGREEN", action: "SELL", pnl: 10, exitTime: "2026-10-13T10:00:00Z", exitReason: "manual", setupTag: null, confidence: null, notes: null, reviewed: false, violation: null, charges: null, autoTraded: false, segment: "NSE", manual: true, reviewNotes: null } as any;

describe("a closed trade", () => {
  it("shows the charts kept with it, with its journal, once opened", async () => {
    render(<TradeListItem trade={trade} onSaved={() => {}} />);
    expect(screen.queryByTestId("snapshots")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByTestId("snapshots")).toHaveTextContent("group:t1");
    expect(screen.getByTestId("journal")).toBeInTheDocument();
  });
});
