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
  /** Crypto margin multiplier (1 = none); the same column exists, unused, on the other markets. */
  leverage?: number;
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
  /** `pnl` and `unrealized_pnl` are rupees for every trade (see api/rupees.ts); a crypto trade's dollar figures are kept here. */
  pnl_native?: number | null;
  unrealized_pnl_native?: number | null;
  pnl_inr?: number | null;
  unrealized_pnl_inr?: number | null;
  currency?: "INR" | "USD";
  /** Rupees per unit of the trade's own currency: 1, or the USD/INR rate for crypto (null when none is set). */
  fx?: number | null;
  status: "OPEN" | "CLOSED" | "REJECTED" | string;
  /** True only if the entry cleared through a real broker order; otherwise it was a paper trade. */
  is_live_broker_order?: boolean;
  stop_loss_price: number | null;
  target_price: number | null;
  option_group_id: string | null;
  /** A stop that follows the price (or a method such as previous candle) rather than a fixed level. */
  trailing_stop_enabled?: boolean;
  /** How the stop trails, if it does: 'atr_trail' is the one-tap auto-trail. */
  stop_loss_method?: string | null;
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
  /** The two legs' own strike difference, frozen at open - null for naked, and for any group
   * opened before this field existed. Lets a spread's theoretical max profit/loss be shown - see
   * execution's _spread_sizing_basis for the identical debit/credit split. */
  strike_width?: number | null;
  combined_stop_loss_price: number | null;
  spot_stop_loss_price: number | null;
  spot_target_price: number | null;
  /** The underlying's price when the group opened. */
  entry_spot_price?: number | null;
  spot_stop_loss_trailing_enabled?: boolean;
  spot_stop_loss_indicator_type?: string | null;
  live_combined_price?: number | null;
  live_spot_price?: number | null;
  unrealized_pnl?: number | null;
  pnl_native?: number | null;
  unrealized_pnl_native?: number | null;
  pnl_inr?: number | null;
  unrealized_pnl_inr?: number | null;
  currency?: "INR" | "USD";
  fx?: number | null;
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

export type CatalogModel = {
  id: string;
  name: string;
  context_length: number | null;
  /** USD per million tokens. */
  prompt_per_m: number | null;
  completion_per_m: number | null;
  /** Can think before answering. */
  reasoning: boolean;
  image_input: boolean;
  free: boolean;
};

export type AiModelTask = {
  task: string;
  label: string;
  description: string;
  /** This task's own choice, or null when it follows the shared default / server setting. */
  override: string | null;
  /** What the task actually uses right now. */
  model: string;
  source: "task" | "default" | "env";
};

export type AiModels = { default: string | null; tasks: AiModelTask[] };

export type Bias = "bullish" | "bearish" | "neutral";

export type PremarketInput = {
  key: string;
  label: string;
  group: "us" | "commodity" | "currency" | "yield" | "adr" | "india" | "index" | "sector" | "metals" | "energy" | "macro" | "crypto" | "risk";
  ok: boolean;
  value: number | null;
  /** Percent for prices; basis points when `unit` is "bp" (bond yields); index points when "pt" (the crypto Fear & Greed index). */
  change: number | null;
  unit: "pct" | "bp" | "pt";
  source: string;
  error: string | null;
};

export type PremarketIndicator = {
  key: string;
  label: string;
  unit: "pct" | "usd_bn";
  ok: boolean;
  value: number | null;
  previous: number | null;
  change: number | null;
  /** The last day of the period the print covers. */
  period: string | null;
  error: string | null;
};

export type PremarketMacro = {
  indicators: PremarketIndicator[];
  derived: { real_rate: number | null; spread_10y_repo: number | null; india_10y: number | null };
  rbi: PremarketRbiItem[];
};

export type RbiStance = "hawkish" | "dovish" | "neutral" | "not about policy";

export type PremarketRbiItem = {
  title: string;
  url: string | null;
  published: string | null;
  kind: "press release" | "speech";
  /** An AI summary of the item's full text, when it has been read. */
  summary?: { text: string; stance: RbiStance; rates: string | null; model: string | null } | null;
};

