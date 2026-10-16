# Learn: the learning path, habit fixes and guardrails (spec)

Status: **design only, nothing built** (2026-10-16). This describes the Learn page in the web app, from the learner's point of view.
It builds on [discipline-v2-spec.md](discipline-v2-spec.md) (the habit score), the post-trade review by cause (`app/domain/trade_review.py`, migration 065),
the live-eligibility checks (`app/domain/track_record.py`) and the in-app inbox (migration 066).

## 1. Purpose

Make the app teach the *process* of trading, and prove the learning with the person's own trades, so that the discipline score rises and the person is
ready for live trading on evidence, not on having read something.

Principles:

1. **Process, never promises.** Lessons teach risk, planning and follow-through. They never say what to buy and never imply an edge. (Our own swing research,
   `project_swing_research_no_edge`, found no robust net edge; the lessons say so plainly.)
2. **Measured, not self-reported.** A drill ticks itself from what the person actually did (their orders and reviews). Nobody marks a lesson "done" by hand, and
   reading a lesson counts for nothing on its own.
3. **Everything leads to discipline.** Every lesson names the discipline component it moves and the review tags it should reduce.
4. **Learning never unlocks live trading.** Readiness shows the real live-eligibility checks. No lesson or drill can bypass them.
5. **Start from where the person is.** A newcomer follows a path; someone who already trades and makes specific mistakes goes straight to fixing them.

## 2. The chain every lesson hangs on

The same three levels as the post-trade review. An earlier failure explains the later ones, so lessons run in this order.

| Level | Question | Review tags (slugs) |
|---|---|---|
| **Study** | Did you analyse it before entering? | `against_trend`, `ignored_regime`, `event_risk`, `wrong_setup`, `impulse` |
| **Plan** | Did you define the trade before entering? | `no_stop`, `no_target`, `low_rr`, `oversized`, `chased`, `no_exit_rule` |
| **Execution** | Did you follow the plan? | `stop_moved`, `exited_early`, `held_past_plan`, `added_to_loser`, `revenge`, `broke_limits` |

Discipline components (v2): **Planned** (limit order with a stop, weight 1), **Stuck to plan** (2), **Review before and after** (2), **Winning** (1).

## 3. Two ways in

### 3.1 Learning path (newcomers, fixed order)

| Stage | Theme | Content |
|---|---|---|
| 1 | Fundamentals | Paper vs live. How a trade loses. Stop, target, reward-to-risk. Position size and risk per trade. Costs and slippage. What the regime, trend and OI reads mean. |
| 2 | Plan before you click | The plan checklist. **Always set a stop.** Then target, size, and why to wait for a limit entry. |
| 3 | One strategy at a time | One module per approach the app supports (section 5). |
| 4 | Follow the plan | Not moving stops. Not exiting early. Not revenge trading. Daily limits. |
| 5 | Review and graduate | Study / plan / execution review. The cost view. The live-readiness checklist. |

### 3.2 Fix a habit (people who already trade)

1. Read the person's *reviewed* trades and rank their mistake tags by money lost, e.g. "No stop: 6 trades, -14,200".
2. Each mistake opens a short **repair module**: why it hurts, the rule, the practice drill.
3. Unreviewed trades come first as "review these before the list is accurate" (the list is only as good as the tags).
4. A habit counts as **fixed after a clean run** (default 10 trades without the tag), not after reading. The page shows "trades since you last made this mistake".

## 4. Worked example: one person's behaviours

A real case that shaped this spec. The person:

- misses the larger picture,
- changes the chart interval from trade to trade instead of fixing one that suits their style,
- usually enters at **market**, then sets the stop afterwards (impulsive; a limit order at the likely pullback was available),
- has no plan beforehand and does no review afterwards.

| Behaviour | Level | Tags | Measured from |
|---|---|---|---|
| Misses the larger picture | Study | `against_trend`, `ignored_regime`, `wrong_setup` | The entry context saved with the order (regime, trend, ADX); a higher-timeframe read is **not saved yet** |
| Interval hopping | Study | `wrong_setup`, `impulse` | `entry_interval` on each order (stored on positions and option groups); not compared to anything yet |
| Market entry, then stop | Plan | `chased`, `no_stop`, `impulse` | `order_type`, and whether the stop was present at order time (the stop-move history shows a stop added after entry) |
| No plan, no review | Plan / Execution | unreviewed to-do | Review time against exit time |

Their repair path: four modules, in dependency order.

1. **Pick your two intervals.**
   Declare one *trading interval* (where you enter) and one *context interval* (the bigger picture, one or two steps up). Why a fixed pair matters.
   Drill: the next 10 trades are all entered on the trading interval, each after looking at the context read.
   Measured: number of distinct entry intervals in the last 10 entries (goal: 1).
2. **Read the bigger picture first.**
   The context trend, structure and OI in about a minute. Rule: no trade against the context without a written reason.
   Measured: `against_trend` and trades since the last one.
