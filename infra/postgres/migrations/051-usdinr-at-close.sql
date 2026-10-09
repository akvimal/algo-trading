-- The USD/INR rate a CRYPTO trade's P&L was credited to the balance at (2026-10-09), so its rupee P&L stays what the balance actually received
-- even after the manual rate is changed. NULL for NSE/MCX and for trades closed before this column existed (those use the current rate).
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS usdinr_at_close NUMERIC;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS usdinr_at_close NUMERIC;
