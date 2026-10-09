-- A second, clean picture kept with a note (2026-10-06): the chart with a header (instrument, interval, date, price) and NOTHING else.
-- The picture saved with a note is composed in the browser and flattened: it also shows the note's text, its tag and the AI read line,
-- none of which can be removed afterwards. When a note is published as an idea the clean one is used, so the post shows the chart and
-- not the AI read or a second copy of the words. Notes saved before this keep only the composed picture.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

ALTER TABLE execution.study_notes ADD COLUMN IF NOT EXISTS snapshot_clean_png BYTEA;
