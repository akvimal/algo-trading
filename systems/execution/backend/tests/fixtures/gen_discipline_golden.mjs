// Regenerates discipline_golden.json by running the REAL frontend implementation
// (manual-trading/frontend/src/discipline.ts) over seeded scenarios. The server's
// Python port (app/domain/performance.py, compute_discipline) is tested against
// this file, so any drift between the two shows up as a failing test.
//
//   TZ=Asia/Kolkata node gen_discipline_golden.mjs
//
// TZ must be Asia/Kolkata: discipline.ts derives day boundaries from the local
// clock and the server buckets days in EQUITY_HISTORY_TIMEZONE (default IST).
// Needs Node 22.6+ (native type stripping); discipline.ts uses only erasable syntax.
import { writeFileSync } from "node:fs";
import { computeDisciplineScore } from "../../../../manual-trading/frontend/src/discipline.ts";

if (!["Asia/Kolkata", "Asia/Calcutta"].includes(Intl.DateTimeFormat().resolvedOptions().timeZone)) { // ICU may report the legacy alias
  throw new Error("run with TZ=Asia/Kolkata");
}

let seed = 20260925;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const between = (a, b) => a + rnd() * (b - a);

function trade(baseDay, spanDays) {
  const entry = rnd() < 0.15 ? null : Math.round(between(80, 900) * 100) / 100;
  const stopKind = rnd();
  let stop = null;
  if (entry != null) {
    if (stopKind < 0.55) stop = Math.round((entry - between(1, 30)) * 100) / 100;
    else if (stopKind < 0.65) stop = entry; // equal to entry -> no R
  }
  const t = new Date(Date.UTC(2026, 8, baseDay, 0, 0, 0) + Math.floor(between(0, spanDays * 86400000)));
  const pnlKind = rnd();
  return {
    segment: "NSE",
    pnl: pnlKind < 0.08 ? null : pnlKind < 0.14 ? 0 : Math.round(between(-900, 1200) * 100) / 100,
    entry_price: entry,
    stop_loss_price: stop,
    target_price: rnd() < 0.5 ? Math.round(between(80, 900) * 100) / 100 : null,
    quantity: rnd() < 0.1 ? null : pick([1, 10, 25, 50, 75, 100]),
    exit_time: t.toISOString(),
    exit_reason: pick(["manual", "stop_loss", "target", "square_off", "counter_signal", null]),
    order_type: pick(["limit", "market", null]),
    entry_setup_tag: pick(["breakout", "pullback", "", null]),
    entry_confidence: pick([1, 2, 3, 4, 5, null]),
    setup_tag: pick(["breakout", "pullback", "", null]),
    confidence: pick([1, 2, 3, 4, 5, null]),
    reviewed: rnd() < 0.5,
    auto_traded: rnd() < 0.12,
  };
}

const cases = [];
const add = (name, days, trades) => cases.push({ name, days, trades, expected: computeDisciplineScore(trades, [], days) });

add("empty", 30, []);
for (const n of [1, 4, 5, 6, 12, 40, 90]) {
  for (const days of [1, 3, 7, 30]) {
    add(`n${n}_days${days}`, days, Array.from({ length: n }, () => trade(1 + Math.floor(rnd() * 5), 20)));
  }
}
add("all_auto", 30, Array.from({ length: 8 }, () => ({ ...trade(1, 10), auto_traded: true })));
add("all_manual_bailed", 30, Array.from({ length: 6 }, () => ({ ...trade(1, 10), order_type: "limit", stop_loss_price: 90, entry_price: 100, exit_reason: "manual", auto_traded: false, pnl: 50 })));
// a perfectly disciplined record: limit + stop, let run, declared before and reviewed after, winners at 2R+
add("perfect", 30, Array.from({ length: 10 }, (_, i) => ({
  segment: "NSE", pnl: 400, entry_price: 100, stop_loss_price: 90, target_price: 130, quantity: 20,
  exit_time: new Date(Date.UTC(2026, 8, 1 + i, 6, 0, 0)).toISOString(), exit_reason: "target", order_type: "limit",
  entry_setup_tag: "breakout", entry_confidence: 4, setup_tag: "breakout", confidence: 4, reviewed: true, auto_traded: false,
})));
// day-boundary trades: 23:59 and 00:01 IST sit on different local days but share a UTC day
add("ist_boundary", 2, [
  ...Array.from({ length: 3 }, (_, i) => ({ ...trade(1, 1), exit_time: `2026-09-10T18:29:0${i}Z`, pnl: 10 })), // 23:59 IST on the 10th
  ...Array.from({ length: 3 }, (_, i) => ({ ...trade(1, 1), exit_time: `2026-09-10T18:31:0${i}Z`, pnl: -10 })), // 00:01 IST on the 11th
]);

writeFileSync(new URL("./discipline_golden.json", import.meta.url), JSON.stringify(cases, null, 1));
console.log(`wrote ${cases.length} cases`, "scores:", cases.map((c) => c.expected.score).filter((s) => s != null).length, "non-null");
