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

Fundamentals come first, because every habit fix assumes the person can already read a chart. The order on the page:

| Part | Theme | Content |
|---|---|---|
| **A** | Fundamentals of reading the market | Trends, ranges, support and resistance, structure, multi-timeframe analysis, OI and volume (syllabus below) |
| **B** | Risk and the trade plan | Stops, size, reward-to-risk, order types, the plan checklist, costs |
| **C** | Habits | Journaling, review, the repair catalog (section 4), discipline and psychology |
| **D** | One strategy at a time | One module per approach the app supports (section 5) |
| **E** | Ready for live | The readiness checklist (section 8) |

Part A is where the *study* level of the review chain is taught; B is *plan*; C is *execution* and the review loop.

#### Part A: fundamentals syllabus

Every lesson has four parts: **Learn** (the key ideas, about a minute of reading), **See it in the app** (where the idea shows up on screen),
**Practice** (a small exercise on paper money or on a chart) and **Done when** (a measured check where possible, otherwise a self-check).

| # | Lesson | Learn | See it in the app | Practice | Done when |
|---|---|---|---|---|---|
| A1 | What you are trading | Spot, futures and options in plain terms; lots and expiry; NSE, MCX and crypto; paper vs live | The segment switch; the paper account | Open a paper position in each instrument type the person will use, then close it | One paper trade closed in each chosen instrument |
| A2 | Reading a chart | Candles (open, high, low, close), what an interval is, how the same move looks on different intervals | The live chart and its interval switch | Look at one symbol on three intervals and write what changes | Self-check |
| A3 | Trends | An uptrend is higher highs and higher lows, a downtrend the reverse; why trends persist; how to tell a strong trend from a weak one | The regime badge (ADX and direction) and the trend read on the ticket | Pick five symbols on one interval. For each call it up, down or range, *then* reveal the app's read and compare | Calls agree with the app on 4 of 5 (self-check; it is a learning aid, not a score) |
| A4 | Ranges | Price bouncing between a floor and a ceiling; false breakouts; why a trend method loses in a range | The ranging regime; the zone drawings | Draw the range boundaries on one chart with the rectangle tool; wait for a break and note whether it held | One range drawn and checked later |
| A5 | Support, resistance and zones | Levels price reacts to; supply and demand zones; why a zone is an area, not a line | Auto-detected order blocks and fair value gaps ("Structure" menu) | Mark three levels by hand, then turn on the detected zones and compare | Self-check |
| A6 | Market structure | Break of structure and change of character; how a trend ends; what a pullback is and why it is where entries live | BOS and CHoCH marks, confirmed trend, the pullback zones | On one chart, find the last two structure breaks and say whether the trend changed | Self-check |
| A7 | **Multi-timeframe analysis** | Why the larger picture matters; the top-down method (context, then trading, then optionally entry); keeping the intervals about 4 to 6 times apart; when the intervals agree and when they conflict | The structure view on a chosen interval; the context read; the trading-style pair (section 6.1) | On three symbols: read the context interval first, write the bias, then read the trading interval and say whether it agrees. Repeat with a conflict case | Context read written before the trade on 5 paper trades (measured once the context read is saved with the order) |
| A8 | Open interest and volume | What OI shows; buying vs writing; PCR; how price agreeing with OI strengthens a read | The OI sentiment badges and the OI strip on the chart | For one F&O stock, read the OI labels and price together and say who is in control | Self-check |
| A9 | Events and news | Earnings, results, expiry day, policy days; why risk jumps around a scheduled event | The economic calendar | Find the next three events for a symbol and decide whether to avoid or plan around each | Self-check |

Part B (risk and the plan) follows the same four-part format:

| # | Lesson | Learn | See it in the app | Practice | Done when |
|---|---|---|---|---|---|
| B1 | Risk first | Risk per trade as a share of the account; why survival comes before profit; drawdown and why a 50% loss needs a 100% gain | The loss budget on Today; risk limits in Settings | Set a per-trade risk limit that suits the paper account | A limit saved in Settings |
| B2 | Stops | A stop belongs where the idea is wrong (beyond structure), not at a convenient distance; always on the order | The stop field on the ticket; the stop line on the chart | Place a stop beyond the last swing on three paper trades | 3 trades with a structure-based stop at order time (auto) |
| B3 | Targets and reward-to-risk | R multiples; why 1:1 needs a high win rate; expectancy in a sentence | Reward-to-risk on the ticket; the account's minimum | Compute R for five past trades | Self-check |
| B4 | Position size | Size from the stop distance and the risk limit | Auto-sizing on the ticket | Compare the size at two different stop distances | Self-check |
| B5 | Order types | Market, limit and stop orders; slippage; why a limit order at a pullback beats chasing; what a waiting order is | Waiting (limit) orders in the ticket | Place two limit entries at a pullback zone and see them fill or not | 2 waiting orders placed |
| B6 | Costs | Brokerage, taxes, slippage; why a small edge can vanish | Charges and slippage on the closed trade | Open one closed trade and read its cost breakdown | Self-check |
| B7 | The trade plan | The plan checklist: context, setup, entry, stop, target, size, exit; a setup tag and a confidence score before entering | The plan checklist and the setup/confidence fields | Write a full plan for three trades before placing any | 3 trades with a plan, setup tag and confidence (auto) |

