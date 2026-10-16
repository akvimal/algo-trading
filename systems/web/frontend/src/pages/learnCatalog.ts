import type { RootCause } from "../api/types";

/** The content behind the Learn page (docs/learning-path-spec.md). Plain data, so lessons and rules can be edited without touching the screens. */

export type Level = Exclude<RootCause, "clean">;

/** One repair module per review tag (the slugs of app/domain/trade_review.py). `auto` = the app can see it from the order and its history,
 * so the drill counts itself; otherwise it depends on the person's own review tags. */
export type Habit = { tag: string; level: Level; rule: string; why: string; drill: string; auto: boolean; readFirst: string[] };

export const HABITS: Habit[] = [
  // ---- study
  { tag: "against_trend", level: "study", auto: true, readFirst: ["A3", "A4", "A6", "A7"],
    rule: "Read the trend on your context interval first. Trade with it, or write the reason before sending.",
    why: "Trading against the larger move means every pullback is the market's, not yours.",
    drill: "10 trades, none against the context trend." },
  { tag: "ignored_regime", level: "study", auto: true, readFirst: ["A3", "A4", "A7", "A8"],
    rule: "Look at the regime and OI read before every entry. In a ranging market use a range approach or a smaller size.",
    why: "A trend method in a range, or the reverse, loses even when the idea is sound.",
    drill: "10 trades, each with the context read saved on the order." },
  { tag: "event_risk", level: "study", auto: false, readFirst: ["A9", "A10", "A12"],
    rule: "Check the calendar before entering. No new entry just before a scheduled event unless that is the plan.",
    why: "A scheduled event can move price far past any stop in seconds.",
    drill: "10 trades, calendar checked before each." },
  { tag: "wrong_setup", level: "study", auto: true, readFirst: ["A5", "B7"],
    rule: "Trade only setups you can name, and name it on the order.",
    why: "A trade with no named setup cannot be reviewed, so it cannot be improved.",
    drill: "10 trades, each with a setup tag." },
  { tag: "impulse", level: "study", auto: true, readFirst: ["B7", "C2"],
    rule: "Pause and write the one-line reason before ordering. No reason, no order.",
    why: "Trades taken on a tip or a twitch have no plan to follow or to review.",
    drill: "10 trades, each with a setup tag and a confidence score." },
  // ---- plan
  { tag: "no_stop", level: "plan", auto: true, readFirst: ["B1", "B2", "B7"],
    rule: "The stop goes on the order itself, never afterwards.",
    why: "A stop set later is a stop set under stress, usually wider than the plan.",
    drill: "10 orders, each with a stop at order time." },
  { tag: "no_target", level: "plan", auto: true, readFirst: ["B3", "B7"],
    rule: "Set a target before you enter.",
    why: "Without a target there is no reward-to-risk, and exits are decided by feelings.",
    drill: "10 orders, each with a target." },
  { tag: "low_rr", level: "plan", auto: true, readFirst: ["B3"],
    rule: "Skip a trade whose reward-to-risk is below your minimum.",
    why: "Low reward-to-risk needs a very high win rate just to break even.",
    drill: "10 trades, all at or above your minimum." },
  { tag: "oversized", level: "plan", auto: true, readFirst: ["B1", "B4"],
    rule: "Size from the risk you will lose if the stop hits, not from conviction.",
    why: "One oversized loss can undo many correct small ones.",
    drill: "10 trades, all within your per-trade risk limit." },
  { tag: "chased", level: "plan", auto: true, readFirst: ["A6", "B5"],
    rule: "Put a limit order at the planned pullback. If price never gets there, let the trade go: missing it costs nothing.",
    why: "Market entries after a move buy the worst price and put the stop far away.",
    drill: "10 entries, at most 3 at market." },
  { tag: "no_exit_rule", level: "plan", auto: true, readFirst: ["B2", "B3", "B7"],
    rule: "Know how you will exit (stop, target, trail or time) before you enter.",
    why: "Without an exit rule the exit becomes whatever feels right at the time.",
    drill: "10 trades, each with an exit attached." },
  // ---- execution
  { tag: "stop_moved", level: "execution", auto: true, readFirst: ["B1", "C1", "C2"],
    rule: "A stop only ever moves toward profit. Never widen it or remove it.",
    why: "Moving a stop turns a planned small loss into an unplanned large one.",
    drill: "10 trades with no widened or cleared stop." },
  { tag: "exited_early", level: "execution", auto: true, readFirst: ["B3", "C2"],
    rule: "Let the stop or target close the trade. Closing by hand needs a written reason.",
    why: "Cutting winners early while letting losers run reverses the arithmetic of the plan.",
    drill: "10 trades with no early manual exit." },
  { tag: "held_past_plan", level: "execution", auto: false, readFirst: ["B3", "C2"],
    rule: "When the plan says exit (target, time, condition), exit.",
    why: "Holding past the plan is hope, not a decision.",
    drill: "10 trades closed at their plan." },
  { tag: "added_to_loser", level: "execution", auto: false, readFirst: ["B1", "C2"],
    rule: "Never add to a position that is losing.",
    why: "Adding to a loser makes the next move against you hurt twice as much.",
    drill: "10 trades with no add to a loser." },
  { tag: "revenge", level: "execution", auto: true, readFirst: ["C1", "C2"],
    rule: "After a loss, wait before the next entry. Choose the cool-off in advance.",
    why: "The trade right after a loss is the one most often taken to win it back, not on a setup.",
    drill: "10 trades, none inside your cool-off after a loss." },
  { tag: "broke_limits", level: "execution", auto: true, readFirst: ["B1", "C2"],
    rule: "The daily loss limit, the trade cap and the session window are not negotiable.",
    why: "Limits exist for the day your judgement is worst, which is the day you want to break them.",
    drill: "10 trading days within all limits." },
];

