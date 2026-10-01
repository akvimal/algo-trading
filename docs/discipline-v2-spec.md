# Discipline v2: a spec for building trading discipline

**Status: SPEC (2026-10-01). Nothing here is built.** It replaces the current discipline score (the 2026-09-09 "plan" redesign: Planned, Stuck-to-plan, Review, Winning) and doubles as the product's value-proposition document. Intraday only for now.

---

## 1. Why this exists (the value proposition)

Most retail intraday traders do not lose because their setups are bad. They lose because of three feelings:

- **Greed:** sizing up, widening the stop, pushing the target further, trading past the day's limit.
- **Fear:** cutting winners short, trailing the stop too close, undersizing after a loss, skipping valid setups.
- **Impatience:** entering before confirmation, chasing, revenge trading, overtrading.

Platforms usually measure results (P&L) and leave behaviour to the trader. This one measures and coaches **behaviour**, on paper first and with the same rules live. The promise to a trader:

> Plan every trade, size it by risk, hold to the plan, and see - in R and in plain words - which feeling costs you money. Build the habits first; the profit follows over the long run.

What makes it a product and not a checklist:

1. **The plan is pre-filled.** Planning costs one or two taps, so discipline is the easy path, not extra work.
2. **The rules are enforced where it matters** (a live stop cannot be widened), and **scored where judgement is needed** (everything else).
3. **Feedback is about process, never profit.** A clean loss is rewarded. A lucky rule-break is not.
4. **It shows the cost of fear and greed in R.** "Your 3 early exits this week left 4.2R on the table."
5. **Credentials mark progress** over a rolling window, so they reflect current habits rather than a banked past.

### What it deliberately is not

- Not a profit leaderboard, not points-per-trade, not a trade-count streak. Nothing rewards trading more.
- Not a lecture. Refusals are one short line. Scores appear in review, not while planning.
- Not a replacement for judgement. A reasoned early exit is allowed and is scored by its reason.

---

## 2. Principles

1. **Score the process, never the P&L.** Expectancy in R is shown separately.
2. **Plan before entry, hold during, review after.**
3. **Hard rules only where the harm is certain** (widening a live stop). Soft scoring elsewhere.
4. **Low friction.** Defaults carry the plan; manual controls exist but stay out of the way.
5. **Measured, not self-reported, wherever possible** (setup verified against the chart, risk computed from the order).
6. **Rolling windows and minimum samples**, so one lucky or unlucky trade moves nothing.

---

## 3. The rules

### 3.1 Risk and size (greed)

| Rule | Behaviour |
|---|---|
| Risk per trade | Configured as a % of capital (default 1%). |
| System sizing | Quantity is calculated from risk % and the stop distance as soon as the stop is set. |
| Using the system quantity | Full adherence. |
| Quantity edited **up** | Adherence falls in proportion to actual risk over allowed risk (1.3x allowed scores about 70%; double scores near zero). |
| Quantity edited **down** | Neutral for one trade. Logged as a fear signal. |
| Habitual undersizing | 3 or more of the last 10 trades under 50% of system quantity: a penalty, tagged fear. |
| Risk re-measured after a stop change | Real risk is recomputed whenever the stop moves, so a wider stop cannot be a backdoor to bigger risk. |
| Adding to a position | Never to a loser. To a winner only if combined risk stays inside the cap. |

### 3.2 Entry quality (patience)

| Rule | Behaviour |
|---|---|
| Stop and target set **before** the order | The stop is mandatory. A missing target is "reward unplanned": partial marks at most. |
| Initial stop and target | **Suggested** (ATR distance or the nearest zone edge) and pre-filled. The trader may change them freely. |
| Planned R:R | Computed at entry once a target exists. Below the configured minimum scores less. It never blocks the order. |
| Setup tag | One from a fixed list, suggested from the chart. **Verified** against the chart: supply/demand entry inside the zone with a rejection candle; breakout entry after a candle close beyond the level; with-trend vs counter-trend from structure and regime. Tagged and verified: full. Tagged but not matching: low. Untagged: zero on this check. |
| Entry style | A limit or wait-for-confirmation order scores above chasing with a market order far from the zone or level. |
| Cooldown after a loss | A visible timer. Entering inside it is allowed and counts against patience. |
| No-trade window and trade cap | Configurable. Breaches count against patience. |
| Waiting credit | An expired unfilled limit order, or a setup skipped because it failed the R:R rule, counts positively. |

### 3.3 Management (greed and fear)

