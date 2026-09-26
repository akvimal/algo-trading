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