Part C starts with **C1 Journaling and review** (study, plan, execution, the one-tap review) and **C2 Discipline and psychology** (fear of missing out,
revenge, overtrading, daily limits), and then the repair catalog in section 4.

Each lesson names the discipline component it supports and the tags it prevents; for example A3, A6 and A7 prevent `against_trend` and `ignored_regime`,
B2 prevents `no_stop`, B5 prevents `chased`.

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

### How to practice a habit (the same method for every tag)

1. **Read the rule and its fundamentals first.** Each repair module names the Part A and B lessons it depends on (for example `against_trend` needs A3, A6, A7;
   `chased` needs B5 and A6; `no_stop` needs B2).
2. **One habit at a time.** Pick the tag costing the most. Everything else is trade as usual; this one rule is the focus for the next 10 trades.
3. **Practice on paper first**, even for someone who has traded live before. The drill runs on the paper account, with the guardrail (section 6.2) turned on for
   the rule being practised if the person wants the friction.
4. **Review each trade against that one rule** (the one-tap review). A trade that breaks it resets the count.
5. **The counter** ("3 of 10 clean") sits on the Learn page and on the trade ticket; reaching 10 marks the habit fixed and offers the next one.
6. **Fixed is not forever**: the page keeps watching the tag, and shows "back on the list" if it returns in a later trade.

### How a person gets a repair list
1. Review the closed trades (every unreviewed trade comes first, since the list is only as good as the tags).
2. The page ranks tags by money lost and by how recently they happened.
3. The person picks one, does the module, then the drill. The page shows "trades since you last made this mistake" until it reaches 10.
4. One habit at a time is the default; the page suggests the earliest level first (study, then plan, then execution), as an earlier failure explains the later ones.

### Fundamentals each habit depends on

| Habit tags | Read first |
|---|---|
| `against_trend`, `ignored_regime` | A3 Trends, A4 Ranges, A6 Structure, A7 Multi-timeframe |
| `wrong_setup`, `impulse` | A5 Zones, B7 The trade plan |
| `event_risk` | A9 Events and news |
| `no_stop`, `low_rr`, `oversized`, `no_target`, `no_exit_rule` | B1 to B4, B7 |
| `chased` | A6 Structure, B5 Order types |
| `stop_moved`, `exited_early`, `held_past_plan`, `added_to_loser`, `revenge`, `broke_limits` | B1, C1, C2 |

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

1. Learn page shell: the Part A to E structure, readiness at the top, and "Fix a habit" ranked from real mistake data (no new writing needed).
2. Lesson format (Learn, See it in the app, Practice, Done when) and the drill tracking.
3. **Part A fundamentals, A1 to A9** (written first, since everything else depends on them), starting with A3 Trends, A4 Ranges and A7 Multi-timeframe.
4. Trading style setting (the interval pair), saving the higher-timeframe read with the order, and the measures in section 7.
5. Part B, risk and the plan (B1 to B7).
6. Guardrail mode on the ticket.
7. The repair modules from the section 4 catalog, most common mistakes first, with Part C.
8. Strategy modules (Part D), starting with manual chart-setup trading.
9. "?" links, the personal entry warning, and the remaining lessons.

## 10. Decisions

Settled:
- "Fixed" means **10 clean trades** for every tag.

Still to choose (each has a default, used if nothing is said):
- **Starting interval pair** for each person: they pick their own two intervals (the table in 6.1 is only a suggestion). Default: ask on first use.
- **Guardrail overrides and the score:** whether overriding a guardrail should lower the Planned part of the discipline score. Default: no, record it only.
- **How many lessons to write first:** default is the lessons that unlock the most common tags first (`no_stop`, `low_rr`, `chased`, `against_trend`, `impulse`, review), then the rest as people open them.
