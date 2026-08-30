#!/usr/bin/env node
// Generates the random secrets .env.example calls out as "change-me" -
// same shape as the python3 -c "import secrets; print(secrets.token_urlsafe(32))"
// one-liner docs/architecture.md and .env.example otherwise point at, for
// anyone who'd rather not depend on Python being installed (e.g. a VPS
// that already has Node from running this repo's own frontends' build
// step, but not Python).
//
// Usage:
//   node scripts/generate-secrets.js                  # print only (default, safe)
//   node scripts/generate-secrets.js --write           # write into ./.env in place
//   node scripts/generate-secrets.js --write --env .env.test
//   node scripts/generate-secrets.js --write --force   # also overwrite already-set values
//
// --write only fills in a key that's still the literal .env.example
// placeholder ("change-me-to-a-random-string") - an already-configured
// secret is left untouched unless --force is passed too, since silently
// rotating ACCOUNTS_CREDENTIALS_ENCRYPTION_KEY makes every previously
// saved BYO Dhan/Delta credential undecryptable (see .env.example's own
// comment on that variable).

const crypto = require("crypto");
const fs = require("fs");

const SECRETS = ["ACCOUNTS_JWT_SECRET", "ACCOUNTS_CREDENTIALS_ENCRYPTION_KEY", "INTERNAL_SERVICE_SECRET", "DHAN_POSTBACK_SECRET"];
const PLACEHOLDER = "change-me-to-a-random-string";

// Matches Python's secrets.token_urlsafe(32): 32 random bytes, base64url
// encoded, no padding.
function tokenUrlsafe(nBytes) {
  return crypto.randomBytes(nBytes).toString("base64url");
}

function parseArgs(argv) {
  const args = { write: false, force: false, envPath: ".env" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--env") args.envPath = argv[++i];
    else {
      console.error(`Unrecognized argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

function printOnly() {
  for (const name of SECRETS) {
    console.log(`${name}=${tokenUrlsafe(32)}`);
  }
}

function writeIntoEnvFile(envPath, force) {
  if (!fs.existsSync(envPath)) {
    console.error(`${envPath} doesn't exist yet - copy it from .env.example first (cp .env.example ${envPath}), then re-run with --write.`);
    process.exit(1);
  }

  const original = fs.readFileSync(envPath, "utf8");
  const lines = original.split("\n");
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || !SECRETS.includes(match[1])) continue;
    const [, key, currentValue] = match;
    seen.add(key);
    if (currentValue !== PLACEHOLDER && !force) {
      console.log(`${key}: already set, left unchanged (use --force to overwrite)`);
      continue;
    }
    lines[i] = `${key}=${tokenUrlsafe(32)}`;
    console.log(`${key}: ${currentValue === PLACEHOLDER ? "generated" : "regenerated (--force)"}`);
  }

  const missing = SECRETS.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (lines[lines.length - 1] !== "") lines.push("");
    for (const key of missing) {
      lines.push(`${key}=${tokenUrlsafe(32)}`);
      console.log(`${key}: not found in ${envPath} - appended`);
    }
  }

  fs.writeFileSync(envPath, lines.join("\n"));
  console.log(`\nWrote ${envPath}. Restart the stack for this to take effect: docker compose up -d --build`);
}

const args = parseArgs(process.argv.slice(2));
if (args.write) {
  writeIntoEnvFile(args.envPath, args.force);
} else {
  printOnly();
}
