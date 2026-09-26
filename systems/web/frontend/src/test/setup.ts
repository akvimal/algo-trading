import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { FakeWebSocket } from "./fakeSocket";
import { FakeChart } from "./fakeKlinecharts";

// The chart library needs a canvas, which jsdom lacks: every test gets the recording stand-in.
vi.mock("klinecharts", async () => await import("./fakeKlinecharts"));

beforeEach(() => {
  FakeWebSocket.reset();
  FakeChart.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // jsdom has no layout, so nothing ever resizes: an inert observer is all the chart needs.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});
