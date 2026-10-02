-- Discipline v2, step 1 (docs/discipline-v2-spec.md): a log of every stop-loss and target change on an open spot/future
-- position or option group, so the discipline score can later tell a planned trail from an emotional one, a stop that
-- was only tightened from one a person tried to widen, and a target that was pulled in or pushed out.
--
-- One row per attempt, accepted or refused (a refused attempt to widen a live stop is itself a greed signal). Written
-- by the PUT routes (source='user') and by the auto-trail jobs (source='auto_trail'). price_at_event / atr are best
-- effort - NULL when market-data could not be reached - and tight_trail is NULL when it could not be judged.
--
-- Safe to re-run. Run manually against a populated volume (BEFORE deploying execution code that uses it; test DB
-- first):
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS execution.position_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID,
    position_id      UUID,
    option_group_id  UUID,
    -- What moved: the spot/future position's own stop or target, an option group's COMBINED premium stop or target, or its
    -- SPOT (underlying) stop or target.
    field            TEXT NOT NULL CHECK (field IN ('stop_loss', 'target', 'combined_stop_loss', 'combined_target', 'spot_stop_loss', 'spot_target')),
    -- stop: set | tighten | widen | clear | same.   target: set | closer | further | clear | same.
    move             TEXT NOT NULL CHECK (move IN ('set', 'tighten', 'widen', 'clear', 'closer', 'further', 'same')),
    old_price        NUMERIC,
    new_price        NUMERIC,
    source           TEXT NOT NULL CHECK (source IN ('user', 'auto_trail', 'system')),
    accepted         BOOLEAN NOT NULL DEFAULT TRUE,
    refused_reason   TEXT,
    price_at_event   NUMERIC,
    atr              NUMERIC,
    atr_interval     TEXT,
    -- A stop tightened to within N x ATR of price, other than a move to breakeven once price is +1R. NULL = not judged.
    tight_trail      BOOLEAN,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (position_id IS NOT NULL OR option_group_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_position_events_position ON execution.position_events (position_id, created_at);
CREATE INDEX IF NOT EXISTS idx_position_events_group ON execution.position_events (option_group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_position_events_user ON execution.position_events (user_id, created_at DESC);
