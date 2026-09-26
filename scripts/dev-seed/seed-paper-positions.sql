-- Seeds a few paper positions for ONE existing user, for hand-testing the web app's Today
-- screen (docs/architecture.md, "The web app"). DEV DATABASE ONLY.
--
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     -v uid="'<user uuid>'" < scripts/dev-seed/seed-paper-positions.sql
--
-- Every row it writes has an id starting 5eed0000- so cleanup-paper-positions.sql can remove
-- exactly these rows and nothing else.
--
-- PRICES MATTER: the running execution monitors (stop-loss/target/square-off) act on these rows
-- with REAL quotes, so entries/stops/targets below sit around real prices as of 2026-09-26
-- (RELIANCE ~1226, SBIN ~983). Re-check against live prices before re-seeding on another day,
-- or a stale stop will fire immediately. (The option legs use fake symbols: no live P&L.)
BEGIN;

-- Today (IST) closed, yesterday closed, and open trades; realized today = +180 - 450 + 1100 (option group) = +830.
INSERT INTO execution.positions
  (id, signal_id, symbol, exchange, segment, action, horizon, instrument_type, quantity, entry_price, entry_time,
   exit_price, exit_time, pnl, status, exit_reason, stop_loss_price, target_price, trailing_stop_enabled,
   breakeven_triggered, is_live_broker_order, auto_traded, created_at, user_id, order_type)
VALUES
  ('5eed0000-0000-4000-8000-000000000001', gen_random_uuid(), 'TCS', 'NSE', 'NSE', 'BUY', 'intraday', 'spot', 10, 2070, now() - interval '4 hours',
   2088, now() - interval '40 minutes', 180, 'CLOSED', 'target', 2050, 2088, false, false, false, false, now() - interval '4 hours', :uid, 'market'),
  ('5eed0000-0000-4000-8000-000000000002', gen_random_uuid(), 'INFY', 'NSE', 'NSE', 'SELL', 'intraday', 'spot', 25, 1012, now() - interval '3 hours',
   1030, now() - interval '30 minutes', -450, 'CLOSED', 'stop_loss', 1030, 980, false, false, false, false, now() - interval '3 hours', :uid, 'market'),
  ('5eed0000-0000-4000-8000-000000000003', gen_random_uuid(), 'HDFCBANK', 'NSE', 'NSE', 'BUY', 'positional', 'spot', 20, 700, now() - interval '3 days',
   730, now() - interval '1 day', 600, 'CLOSED', 'manual', NULL, NULL, false, false, false, false, now() - interval '3 days', :uid, 'market'),
  ('5eed0000-0000-4000-8000-000000000004', gen_random_uuid(), 'RELIANCE', 'NSE', 'NSE', 'BUY', 'intraday', 'spot', 8, 1215, now() - interval '2 hours',
   NULL, NULL, NULL, 'OPEN', NULL, 1190, 1260, false, false, false, false, now() - interval '2 hours', :uid, 'market'),
  ('5eed0000-0000-4000-8000-000000000005', gen_random_uuid(), 'SBIN', 'NSE', 'NSE', 'BUY', 'positional', 'spot', 50, 970, now() - interval '2 days',
   NULL, NULL, NULL, 'OPEN', NULL, 940, NULL, false, false, false, false, now() - interval '2 days', :uid, 'market');

-- Option groups: one open bull call spread, one naked call closed today (+1100). Each leg is
-- also a Position row, which is exactly what must NOT be counted on top of its group.
INSERT INTO execution.option_position_groups
  (id, signal_id, underlying_symbol, exchange, segment, strategy_type, action, horizon, quantity, net_debit,
   status, exit_time, exit_reason, pnl, sl_scope, spot_stop_loss_price, spot_target_price,
   spot_stop_loss_trailing_enabled, auto_traded, created_at, user_id, order_type)