export type PremarketReport = {
  day: string;
  generated_at: string;
  bias: Bias;
  agree: boolean | null;
  model: string | null;
  ai_error: string | null;
  inputs: PremarketInput[];
  rules: {
    score: number;
    bias: Bias;
    coverage: number;
    gift_gap_pct: number | null;
    factors: { key: string; label: string; move: number | null; score: number | null; weight: number }[];
  };
  ai: { bias: Bias; confidence: number; one_liner: string; reasons: string[]; risks: string[]; watch: string; macro_context?: string | null } | null;
  /** India's domestic macro backdrop. Absent on reports written before it existed. */
  macro?: PremarketMacro | null;
  /** MCX and crypto briefs: the rules-based read is shown at once and the model's read is still being prepared. */
  ai_pending?: boolean;
  /** When the AI read was actually made, and whether this build reused it because the numbers had not meaningfully changed. */
  ai_read_at?: string | null;
  ai_reused?: boolean;
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

/** One earlier end-of-day total, oldest first in OiRow.history (the latest day is the last point). */
export type OiHistoryPoint = { snapshot_date: string; total_call_oi?: number; total_put_oi?: number; spot_price?: number | null };

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
  history: OiHistoryPoint[];
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
  /** The fields below arrive with the screener's descriptive columns (2026-10-08); absent from an older backend and null for a stock with too few bars. */
  is_fno?: boolean;
  /** Index keys the stock belongs to (NIFTY500, NIFTYMIDCAP150, ...); empty for a stock in none of them. */
  universes?: string[];
  /** 20-day average of close x volume, in Rs crore. */
  avg_turnover_cr?: number | null;
  ret_3m_pct?: number | null;
  /** The 12-1 month momentum score: the close a month ago against the close a year ago. */
  mom_12_1_pct?: number | null;
  rsi3?: number | null;
  dist_ema20_pct?: number | null;
  atr_pct?: number | null;
  vol_ratio?: number | null;
  /** 0-100 rank (100 = strongest) among stocks trading at least Rs 5 Cr a day; null for the rest. */
  rs_3m_pctile?: number | null;
  rs_12m_pctile?: number | null;
  history: { snapshot_date: string; close: number }[];
};
export type Screener = { snapshot_date: string; rows: ScreenerRow[] };

// ---- custom equity screener (an expression, evaluated against the same EOD universe) ----

export type CustomScreenDef = {
  label: string;
  expression: string;
  is_fno: boolean | null;
  index_membership: string | null;
  min_price: number | null;
  max_price: number | null;
};
export type CustomScreen = CustomScreenDef & { id: string; created_at: string; updated_at: string };
export type CustomScreenMatch = { symbol: string; exchange: string; close: number };
export type CustomScreenRunResult = {
  snapshot_date: string | null;
  candidates: number;
  matches: CustomScreenMatch[];
  /** Only for a condition that reads intraday bars: how many stocks could not be checked, and why (a sentence to show). */
  intraday_skipped?: number;
  intraday_note?: string | null;
};

export type Candle = { exchange: string; symbol: string; interval: string; open: number; high: number; low: number; close: number; volume: number; timestamp: string };

export type ResolvedUnderlying = {
  chart_symbol: string;
  chart_exchange: string;
  trade_symbol: string;
  trade_exchange: string;
  lot_size: number;
  expiry: string | null;
};

export type OiLeg = { oi: number; oi_change_5m: number | null; oi_change_15m: number | null; volume: number };
export type OiSummary = {
  underlying_symbol: string;
  underlying_exchange: string;
  expiry: string;
  underlying_last_price: number;
  total_call_oi: number;
  total_put_oi: number;
  pcr: number | null;
  total_call_oi_change_5m: number | null;
  total_put_oi_change_5m: number | null;
  total_call_oi_change_15m: number | null;
  total_put_oi_change_15m: number | null;
  total_call_buildup: Buildup | null;
  total_put_buildup: Buildup | null;
  strikes: { strike: number; call: OiLeg | null; put: OiLeg | null }[];
};

export type OptionLegPreviewLeg = { action: "BUY" | "SELL"; option_type: "CE" | "PE"; strike: number; expiry: string; premium: number | null };
export type OptionLegPreview = { strategy_type: string; expiry: string; legs: OptionLegPreviewLeg[] };

/** One CE or PE leg's live quote at one strike (market-data's GET /options/chain) - the same
 * shape option_templates.py's own chain fixtures use, minus the fields this app doesn't need
 * (greeks, bid/ask). security_id backs a real order's leg resolution; last_price is what the Scan
 * page's leg table shows without a separate per-click quote round trip. */
export type OptionLegQuote = { security_id: string; last_price: number; oi: number; moneyness: "ITM" | "ATM" | "OTM" };
export type OptionChainStrike = { strike: number; ce: OptionLegQuote | null; pe: OptionLegQuote | null };
export type OptionChain = { underlying_symbol: string; underlying_exchange: string; expiry: string; underlying_last_price: number; strikes: OptionChainStrike[] };

/** One market_data.sentiment_history row, written every 5 minutes for an OI-chain instrument. */
export type SentimentHistoryPoint = { recorded_at: string; score_5m: number | null; score_15m: number | null };
export type SentimentHistoryDay = { exchange: string; session_start: string; session_end: string; points: SentimentHistoryPoint[] };