3. **Wait for the pullback.**
   Mark the pullback zone before entering. Place a **limit order there with the stop attached in the same order.** A trade that never pulls back is one you let go; missing it costs nothing.
   Measured, over the last 10 entries: share that were market orders (goal at most 30%, adjustable) and share with a stop at order time (goal 100%).
4. **Review every trade within a day.**
   The one-tap "what went wrong". Measured: share reviewed within 24 hours of closing; the inbox to-do and Telegram nudge chase the rest.

## 5. Strategy modules

One template for every module, so they can be compared:

1. What it is, and when it works or fails (tied to the regime read).
2. Entry.
3. **Stop (always)**, target, size.
4. Exit rules.
5. The usual mistakes, shown as the review tags above.
6. A practice drill, measured from the trades.

Modules cover only approaches the app really has:

- Manual trades from chart setups (order blocks, fair value gaps, structure; the order-block setup engine).
- Option buying and debit spreads.
- The credit-spread bot (spread bot).
- The SuperTrend auto-trader.
- The weekly options advisor.

First one to write: manual chart-setup trading, since the person's review data comes from it.

## 6. Trading style and guardrail mode

### 6.1 Trading style (a per-person setting)

- **Trading interval** and **context interval**, chosen from the chart intervals. Suggested pairs (a starting point, the person decides):

  | Trading interval | Context interval |
  |---|---|
  | 5 min | 1 hour |
  | 15 min | 1 hour or 4 hours |
  | 1 hour | 1 day |
  | 1 day | 1 week |

- The ticket shows the context read ("up on 1h") before an order is sent.
- Entering on any other interval shows a one-line notice. It never blocks on its own.

### 6.2 Guardrail mode (optional, off by default, the person turns it on)

Applies *as per the interval concerned*: the checks are made against the person's declared pair, not against whatever chart happens to be open.

When on, the ticket will not send an order until:

1. the order is placed on the **trading interval** (or the person picks "I'm trading outside my style", which is recorded and shows as a tag suggestion);
2. the **context read** (on the context interval) has been shown, and an order against it needs a short written reason;
3. the order is a **limit** order (a market order needs "market entry, on purpose" confirmed);
4. a **stop** is set *in the same order*, not afterwards;
5. a **target** is set, and reward-to-risk meets the person's minimum.

Every override is recorded, so the data shows how often the guardrails were overridden. Turning guardrails off is allowed and is not penalised in the score, but is itself recorded.

### 6.3 Entry-time warning (the unbuilt "phase 5"), made personal

Once enough tagged trades exist, the ticket warns using the person's own record, e.g. "8 of your last 10 entries were market orders" or "3 of your last 10 were against the context". Informational only.

## 7. Measures (definitions)

All computed server-side from existing data, over the person's closed manual trades (auto-trader and strategy fills excluded, as in the discipline score).

| Measure | Definition |
|---|---|
| Interval consistency | Distinct `entry_interval` values among the last 10 entries |
| Market-entry share | Market orders / last 10 entries |
| Stop at order time | Entries whose stop existed on the order itself / last 10 |
| Context-aligned | Entries with against-trend not suggested / last 10 (needs the context read to be saved) |
| Review latency | Share reviewed within 24 h of exit |
| Trades since last X | Closed trades since the person last carried tag X (as on the mistake-cost card) |
| Fixed | Clean run of 10 (adjustable) for that tag |

## 8. Readiness (top of the page)

- The live-eligibility checks (trades with costs, track record, drawdown, discipline and so on), each with "what this means" and a link to the module or fix that clears it.
- Portfolio keeps a small status card linking here; the full list lives on Learn only.
- Live trading stays gated by the real checks (`REQUIRE_PAPER_TRACK_RECORD` and the consent, caps, credentials and kill-switch gate). Completing lessons changes none of them.

## 9. Delivery

- **Where:** a **Learn** row in the sidebar's main list; under More on a phone (the bottom bar is full at five).
- **Lesson content:** plain text files kept in the repo and versioned, not in the database.
- **Progress:** which lessons were opened, kept in the browser first; saved to the profile later. Drills and fixed-habit progress come from trade data, not from this.
- **Contextual help:** small "?" links on the ticket, the discipline gauge and the review screen open the matching lesson.

### Build order

1. Learn page: readiness, plus "Fix a habit" ranked from real mistake data (no new writing needed).
2. Trading style setting, and the measures in section 7 (including saving the higher-timeframe read with the order).
3. Lesson format and drill tracking, with three lessons: "always set a stop", "reward-to-risk", "against the trend".
4. Guardrail mode on the ticket.
5. The four repair modules from section 4.
6. Strategy modules, starting with manual chart-setup trading.
7. "?" links, the personal entry warning, then the remaining fundamentals.

## 10. Open decisions

- The person's trading and context intervals (or accept a suggested pair).
- The "fixed" bar: 10 clean trades is the proposal.
- The goal for market-entry share (at most 30% proposed).
- Whether guardrail overrides should lower the Planned component of the discipline score or stay purely informational (proposed: informational).
- How many lessons to write before launch (proposed: about 10 core ones, then add based on what gets opened).