VALUES
  ('5eed0000-0000-4000-8000-0000000000a1', gen_random_uuid(), 'NIFTY', 'NSE', 'NSE', 'bull_call_spread', 'BUY', 'intraday', 1, 95,
   'OPEN', NULL, NULL, NULL, 'combined', NULL, NULL, false, false, now() - interval '90 minutes', :uid, 'market'),
  ('5eed0000-0000-4000-8000-0000000000a2', gen_random_uuid(), 'BANKNIFTY', 'NSE', 'NSE', 'naked_call', 'BUY', 'intraday', 1, 210,
   'CLOSED', now() - interval '20 minutes', 'combined_target', 1100, 'combined', NULL, NULL, false, false, now() - interval '3 hours', :uid, 'market');

INSERT INTO execution.positions
  (id, signal_id, symbol, exchange, segment, action, horizon, instrument_type, quantity, entry_price, entry_time,
   exit_price, exit_time, pnl, status, exit_reason, option_group_id, trailing_stop_enabled,
   breakeven_triggered, is_live_broker_order, auto_traded, created_at, user_id, order_type)
VALUES
  ('5eed0000-0000-4000-8000-0000000000b1', gen_random_uuid(), 'NIFTY-SEED-24800-CE', 'NSE', 'NSE', 'BUY', 'intraday', 'option', 75, 140, now() - interval '90 minutes',
   NULL, NULL, NULL, 'OPEN', NULL, '5eed0000-0000-4000-8000-0000000000a1', false, false, false, false, now() - interval '90 minutes', :uid, 'market'),
  ('5eed0000-0000-4000-8000-0000000000b2', gen_random_uuid(), 'NIFTY-SEED-25000-CE', 'NSE', 'NSE', 'SELL', 'intraday', 'option', 75, 45, now() - interval '90 minutes',
   NULL, NULL, NULL, 'OPEN', NULL, '5eed0000-0000-4000-8000-0000000000a1', false, false, false, false, now() - interval '90 minutes', :uid, 'market'),
  ('5eed0000-0000-4000-8000-0000000000b3', gen_random_uuid(), 'BANKNIFTY-SEED-52000-CE', 'NSE', 'NSE', 'BUY', 'intraday', 'option', 30, 210, now() - interval '3 hours',
   1100.0/30 + 210, now() - interval '20 minutes', 1100, 'CLOSED', 'target', '5eed0000-0000-4000-8000-0000000000a2', false, false, false, false, now() - interval '3 hours', :uid, 'market');

-- Give NSE a daily loss limit (so the loss meter shows) and make the balance match the booked P&L.
UPDATE execution.accounts SET max_daily_loss = 3000, current_balance = starting_balance + 180 - 450 + 600 + 1100
 WHERE user_id = :uid AND segment = 'NSE';

-- A week of end-of-day equity snapshots so the Portfolio equity curve has something to draw
-- (the real job records one per day; a brand-new account has none yet). First row is a reset marker.
INSERT INTO execution.account_equity_snapshots
  (id, account_id, user_id, segment, snapshot_date, starting_balance, balance, unrealized_pnl, equity, open_positions, is_reset_point)
SELECT ('5eed0000-0000-4000-8000-0000000000e' || d.n)::uuid, a.id, a.user_id, a.segment, current_date - d.n, a.starting_balance,
       a.starting_balance + d.eq, 0, a.starting_balance + d.eq, 0, d.n = 8
  FROM execution.accounts a,
       (VALUES (8, 0), (7, 0), (6, 620), (5, 150), (4, 900), (3, 1050), (2, 800), (1, 1430)) AS d(n, eq)
 WHERE a.user_id = :uid AND a.segment = 'NSE';

SELECT (SELECT count(*) FROM execution.positions WHERE id::text LIKE '5eed0000-%') AS positions,
       (SELECT count(*) FROM execution.option_position_groups WHERE id::text LIKE '5eed0000-%') AS groups;
COMMIT;
