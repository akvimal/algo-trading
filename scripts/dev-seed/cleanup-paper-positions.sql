-- Removes exactly the rows seed-paper-positions.sql wrote (ids starting 5eed0000-). DEV ONLY.
-- Does not touch the account's balance/limit changes: reset those in the app if you care.
BEGIN;
SELECT id, symbol FROM execution.positions WHERE id::text LIKE '5eed0000-%' ORDER BY id;
DELETE FROM execution.positions WHERE id::text LIKE '5eed0000-%' RETURNING id;
DELETE FROM execution.option_position_groups WHERE id::text LIKE '5eed0000-%' RETURNING id;
DELETE FROM execution.account_equity_snapshots WHERE id::text LIKE '5eed0000-%' RETURNING id;
COMMIT;
