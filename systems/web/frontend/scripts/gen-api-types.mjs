// Generates TypeScript types from each running backend's OpenAPI document into
// src/api/generated/<service>.d.ts. Needs the dev stack up (`docker compose --profile
// execution up -d`). Reference output: screens import the narrow hand-written types in
// src/api/types.ts, and tighten them against these when they need more fields.
import { mkdirSync, writeFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";

const HOST = process.env.API_HOST ?? "localhost";
const SERVICES = {
  execution: process.env.VITE_EXECUTION_PORT ?? "8002",
  "market-data": process.env.VITE_MARKET_DATA_PORT ?? "8001",
  accounts: process.env.VITE_ACCOUNTS_PORT ?? "8004",
  "signal-engine": process.env.VITE_SIGNAL_ENGINE_PORT ?? "8000",
};

mkdirSync("src/api/generated", { recursive: true });
let failed = 0;
for (const [name, port] of Object.entries(SERVICES)) {
  const url = `http://${HOST}:${port}/openapi.json`;
  try {
    const ast = await openapiTS(new URL(url));
    writeFileSync(`src/api/generated/${name}.d.ts`, astToString(ast));
    console.log(`ok   ${name}  <- ${url}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${name}  <- ${url}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
