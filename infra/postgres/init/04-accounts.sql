-- Runs automatically on first container start (docker-entrypoint-initdb.d).
-- Each system gets its own schema so systems never share tables.

CREATE SCHEMA IF NOT EXISTS accounts;

-- One row per signed-up user. password_hash is bcrypt output (never
-- plaintext) - see app/domain/security.py.
CREATE TABLE IF NOT EXISTS accounts.users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Display name, collected at signup - shown in the shell's own top-bar
-- user area (see shell/index.html) instead of the email there. Not a
-- login credential (email still is), so no uniqueness constraint. ADD
-- COLUMN IF NOT EXISTS so this is safe to (re-)run against a volume
-- created before this column existed, same convention as is_admin below -
-- a pre-existing row backfills to '' rather than failing the NOT NULL.
ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';

-- Platform-operator flag, not a self-service signup option - see
-- app/domain/security.py's create_access_token (embedded as a JWT claim,
-- checked stateless by market-data's require_admin) and
-- docs/architecture.md's "Manual Trading SaaS" section. Promoted manually
-- (UPDATE accounts.users SET is_admin = true WHERE email = '...') - no
-- route grants this to anyone. ADD COLUMN IF NOT EXISTS so this is safe to
-- (re-)run against both a fresh volume and one created before this column
-- existed, same convention as every inline ALTER in 02-execution.sql.
ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- One row per user's BYO broker credentials (Dhan for NSE/MCX, Delta
-- Exchange India for CRYPTO) - created lazily on first PUT /credentials,
-- not at signup. All nullable: a user may only set up one provider, or
-- none yet. The four *_encrypted columns are Fernet ciphertext, never
-- plaintext - see app/domain/security.py. dhan_client_id is stored
-- unencrypted (an identifier, not a secret, and GET /credentials needs
-- to show a masked last-4 of it without a decrypt round-trip).
CREATE TABLE IF NOT EXISTS accounts.broker_credentials (
    user_id                      UUID PRIMARY KEY REFERENCES accounts.users(id) ON DELETE CASCADE,
    dhan_client_id               TEXT,
    dhan_access_token_encrypted  TEXT,
    delta_api_key_encrypted      TEXT,
    delta_api_secret_encrypted   TEXT,
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- BYO OpenRouter key (2026-09-16) - reuses this same table/row rather than
-- a new one, even though OpenRouter isn't a broker: it's still "one user's
-- own credential for an outside service", same shape as the four columns
-- above. Powers both market-data's news digest and signal-engine's Weekly
-- Advisor fundamentals read (both call OPENROUTER_URL directly, no shared
-- cross-system code - see each service's own accounts_client.py). Unlike
-- Dhan/Delta, the AI call this backs produces a result cached and shared
-- across ALL users (news digest per underlying, fundamentals per symbol) -
-- whichever user's request hits a stale/missing cache first pays for that
-- refresh with their own key; everyone else reads the same cached result
-- for free until it goes stale again. A user with no key configured here
-- simply never triggers a refresh themselves (falls back to the platform
-- OPENROUTER_API_KEY env var if set, otherwise degrades to no AI read -
-- same "never break, just skip the AI step" convention news.py/
-- screener_fetch.py already use for a missing key).
ALTER TABLE accounts.broker_credentials ADD COLUMN IF NOT EXISTS openrouter_api_key_encrypted TEXT;
