// The response shapes this app reads. Hand-written for now and deliberately narrow: only
// fields a screen actually uses. `npm run gen:api` produces the full OpenAPI types under
// src/api/generated/ for reference when a screen needs more; tighten these against it then.

export type TokenResponse = { access_token: string; token_type: string };

export type Account = {
  segment: "NSE" | "MCX" | "CRYPTO";
  starting_balance: number;
  current_balance: number;
  realized_pnl: number;
  unrealized_pnl: number;
  capital_per_trade: number;
  max_daily_loss: number | null;
  live_trading_enabled: boolean;
  apply_charges: boolean;
  require_stop_loss: boolean;
  square_off_time: string | null;
  risk_per_trade_pct: number;
  min_reward_risk_ratio: number;
  enforce_risk_based_lots: boolean;
  slippage_bps: number;
  max_order_value: number | null;
  live_trading_consent_at: string | null;
};

export type Position = {
  id: string;
  symbol: string;
  exchange: string;
  segment: "NSE" | "MCX" | "CRYPTO";
  action: "BUY" | "SELL";
  horizon: string | null;
  instrument_type: "spot" | "future" | "option";
  quantity: number;
  entry_price: number;
  entry_time: string;
  exit_price: number | null;
  exit_time: string | null;
  pnl: number | null;
  live_price?: number | null;
  unrealized_pnl?: number | null;
  status: "OPEN" | "CLOSED" | "REJECTED" | string;
  stop_loss_price: number | null;
  target_price: number | null;
  option_group_id: string | null;
  charges?: number | null;
  slippage_cost?: number | null;
  exit_reason?: string | null;
  notes?: string | null;
  setup_tag?: string | null;
  confidence?: number | null;
  reviewed_at?: string | null;
  review_violation?: boolean | null;
  review_notes?: string | null;
  strategy_id?: string | null;
  auto_traded?: boolean;
};

export type OptionGroup = {
  id: string;
  underlying_symbol: string;
  strategy_type: string;
  action: "BUY" | "SELL";
  horizon: string | null;
  quantity: number;
  net_debit: number | null;
  combined_stop_loss_price: number | null;
  spot_stop_loss_price: number | null;
  spot_target_price: number | null;
  live_combined_price?: number | null;
  live_spot_price?: number | null;
  unrealized_pnl?: number | null;
  status: string;
  pnl: number | null;
  entry_time: string;
  exit_time: string | null;
  segment?: "NSE" | "MCX" | "CRYPTO";
  charges?: number | null;
  slippage_cost?: number | null;
  exit_reason?: string | null;
  notes?: string | null;
  setup_tag?: string | null;
  confidence?: number | null;
  reviewed_at?: string | null;
  review_violation?: boolean | null;
  review_notes?: string | null;
  strategy_id?: string | null;
  auto_traded?: boolean;
};

export type SentimentUnderlying = {
  symbol: string;
  score_5m: number | null;
  score_15m: number | null;
  direction: string;
  strength: string;
  error?: string | null;
};

export type MarketSentiment = {
  exchanges: Record<string, { direction: string; strength: string; score: number | null; underlyings: SentimentUnderlying[] }>;
};

export type Segment = "NSE" | "MCX" | "CRYPTO";

export type EquityPoint = { snapshot_date: string; balance: number; unrealized_pnl: number; equity: number; is_reset_point: boolean };

export type EquityStats = {
  since: string;
  baseline: number;
  latest_equity: number;
  return_pct: number;
  peak_equity: number;
  max_drawdown_pct: number;
  days_tracked: number;
  points: number;
};

export type EquityHistory = { segment: Segment; days: number; points: EquityPoint[]; stats: EquityStats | null };

export type PerformanceStats = {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  win_rate_pct: number | null;
  total_pnl: number;
  gross_pnl: number;
  total_charges: number;
  total_slippage: number;
  avg_pnl: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  profit_factor: number | null;
  avg_r: number | null;
  best_trade: number | null;
  worst_trade: number | null;
  max_consecutive_losses: number;
};

export type DisciplineComponent = { rate: number | null; trades: number };

export type Discipline = {
  score: number | null;
  window_days: number;
  window_start: string | null;
  trade_count: number;
  planned: DisciplineComponent;
  plan_adherence: DisciplineComponent;
  plan_review: DisciplineComponent & { before_rate: number | null; after_rate: number | null };
  outcome: DisciplineComponent & { win_rate: number | null; avg_r: number | null };
};

export type Performance = {
  segment: Segment;
  scope: "epoch" | "all";
  since: string | null;
  performance: PerformanceStats | null;
  discipline: Discipline;
  equity: EquityStats | null;
};

export type Requirement = { key: string; label: string; required: string; actual: string; met: boolean };

export type LiveEligibility = { segment: Segment; enforced: boolean; eligible: boolean; requirements: Requirement[] };

export type ChecklistItem = { id: string; label: string; phase: "plan" | "review" | "day"; segments: Segment[]; sort_order: number; active: boolean };

export type Credentials = { has_dhan: boolean; has_delta: boolean; has_openrouter: boolean; dhan_client_id_masked: string | null };
export type Ltp = { exchange: string; symbol: string; ltp: number; provider: string };

export type Buildup = "long_buildup" | "short_buildup" | "short_covering" | "long_unwinding";

export type OiRow = {
  symbol: string;
  exchange: string;
  snapshot_date: string;
  spot_price: number | null;
  total_call_oi: number;
  total_put_oi: number;
  pcr: number | null;
  call_oi_change_pct: number | null;
  put_oi_change_pct: number | null;
  price_change_pct: number | null;
  call_buildup: Buildup | null;
  put_buildup: Buildup | null;
  history: { snapshot_date: string; spot_price?: number | null }[];
};
export type OiBuildup = { snapshot_date: string; rows: OiRow[] };

export type Regime = "trending_up" | "trending_down" | "ranging" | "transitional";
export type Proximity = "near_52w_high" | "near_52w_low";

export type ScreenerRow = {
  symbol: string;
  exchange: string;
  snapshot_date: string;
  close: number;
  pct_change_5d: number | null;
  pct_change_20d: number | null;
  adx: number | null;
  regime: Regime | null;
  high_52w: number | null;
  low_52w: number | null;
  pct_from_52w_high: number | null;
  pct_from_52w_low: number | null;
  proximity: Proximity | null;
  history: { snapshot_date: string; close: number }[];
};
export type Screener = { snapshot_date: string; rows: ScreenerRow[] };

export type Candle = { exchange: string; symbol: string; interval: string; open: number; high: number; low: number; close: number; volume: number; timestamp: string };

export type ResolvedUnderlying = {
  chart_symbol: string;
  chart_exchange: string;
  trade_symbol: string;
  trade_exchange: string;
  lot_size: number;
  expiry: string | null;
};

export type MarketRegime = { regime: "trending_up" | "trending_down" | "ranging" | "transitional"; adx: number; atr_percentile: number; trend: "up" | "down" | "range"; advice: string };

export type PendingOrder = {
  id: string;
  segment: Segment;
  symbol: string;
  action: "BUY" | "SELL";
  strategy: "future" | "naked" | "spread";
  trigger_price: number;
  stop_loss_price: number | null;
  target_price: number | null;
  status: "pending" | "triggered" | "rejected" | "failed" | "cancelled" | "expired";
  status_reason: string | null;
  expires_at: string;
  last_price: number | null;
};

export type Profile = {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  experience: "guided" | "pro";
  onboarded_at: string | null;
  markets: Segment[];
};