export type MarketRegime = { regime: "trending_up" | "trending_down" | "ranging" | "transitional"; adx: number; atr_percentile: number; trend: "up" | "down" | "range"; advice: string };

/** GET /ai-read — an on-demand model read of the OI strip's own data plus price, regime, VIX and news context. */
export type AiRead = {
  underlying: string;
  expiry: string;
  model: string;
  generated_at: string;
  bias: "bullish" | "bearish" | "neutral";
  confidence: number;
  one_liner: string;
  reasoning: string[];
  support: number[];
  resistance: number[];
  risks: string[];
  wait_for: string;
  /** What the model was NOT given (e.g. futures OI, breadth, or an extra that failed to load). */
  data_gaps: string[];
};

export type PendingOrder = {
  id: string;
  segment: Segment;
  symbol: string;
  action: "BUY" | "SELL";
  strategy: "future" | "naked" | "spread" | "spot";
  trigger_price: number;
  stop_loss_price: number | null;
  target_price: number | null;
  status: "pending" | "triggered" | "rejected" | "failed" | "cancelled" | "expired";
  status_reason: string | null;
  expires_at: string;
  last_price: number | null;
  allow_stacking: boolean;
};

export type Profile = {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  experience: "guided" | "pro";
  onboarded_at: string | null;
  markets: Segment[];
  default_instrument: "future" | "option";
  default_option_strategy: "naked" | "spread";
  /** The same choice per market; a market with no entry uses the two above. */
  segment_defaults?: Partial<Record<Segment, { instrument: "future" | "option"; option_strategy: "naked" | "spread" }>>;
};

export type OrderBlock = {
  kind: "demand" | "supply";
  role: "orderblock" | "breaker";
  proximal: number;
  distal: number;
  origin_timestamp: string;
  mitigated: boolean;
  counter_trend: boolean;
};
export type Fvg = { kind: "bullish" | "bearish"; top: number; bottom: number; origin_timestamp: string; filled: boolean };
export type StructureEvent = { kind: "bos" | "choch"; direction: "up" | "down"; price: number; timestamp: string; from_timestamp: string };
export type TrendChange = { timestamp: string; price: number; trend: "up" | "down" | "range" };
export type Setup = {
  direction: "long" | "short";
  status: "confirmed" | "triggered" | "hit_target" | "hit_sl" | "invalidated";
  entry: number;
  stop_loss: number;
  target: number;
  risk_reward: number;
  zone_proximal: number;
  zone_distal: number;
  confirmed_timestamp: string;
  resolved_timestamp: string | null;
};
export type ChartStructure = {
  order_blocks: OrderBlock[];
  fvgs: Fvg[];
  trend: "up" | "down" | "range";
  events: StructureEvent[];
  trend_changes: TrendChange[];
  setups: Setup[];
};

/** What the market looked like when a note was written - kept with the note so a later study (or a model) can read
 * what the person thought against what they were looking at. Every part is optional: only what was on screen. */
export type NoteContext = {
  price: number | null;
  interval: string;
  regime?: { regime: string; adx: number; atr_percentile: number };
  structure_trend?: Record<string, string>;
  oi?: {
    expiry: string;
    pcr: number | null;
    vol_pcr: number | null;
    call_oi_change_5m: number | null;
    put_oi_change_5m: number | null;
    call_buildup: string | null;
    put_buildup: string | null;
  };
  ai_read?: { bias: string; confidence: number; one_liner: string; generated_at: string };
  holding?: string | null;
};

export type NoteTag = "plan" | "observation" | "mistake" | "review";

/** One note from the thoughts-and-plans panel (GET /study-notes). */
export type StudyNote = {
  id: string;
  segment: Segment;
  symbol: string;
  interval: string | null;
  text: string;
  tag: NoteTag | null;
  context: NoteContext | null;
  position_id: string | null;
  option_group_id: string | null;
  has_snapshot: boolean;
  /** A chart-and-header-only picture was kept too (notes saved before it existed have only the composed one). */
  has_clean_snapshot?: boolean;
  created_at: string | null;
};

/** One instrument the person has written notes on (GET /study-notes/instruments). */
export type NoteInstrument = { segment: Segment; symbol: string; count: number; last_at: string | null };

