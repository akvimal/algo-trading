---
name: add-signal-provider
description: Scaffold a new n8n webhook intake workflow for a new signal provider (e.g. TradingView, a custom scanner), following the Chartink pattern established in this repo - one JSON workflow per provider (+ per direction if the provider has no native action field), normalizing into the canonical signal-ingest contract without ever touching the backend.
---

# Add a new signal provider

Use this when the user wants to wire up a new source of BUY/SELL signals into `signal-processing` - a new provider like TradingView, a custom scanner, or anything else that will POST to an n8n webhook.

## Before starting

Read `infra/n8n/workflows/chartink-buy-intake.json` and `chartink-sell-intake.json` as the reference pattern, and `docs/contracts/signal-ingest.schema.json` for the target shape. Ask the user (don't guess):

1. What does the provider's raw webhook payload actually look like? (field names, whether it's one symbol or many per call, whether price/action are sent natively.)
2. Does the provider send `action` (BUY/SELL) explicitly, or does it need to be inferred (like Chartink's `scan_name`)? If inferred, prefer **one webhook path per direction** with a fixed action (this repo's established pattern - see `docs/architecture.md` § Provider adapters) over a scan-name→action lookup table, unless the user has a specific reason not to.

## Steps

1. Create `infra/n8n/workflows/<provider>[-<direction>]-intake.json` by copying the Chartink workflow's node shape (`Webhook` → `Archive raw payload` → `Normalize [+ fan-out]` → `POST /signals` → `Respond 200`) and adjusting:
   - the Webhook node's `path` to the new provider's path
   - the `Code` node's `jsCode` to map the provider's real field names onto `{ strategy_id, symbol, action, exchange, price, timestamp, source, source_meta }` - **`strategy_id` comes from `$json.query.strategy_id`**, the same query-param pattern as Chartink (see `docs/architecture.md` § "Webhook shape: query param, not one workflow per strategy"). Throw if it's missing, same as the Chartink workflows do - a signal with no strategy can't be resolved.
   - `source` to the provider's identifier
2. Validate the JSON parses: `python -c "import json; json.load(open('infra/n8n/workflows/<file>.json'))"`.
3. Update `infra/n8n/workflows/README.md`'s provider table and setup instructions.
4. Update the provider table in `docs/architecture.md` § Provider adapters.
5. Optionally add `scripts/simulate-<provider>-alert.sh`, mirroring `scripts/simulate-chartink-alert.sh`, so the new path can be tested without hitting the real provider.
6. **Do not modify `systems/signal-processing/backend`.** The entire point of this pattern is that a new provider never touches the backend - only the n8n adapter layer changes. If the provider's payload genuinely can't be normalized into `signal-ingest.schema.json` as-is, that means the contract itself needs to change (rare, and a bigger decision) - flag it to the user rather than special-casing the backend for one provider.
7. If this is a genuinely new provider (not TradingView, which already has a placeholder), widen the `SourceType` literal in `systems/signal-generation/backend/app/domain/models.py` and the `source_type` CHECK constraint in `infra/postgres/init/03-signal-generation.sql` to include it, so a Strategy can be created with that `source_type`. Add a corresponding tab in `systems/signal-generation/frontend/src/App.tsx` (reuse the `StrategyManager` component, `showWebhooks` true).
8. Tell the user: (a) the workflow still needs to be imported and activated manually in the n8n UI - n8n does not read `infra/n8n/workflows/` at runtime, that folder is version control for exports only; (b) they need to create a Strategy for this provider in signal-generation and activate it before any signal will resolve.
