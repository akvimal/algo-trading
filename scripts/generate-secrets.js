#!/usr/bin/env node
// Generates the random secrets .env.example calls out as "change-me" -
// same shape as the python3 -c "import secrets; print(secrets.token_urlsafe(32))"
// one-liner docs/architecture.md and .env.example otherwise point at, for
// anyone who'd rather not depend on Python being installed (e.g. a VPS
// that already has Node from running this repo's own frontends' build
// step, but not Python).
//
// Usage: node scripts/generate-secrets.js
// Paste the output directly into .env (or .env.test) in place of every
// "change-me-to-a-random-string" value.

const crypto = require("crypto");

// Matches Python's secrets.token_urlsafe(32): 32 random bytes, base64url
// encoded, no padding.
function tokenUrlsafe(nBytes) {
  return crypto.randomBytes(nBytes).toString("base64url");
}

const SECRETS = ["ACCOUNTS_JWT_SECRET", "ACCOUNTS_CREDENTIALS_ENCRYPTION_KEY", "INTERNAL_SERVICE_SECRET", "DHAN_POSTBACK_SECRET"];

for (const name of SECRETS) {
  console.log(`${name}=${tokenUrlsafe(32)}`);
}
