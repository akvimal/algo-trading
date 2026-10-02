-- Discipline v2 (docs/discipline-v2-spec.md): the one-tap AUTO-TRAIL, so the stop is not trailed by hand in the heat of the
-- moment. Once price has moved one initial risk (+1R) in the trade's favour the stop moves to breakeven, and from then
-- it trails behind price by N x ATR - never loosening. It reuses the existing trailing machinery:
--   positions:               stop_loss_method = 'atr_trail' (+ stop_loss_interval, stop_loss_indicator_params {period, multiple},
--                            trailing_stop_enabled, breakeven_triggered)
--   option_position_groups:  spot_stop_loss_indicator_type = 'atr_trail' (+ spot_stop_loss_interval, spot_stop_loss_indicator_params
--                            {period, multiple, initial_stop, breakeven_done}, spot_stop_loss_trailing_enabled)
-- so all that is needed here is to let those two CHECK constraints accept the new value.
--
-- Safe to re-run. Run manually against a populated volume (BEFORE deploying execution code that uses it; test DB
-- first):
--   scripts/migrate.sh apply

ALTER TABLE execution.positions DROP CONSTRAINT IF EXISTS positions_stop_loss_method_check;
ALTER TABLE execution.positions ADD CONSTRAINT positions_stop_loss_method_check
    CHECK (stop_loss_method IN ('previous_candle', 'percent', 'indicator', 'breakeven', 'atr_trail'));

ALTER TABLE execution.option_position_groups DROP CONSTRAINT IF EXISTS option_position_groups_spot_stop_loss_indicator_type_check;
ALTER TABLE execution.option_position_groups ADD CONSTRAINT option_position_groups_spot_stop_loss_indicator_type_check
    CHECK (spot_stop_loss_indicator_type IN ('supertrend', 'atr_trail'));
