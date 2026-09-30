import { ApiError, api } from "./http";
import type { OptionGroup, Position, Segment } from "./types";
import { buildProvision, strategyName, supertrendName, adxName, dmiName, type AutoConfig, type ServerRule, type ServerStrategy } from "../autotrader/model";

// The auto-trader talks to signal-engine (the strategy that watches the SuperTrend) and to execution (the
// practice account it trades on). It is provisioned the same way the classic app does it, by name, so a
// setup made in either place is recognised in both.

export type Indicator = { id: string; name: string; type: string };
export type AutoRule = ServerRule & { id: string; name: string };
export type AutoStrategy = ServerStrategy & {
  id: string;
  name: string;
  status: "draft" | "backtesting" | "live" | "paused" | string;
  last_scan_at: string | null;
  rule_id: string | null;
};
/** The auto-trader's own paper account. */
export type PracticeAccount = {
  strategy_id: string;
  segment: Segment;
  starting_balance: number;
  current_balance: number;
  realized_pnl: number;
  unrealized_pnl: number;
};

export type AutoTraderState = { strategy: AutoStrategy; rule: AutoRule | null; account: PracticeAccount | null } | null;

const listIndicators = () => api<Indicator[]>("signalEngine", "/indicators");
const listRules = () => api<AutoRule[]>("signalEngine", "/rules");
const listStrategies = () => api<AutoStrategy[]>("signalEngine", "/strategies?source_type=in_house");

/** The practice account for a strategy, or null when it has none. */
export async function getPracticeAccount(strategyId: string): Promise<PracticeAccount | null> {
  try {
    return await api<PracticeAccount>("execution", `/accounts/strategy/${strategyId}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Is there an auto-trader for this instrument, and how is it doing? */
export async function loadAutoTrader(segment: Segment, symbol: string): Promise<AutoTraderState> {
  const [strategies, rules] = await Promise.all([listStrategies(), listRules()]);
  const strategy = strategies.find((s) => s.name === strategyName(segment, symbol));
  if (!strategy) return null;
  const rule = strategy.rule_id ? (rules.find((r) => r.id === strategy.rule_id) ?? null) : null;
  // A missing account is an answer, not a failure of the whole read.
  const account = await getPracticeAccount(strategy.id).catch(() => null);
  return { strategy, rule, account };
}

/** What the auto-trader has traded on its practice account, newest first, with live results for open ones.
 * Only its owner can read this (the trades belong to the platform, so the ordinary lists never show them). */
export const loadAutoTraderTrades = (strategyId: string) =>
  api<{ positions: Position[]; groups: OptionGroup[] }>("execution", `/accounts/strategy/${strategyId}/trades?with_live_pnl=true&limit=30`);

async function findOrCreateIndicator(existing: Indicator[], spec: { name: string; type: string; params: unknown }): Promise<string> {
  const found = existing.find((i) => i.name === spec.name && i.type === spec.type);
  if (found) {
    await api("signalEngine", `/indicators/${found.id}`, { method: "PATCH", json: { params: spec.params } });
    return found.id;
  }
  return (await api<Indicator>("signalEngine", "/indicators", { method: "POST", json: spec })).id;
}

/** Sets the auto-trader up (or brings an existing one up to date) and turns it on. Order matters for
 * safety: the strategy exists but is NOT live until its own practice account does too, so a failure on
 * the way never leaves it trading on a shared account. Turning it on also enters the current trend at
 * once (`reset_engine_run` makes a re-arm do that too, not only a brand new strategy). */
export async function armAutoTrader(segment: Segment, symbol: string, config: AutoConfig): Promise<AutoTraderState> {
  const plan = buildProvision(config, segment, symbol);
  const [indicators, rules, strategies] = await Promise.all([listIndicators(), listRules(), listStrategies()]);

  const stId = await findOrCreateIndicator(indicators, plan.supertrend);
  const regimeIds: string[] = [];
  if (plan.adx && plan.dmi) regimeIds.push(await findOrCreateIndicator(indicators, plan.adx), await findOrCreateIndicator(indicators, plan.dmi));

  const ruleBody = plan.rule(stId, regimeIds);
  const existingRule = rules.find((r) => r.name === ruleBody.name);
  const ruleId = existingRule
    ? (await api<AutoRule>("signalEngine", `/rules/${existingRule.id}`, { method: "PATCH", json: ruleBody })).id
    : (await api<AutoRule>("signalEngine", "/rules", { method: "POST", json: ruleBody })).id;

  const fields = plan.strategy(ruleId);
  const existing = strategies.find((s) => s.name === plan.strategyName);
  let strategyId: string;
  if (existing) {
    strategyId = existing.id;
    await api("signalEngine", `/strategies/${strategyId}`, { method: "PATCH", json: fields });
  } else {
    strategyId = (await api<AutoStrategy>("signalEngine", "/strategies", { method: "POST", json: { name: plan.strategyName, source_type: "in_house", horizon: "intraday", ...fields } })).id;
  }

  // Its own practice account, before it can place anything.
  if (!(await getPracticeAccount(strategyId))) {
    await api("execution", `/accounts/strategy/${strategyId}`, {
      method: "POST",
      json: { segment, starting_balance: config.balance, capital_per_trade: config.balance, risk_per_trade_pct: 1 },
    });
  }

  await api("signalEngine", `/strategies/${strategyId}`, { method: "PATCH", json: { status: "live", reset_engine_run: true } });
  return loadAutoTrader(segment, symbol);
}

/** Stops new entries. A position already open keeps its trailing stop and closes at square-off. */
export async function pauseAutoTrader(strategyId: string): Promise<void> {
  await api("signalEngine", `/strategies/${strategyId}`, { method: "PATCH", json: { status: "paused" } });
}

/** Removes the strategy, its rule and its indicators. Its practice account goes too if it never traded
 * anything (nothing to keep); if it did, the account and its trades are left as they are. Rule, indicator
 * and account cleanup is best effort: the strategy, the part that trades, is already gone either way. */
export async function removeAutoTrader(segment: Segment, symbol: string, strategyId: string): Promise<void> {
  const traded = await loadAutoTraderTrades(strategyId).then((t) => t.positions.length + t.groups.length > 0).catch(() => true);
  await api("signalEngine", `/strategies/${strategyId}`, { method: "DELETE" });
  if (!traded) await api("execution", `/accounts/strategy/${strategyId}`, { method: "DELETE" }).catch(() => undefined);
  const [rules, indicators] = await Promise.all([listRules(), listIndicators()]);
  const rule = rules.find((r) => r.name === strategyName(segment, symbol));
  if (rule) await api("signalEngine", `/rules/${rule.id}`, { method: "DELETE" }).catch(() => undefined);
  const names = [supertrendName(segment, symbol), adxName(segment, symbol), dmiName(segment, symbol)];
  for (const i of indicators.filter((x) => names.includes(x.name))) await api("signalEngine", `/indicators/${i.id}`, { method: "DELETE" }).catch(() => undefined);
}