**Stop**
- Once an order is live, the stop **can only move toward price** (tighten). A widening or removal is **refused**, in the ticket and by the server.
- Moving the stop to entry once price reaches +1R is always allowed and never flagged.
- A **tight trail** is a stop closer to price than N x ATR (default 1.0, the trade's own interval). It is allowed and flagged afterwards.
- **Auto-trail** is a one-tap preset: breakeven at +1R, then trail by ATR. A rule-based trail is "planned"; a hand-placed tight trail is "emotional".

**Target**
- A target moved **together with the stop** is a flag, not a score change. Three flags in the last 10 trades produce a deduction and a coaching line.
- A target moved with no stop move is also a flag: closer is fear, further is greed.
- Reaching the target and pushing it out as price arrives is a greed deduction.

**Exit outcome**

| Exit | Management score |
|---|---|
| Target hit, planned R:R met | Full |
| Initial stop hit, nothing moved | Full (a clean loss: the process was right) |
| Target **set**: exit on a rule-based trail at or beyond the planned R | Full (winner) |
| Target **set**: exit on a rule-based trail below the planned R | Partial-high |
| Target **set**: exit on a tight trail below the planned R | Reduced (below a clean loss) |
| Target **not set** (a scalp): exit on any trail, stop and risk cap respected | Full (winner) |
| Manual early exit, no invalidation reason | Reduced, tagged fear |
| Manual early exit with a logged invalidation reason | Scored by the reason |
| Stop widening attempted | Refused; the attempt is recorded and counts against greed |

### 3.4 Day level (patience and greed)

| Rule | Behaviour |
|---|---|
| Daily loss limit | Stopping at the limit scores well. Trading past it is the single worst violation. |
| Review before and after | The existing review habit stays, at a lower weight. |

---

## 4. The score

- Each check is tagged with an emotion. Three sub-scores: **Greed, Fear, Patience**, plus one overall number.
- The overall number is a **rolling average of the last 20 trades**, not one day's value.
- Suggested weights: risk and size 30%, management 30%, entry quality 25%, day level and review 15%.
- "Winning" is removed. Expectancy and the R-multiple by setup are reported alongside, never inside, the score.
- Scores are shown in review. During planning only a quiet status chip appears.

---

## 5. The experience (low friction by design)

**Planning and entering**
- Quantity is calculated, and the quantity box is **shown dimmed** rather than hidden. Changing it is possible and is the visible greed signal.
- Stop and target are suggested as draggable lines. Accepting takes one click.
- The setup tag is proposed from the chart and confirmed in one tap.
- One chip summarises the plan: for example "Planned · R:R 2.1 · risk 1.0%". It does not block and shows no score.

**While open**
- Auto-trail switch with the preset above.
- Widening is refused with one inline line: "The stop can only move toward price once the order is live."
- The cooldown is a timer, not a lock.

**After the trade**
- An auto-written one-line review the trader can accept.
- A one-tap emotion check (calm / fearful / greedy / FOMO) is asked **only after a loss or an early exit**, to keep the habit light.

**Review**
- Three emotion bars and the rolling score.
- One weekly coaching line naming the habit that costs the most, with the what-if in R.
- The what-if after an early exit: computed from candles, whether the target or a higher R was reached afterwards. The mirror case is shown too, when holding to plan beat a tight trail.

---

## 6. Credentials (motivation only, not connected to the live gate)

Rules: reward process, never P&L, volume or trade count. Streaks count clean trades, not days, and survive days off. No celebration on wins. Each credential needs a **minimum sample** and **lapses** if the rolling behaviour slips.

| Credential | Earned by |
|---|---|
| **Risk Keeper** | 20 trades in a row at the system quantity, never above the risk cap |
| **Patient Entry** | 15 trades with a chart-verified setup, entered by limit or confirmation, none in a cooldown |
| **Steady Hands** | 20 trades with no widening attempts and no tight trails |
| **Plan Holder** | 10 trades held to the stop, the target or a rule-based trail |
| **Loss Acceptor** | 10 clean losses: stop untouched, closed on plan |
| **Day Closer** | Stopped at the daily loss limit 3 times with no trades past it |
| **Calm Under Pressure** | Fear tags falling over a rolling 30 trades |

Levels: **Bronze, Silver, Gold** at 20, 50 and 100 qualifying trades.
Anti-gaming: a setup tag only counts when chart-verified; trades under a minimum size do not count toward Risk Keeper; scores are server-computed.
Credentials are **motivation only** for now and are **not** connected to the paper track-record gate for going live. That decision can be revisited later.

---

## 7. Data and technical outline

**New data (execution)**
- A per-position **event log**: every stop and target move with time, price, direction, and who or what made it (user, auto-trail, system).
- Per-trade fields: system quantity vs actual quantity, risk at entry and current risk, planned R:R, tagged setup, whether the chart verified it, order type, exit reason, optional invalidation reason, optional emotion tag.
- Excursions: max favourable and max adverse, and post-exit follow-through (computed from `market-data` candles).

**Server rules**
- The stop-widening refusal lives in `execution`, on the same route the ticket's stop edit uses, so no client can bypass it.
- Tight-trail detection needs the trade interval's ATR; `market-data` already serves candles.
- Setup verification reuses the existing order-block, structure and rejection detection (`app/domain/order_blocks.py`).

**Score**
- Computed server-side from the event log and trade fields, next to the existing performance endpoint, and guarded by golden-fixture tests like the current discipline port.
- Migrations follow the repo's `infra/postgres/migrations` plus `markers.txt` process, dev first.

---

## 8. Build order

1. **Server rules and the event log:** refuse stop widening, record every stop and target move, ATR tight-trail detection.
2. **Ticket pre-fill:** risk-sized quantity (dimmed box), suggested stop and target, setup suggestion, the status chip, and auto-trail.
3. **Scoring:** the three emotion sub-scores, the rolling number, and the what-if exit review with the weekly coaching line.
4. **Emotion tags** after losses and early exits.
5. **Credentials shelf** once there is enough trade history to earn against.

Each step ships and is useful on its own.

---

## 9. Open items to settle during build

- The default N for the tight-trail ATR multiple (proposed 1.0) and the ATR period.
- The exact partial-credit curves for the risk-over-cap and exit-outcome ladders. Proposed numbers above are starting values to tune on real trades.
- Cooldown length, the no-trade window times and the trade cap defaults.
- Whether the weekly coaching line is also sent to Telegram, since that channel already exists for alerts.
- What happens to existing discipline history when the formula changes (recompute, or start a new series).
