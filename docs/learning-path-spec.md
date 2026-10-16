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

## 4. Habit repair catalog (every mistake, for anyone)

The "Fix a habit" door is general: there is one repair module for **each** review tag, so whatever mistake a person's own trades show, the fix exists.
Each module has the same four parts: the **rule** (one sentence), the **why** (what it costs), a **drill** (the next N trades), and a **measure**.
A habit counts as **fixed after 10 clean trades** in a row (no trade carrying that tag; 10 is confirmed, and the same for every tag).

"Auto" = the app detects it from the order and its history, so the drill ticks itself. "Self" = only the person's own review tag shows it today, so the
drill depends on honest reviewing (and the entry context saved with the order can later turn some of these into auto).

### Study

| Tag | Rule | Drill | Measured |
|---|---|---|---|
| `against_trend` | Read the trend on your context interval first. Trade with it, or write the reason before sending. | 10 trades, none against the context trend | Auto, from the regime and trend saved with the order (a higher-timeframe read is not saved yet) |
| `ignored_regime` | Look at the regime and OI read before every entry. In a ranging regime, use a range approach or a smaller size. | 10 trades each with the context read saved | Auto: the entry context is present; plus the tag |
| `event_risk` | Check the calendar before entering. No new entry just before a scheduled event unless that is the plan. | 10 trades, calendar checked each time | Self today. Becomes auto once the calendar read is saved with the order |
| `wrong_setup` | Trade only setups you have named, and name it on the order. | 10 trades each with a setup tag | Auto: setup tag present; plus the tag |
| `impulse` | Pause and write the one-line reason before ordering. No reason, no order. | 10 trades each with a setup tag and a confidence score | Auto: market entry with no setup tag or confidence; plus the tag |

### Plan

| Tag | Rule | Drill | Measured |
|---|---|---|---|
| `no_stop` | The stop goes on the order itself, never afterwards. | 10 orders with a stop at order time | Auto |
| `no_target` | Set a target before entry. | 10 orders with a target | Auto |
| `low_rr` | Skip a trade whose reward-to-risk is below your minimum. | 10 trades all at or above the minimum | Auto, against the account's minimum |
| `oversized` | Size from the risk you will lose if the stop hits, not from conviction. | 10 trades within the per-trade risk limit | Auto |
| `chased` | Put a limit order at the planned pullback. If the price never gets there, let the trade go: missing it costs nothing. | 10 entries, at most 3 at market | Auto: order type, and entry versus the planned level |
| `no_exit_rule` | Know how you will exit (stop, target, trail, time) before you enter. | 10 trades each with an exit attached | Auto: a target, trail, time or condition exit exists |

### Execution

| Tag | Rule | Drill | Measured |
|---|---|---|---|
| `stop_moved` | A stop only ever moves toward profit. Never widen it or remove it. | 10 trades with no widened or cleared stop | Auto, from the stop move history |
| `exited_early` | Let the stop or target close the trade. Closing by hand needs a written reason. | 10 trades with no early manual exit | Auto: closed by hand before the stop or target |
| `held_past_plan` | When the plan says exit (target, time, condition), exit. | 10 trades closed at their plan | Auto where the plan has a target or time; otherwise self |
| `added_to_loser` | Never add to a position that is losing. | 10 trades with no add to a loser | Self today (no automatic check yet) |
| `revenge` | After a loss, wait before the next entry (a cool-off you choose). | 10 trades, none inside the cool-off after a loss | Auto: a new entry soon after a loss |
| `broke_limits` | The daily loss limit, trade cap and session window are not negotiable. | 10 days within the limits | Auto |

### How a person gets a repair list
1. Review the closed trades (every unreviewed trade comes first, since the list is only as good as the tags).
2. The page ranks tags by money lost and by how recently they happened.
3. The person picks one, does the module, then the drill. The page shows "trades since you last made this mistake" until it reaches 10.
4. One habit at a time is the default; the page suggests the earliest level first (study, then plan, then execution), as an earlier failure explains the later ones.

### Illustration: one person's case
Someone who misses the larger picture, hops between chart intervals, enters at market and sets the stop afterwards, and neither plans nor reviews.
They would be offered, in order: `against_trend` / `ignored_regime` (study), then `chased` and `no_stop` (plan), then the review habit (the inbox
to-do). Two things they need that are not tags yet are the **trading style** pair of intervals and **guardrail mode** (section 6): "hops between
intervals" is checked against the interval pair they declare, which is why that setting exists. This is an example only; the catalog above is the same for
everyone.

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
5. The repair modules from the section 4 catalog, most common mistakes first.
6. Strategy modules, starting with manual chart-setup trading.
7. "?" links, the personal entry warning, then the remaining fundamentals.

## 10. Decisions

Settled:
- "Fixed" means **10 clean trades** for every tag.

Still to choose (each has a default, used if nothing is said):
- **Starting interval pair** for each person: they pick their own two intervals (the table in 6.1 is only a suggestion). Default: ask on first use.
- **Guardrail overrides and the score:** whether overriding a guardrail should lower the Planned part of the discipline score. Default: no, record it only.
- **How many lessons to write first:** default is the lessons that unlock the most common tags first (`no_stop`, `low_rr`, `chased`, `against_trend`, `impulse`, review), then the rest as people open them.
