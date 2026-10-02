-- Discipline v2, step 4 (docs/discipline-v2-spec.md): a one-tap "how did you feel?" after a loss or an early exit, so the
-- weekly coaching can say which feeling was behind the mistake (fearful on 5 of 7 early exits) rather than only that it
-- happened. NULL = not asked or not answered. It is data for the person, never a score input.
--
-- Safe to re-run. Run manually against a populated volume (BEFORE deploying execution code that uses it; test DB
-- first):
--   scripts/migrate.sh apply

ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS emotion_tag TEXT;
ALTER TABLE execution.positions DROP CONSTRAINT IF EXISTS positions_emotion_tag_check;
ALTER TABLE execution.positions ADD CONSTRAINT positions_emotion_tag_check CHECK (emotion_tag IN ('calm', 'fearful', 'greedy', 'fomo'));

ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS emotion_tag TEXT;
ALTER TABLE execution.option_position_groups DROP CONSTRAINT IF EXISTS option_position_groups_emotion_tag_check;
ALTER TABLE execution.option_position_groups ADD CONSTRAINT option_position_groups_emotion_tag_check CHECK (emotion_tag IN ('calm', 'fearful', 'greedy', 'fomo'));