export const HABIT_BY_TAG: Record<string, Habit> = Object.fromEntries(HABITS.map((h) => [h.tag, h]));

export type Lesson = { id: string; title: string; blurb: string };
export type Part = { id: string; title: string; blurb: string; lessons: Lesson[] };

/** The learning path. The lessons themselves are written one at a time (see the build order in the spec); until then each is listed, not linked. */
export const PARTS: Part[] = [
  {
    id: "A", title: "Reading the market", blurb: "Trends, ranges, structure, multi-timeframe analysis, and what moves prices.",
    lessons: [
      { id: "A1", title: "What you are trading", blurb: "Spot, futures, options; lots and expiry; paper vs live." },
      { id: "A2", title: "Reading a chart", blurb: "Candles, intervals, and how one move looks on different intervals." },
      { id: "A3", title: "Trends", blurb: "Higher highs and lows, strong against weak, the regime read." },
      { id: "A4", title: "Ranges", blurb: "Floors, ceilings, false breakouts, and why a trend method loses in a range." },
      { id: "A5", title: "Support, resistance and zones", blurb: "Levels, supply and demand zones, order blocks and gaps." },
      { id: "A6", title: "Market structure", blurb: "Breaks of structure, change of character, and pullbacks." },
      { id: "A7", title: "Multi-timeframe analysis", blurb: "The larger picture first: context, then trading interval." },
      { id: "A8", title: "Open interest and volume", blurb: "Buying against writing, PCR, and price agreeing with OI." },
      { id: "A9", title: "Events and news", blurb: "Results, expiry, policy days, and why risk jumps around them." },
      { id: "A10", title: "What moves the market", blurb: "CPI, RBI rate, the Fed, crude, the rupee, yields, flows, VIX." },
      { id: "A11", title: "Reading the pre-market card", blurb: "Overnight US close, ADRs and the GIFT Nifty gap as a lean." },
      { id: "A12", title: "The calendar and the news", blurb: "Expected against actual, priced in, and waiting for confirmation." },
    ],
  },
  {
    id: "B", title: "Risk and the trade plan", blurb: "Stops, targets, size, order types and writing the plan.",
    lessons: [
      { id: "B1", title: "Risk first", blurb: "Risk per trade, survival before profit, drawdown." },
      { id: "B2", title: "Stops", blurb: "A stop goes where the idea is wrong, and always on the order." },
      { id: "B3", title: "Targets and reward-to-risk", blurb: "R multiples and expectancy in a sentence." },
      { id: "B4", title: "Position size", blurb: "Size from the stop distance and the risk limit." },
      { id: "B5", title: "Order types", blurb: "Market, limit and stop; slippage; waiting at the pullback." },
      { id: "B6", title: "Costs", blurb: "Brokerage, taxes and slippage, and why a small edge can vanish." },
      { id: "B7", title: "The trade plan", blurb: "The checklist, a setup tag and a confidence score before entering." },
    ],
  },
  {
    id: "C", title: "Habits and discipline", blurb: "Journaling, review, and fixing one habit at a time.",
    lessons: [
      { id: "C1", title: "Journaling and review", blurb: "Study, plan, execution: the one-tap review." },
      { id: "C2", title: "Discipline and psychology", blurb: "Fear of missing out, revenge, overtrading, daily limits." },
    ],
  },
  {
    id: "D", title: "One strategy at a time", blurb: "Each approach the app supports: entry, stop, target, size, exits, usual mistakes.",
    lessons: [
      { id: "D1", title: "Manual trades from chart setups", blurb: "Order blocks, gaps and structure." },
      { id: "D2", title: "Option buying and debit spreads", blurb: "Defined risk, time decay and expiry." },
      { id: "D3", title: "The credit-spread bot", blurb: "What it does, its limits, and how to read its log." },
      { id: "D4", title: "The SuperTrend auto-trader", blurb: "Rules, risks and where it fails." },
      { id: "D5", title: "The weekly options advisor", blurb: "Regime and OI based picks, and how to journal them." },
    ],
  },
];

/** What each live-readiness check means in plain words, and where to work on it. Keys are the server's requirement keys. */
export const READINESS_HELP: Record<string, { meaning: string; to: string; action: string }> = {
  costs: { meaning: "Paper results without charges and slippage flatter you. Realistic costs show what a strategy really earns.", to: "/more/settings", action: "Open Settings" },
  trades: { meaning: "A handful of trades proves nothing. A record needs enough costed trades to mean something.", to: "/trade", action: "Place a paper trade" },
  days: { meaning: "A record also needs time, so it covers different market conditions, not one good week.", to: "/portfolio", action: "See your record" },
  discipline: { meaning: "The habit score: plan before entry, follow the plan, review after. It is the best early sign of staying alive with real money.", to: "#habits", action: "Fix a habit below" },
  drawdown: { meaning: "How far the account fell from its peak. A deep drawdown means the risk per trade was too big or the habits slipped.", to: "/portfolio", action: "See your record" },
  profit: { meaning: "Net profit after costs must be above zero. It is the result of the other checks, not a goal to chase directly.", to: "/portfolio", action: "See your record" },
};

export const FIXED_AT = 10;
