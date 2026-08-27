# accounts

Identity + BYO broker-credential storage for the Manual Trading + Options OI SaaS (see `docs/architecture.md` § "Manual Trading SaaS - Phase 1: accounts service"). **Phase 1 only**: this service is fully standalone right now — no other backend or frontend calls it yet. `execution`, `market-data`, and `systems/manual-trading/frontend` remain single-tenant and unauthenticated until Phases 2-4 of the roadmap wire this in.

## How it works

1. `POST /auth/signup` creates a user (`accounts.users`, bcrypt-hashed password) and returns a JWT. `POST /auth/login` verifies credentials and returns the same. `GET /auth/me` is the bearer-protected "who am I" check.
2. The JWT is signed with `JWT_SECRET` (`app/domain/security.py`) — chosen over a remote validate-call so later phases (`execution`, `market-data`) can verify a token locally and fast instead of treating this service as a hard runtime dependency for every request platform-wide. Rotating `JWT_SECRET` invalidates every session.
3. `GET`/`PUT /credentials` store a user's own Dhan (`client_id` + `access_token`) and/or Delta Exchange India (`api_key` + `api_secret`) credentials — `PUT` is a partial update (an omitted field leaves what's already stored untouched; an explicit value overwrites it). The four secret fields are encrypted at rest (Fernet, keyed by `CREDENTIALS_ENCRYPTION_KEY`) — `dhan_client_id` alone is stored plaintext since it's an identifier, not a secret. No route ever returns a decrypted secret; `GET /credentials` returns only presence flags (`has_dhan`/`has_delta`) and a masked last-4 of `dhan_client_id`.

## Endpoints

- `GET /health`
- `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`
- `GET /credentials`, `PUT /credentials` — both bearer-protected

## Running it

Behind the `execution` compose profile (not started by default):
```
docker compose --profile execution up -d --build accounts-backend
```
Needs `ACCOUNTS_JWT_SECRET`/`ACCOUNTS_CREDENTIALS_ENCRYPTION_KEY` in `.env` (see `.env.example` for how to generate them) and, on an **existing** Postgres volume, `infra/postgres/init/04-accounts.sql` applied manually the same way any other post-first-boot schema addition in this repo is (init scripts only run once, on a fresh volume — see the root `CLAUDE.md`):
```
docker compose exec -T postgres psql -U algotrading -d algotrading < infra/postgres/init/04-accounts.sql
```

## Not yet built

- Nothing else in the platform calls this service yet — `execution`'s ~53 endpoints, `market-data`'s Dhan/Delta provider layer, and the manual-trading frontend are all still single-tenant/unauthenticated (see the roadmap in `docs/architecture.md`).
- Password reset / email verification / account deletion.
- A refresh-token flow — access tokens are long-lived (7 days) with no rotation.