/** Discipline v2: a behaviour score over the last 20 closed manual trades, split into greed, fear and patience. Never a function of profit. */
export type Feeling = "calm" | "fearful" | "greedy" | "fomo";
export type DisciplineCheck = { key: string; category: string; emotion: string; score: number; mistake: string | null };
export type DisciplineTrade = {
  id: string;
  kind: "position" | "group";
  symbol: string;
  action: "BUY" | "SELL";
  exit_time: string;
  exit_reason: string | null;
  exit_kind: string | null;
  planned_rr: number | null;
  exit_r: number | null;
  score: number | null;
  pnl: number | null;
  mistakes: string[];
  flags: string[];
  checks: DisciplineCheck[];
  what_if: { extra_r: number; target_reached: boolean | null } | null;
  /** How the person said they felt after a loss or an early exit, and whether that question is still open for this trade. */
  emotion_tag: Feeling | null;
  needs_emotion: boolean;
};
/** One habit rewarded over a run of trades. Motivation only: it is not connected to the live-trading gate. */
export type Credential = {
  key: string;
  label: string;
  blurb: string;
  unit: string;
  count: number;
  level: "bronze" | "silver" | "gold" | null;
  next_level: "bronze" | "silver" | "gold" | null;
  next_at: number | null;
  best_count: number;
  best_level: "bronze" | "silver" | "gold" | null;
  lapsed: boolean;
  available: boolean;
  detail: string | null;
};
export type DisciplineV2 = {
  segment: Segment;
  scope: "epoch" | "all";
  score: number | null;
  trade_count: number;
  emotions: { greed: number | null; fear: number | null; patience: number | null };
  categories: Record<string, number | null>;
  mistakes: Record<string, number>;
  week_mistakes: Record<string, number>;
  target_and_stop_moved: number;
  emotion_counts: Partial<Record<Feeling, number>>;
  needs_emotion: number;
  coaching: { mistake: string | null; emotion: string | null; count: number; line: string } | null;
  credentials: Credential[];
  trades: DisciplineTrade[];
};

/** GET /discipline/{segment}/today - what the ticket's plan block says about today, by the same rules the discipline score uses. */
export type Pretrade = {
  segment: Segment;
  symbol: string;
  cooldown_minutes_left: number;
  cooldown_minutes: number;
  trades_today: number;
  trade_cap: number;
  loss_limit: number | null;
  lost_today: number;
  loss_room: number | null;
  off_window: boolean;
};

/** A background job's run log (market-data's GET /jobs, admin only). */
export type JobStatus = "running" | "succeeded" | "partial" | "failed" | "skipped" | "interrupted";
export type JobRun = {
  id: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  /** For a run still going, how long it has been going when the answer was made. */
  duration_seconds: number | null;
  total: number | null;
  done: number;
  tally: Record<string, number>;
  message: string | null;
};
export type Job = {
  job_id: string;
  label: string;
  what: string;
  schedule: string;
  next_run_at: string | null;
  running: JobRun | null;
  /** The latest run that has ended, however it ended. */
  last_run: JobRun | null;
  last_success: JobRun | null;
  /** Newest first, including one still running. */
  recent: JobRun[];
  /** An admin may start it by hand. */
  can_run_now?: boolean;
};
export type Jobs = { jobs: Job[] };

/** GET /news — headlines for one symbol with an overall bullish/bearish/neutral read. relevance_score and why are null when the AI step did not run. */
export type NewsArticle = {
  title: string;
  url: string;
  source: string;
  published_at: string;
  image_url: string | null;
  relevance_score: number | null;
  why: string | null;
};
export type NewsDigest = {
  bias: "bullish" | "bearish" | "neutral";
  bias_reason: string;
  digest: string;
  articles: NewsArticle[];
};

/** GET /calendar/upcoming — the Markets panel's Calendar tab. `time` is HH:MM IST, or null for an all-day or untimed item. */
export type CalendarEvent = {
  date: string;
  time: string | null;
  title: string;
  kind: "global" | "rbi" | "data" | "holiday" | "expiry";
  impact: "high" | "medium" | "low";
  detail: string | null;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
};
export type UpcomingCalendar = { segment: string; start: string; end: string; events: CalendarEvent[]; notes: string[] };

/** GET /zone-scan — the nightly shortlist of F&O stocks at an untested demand or supply zone. tier: A = a weekly zone of the same kind is also at price and open interest agrees; B = the weekly trend is on the zone's side and OI agrees; C = a daily zone only. */
export type ZoneScanRow = {
  symbol: string;
  exchange: string;
  close: number;
  daily_trend: "up" | "down" | "range";
  weekly_trend: "up" | "down" | "range" | null;
  tier: "A" | "B" | "C";
  zone_kind: "demand" | "supply";
  zone_position: "inside" | "approaching";
  zone_proximal: number;
  zone_distal: number;
  zone_distance_pct: number;
  zone_distance_atr: number;
  weekly_zone: boolean;
  weekly_agrees: boolean;
  call_buildup: string | null;
  put_buildup: string | null;
  oi_agrees: boolean | null;
};
export type ZoneScan = { snapshot_date: string | null; rows: ZoneScanRow[] };
