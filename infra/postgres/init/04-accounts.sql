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
