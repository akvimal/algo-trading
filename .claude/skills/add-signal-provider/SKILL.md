---
name: add-signal-provider
description: Scaffold a new webhook intake route in signal-engine (its processing half) for a new signal provider (e.g. TradingView, a custom scanner), following the Chartink pattern established in this repo - one Python parse function per provider (+ per direction if the provider has no native action field), normalizing into the canonical signal-ingest contract without ever touching the resolution/execution logic.
---

# Add a new signal provider

Use this when the user wants to wire up a new source of BUY/SELL signals into `signal-engine` - a new provider like TradingView, a custom scanner, or anything else that will POST to a webhook.

## Before starting

Read `systems/signal-engine/backend/app/domain/processing/intake/chartink.py` and `app/api/routes/webhooks.py` as the reference pattern, and `docs/contracts/signal-ingest.schema.json` for the target shape. Ask the user (don't guess):

1. What does the provider's raw webhook payload actually look like? (field names, whether it's one symbol or many per call, whether price/action are sent natively.)
2. Does the provider send `action` (BUY/SELL) explicitly, or does it need to be inferred (like Chartink's `scan_name`)? If inferred, prefer **one webhook path per direction** with a fixed action (this repo's established pattern - see `docs/architecture.md` § Provider adapters) over a scan-name→action lookup table, unless the user has a specific reason not to.

## Steps

1. Create `systems/signal-engine/backend/app/domain/processing/intake/<provider>.py` - a pure `parse_<provider>_alert(body: dict) -> ...` function (mirror `chartink.py`'s shape: return `(symbol, price)` pairs if the provider's payload can be many symbols per call, or map straight onto `SignalIngest`'s fields if it's simpler). Map the provider's real field names onto `{ strategy_id, symbol, action, exchange, price, timestamp, source, source_meta }` (`docs/contracts/signal-ingest.schema.json`) - `strategy_id` comes from the route's `strategy_id` query param (see step 2), never from the payload itself.
2. Add the route(s) to `systems/signal-engine/backend/app/api/routes/webhooks.py` (or a new sibling file, e.g. `webhooks_<provider>.py`, if it doesn't fit cleanly alongside Chartink's) - mirror `chartink_buy`/`chartink_sell`'s shape: `strategy_id: str = Query(...)` (FastAPI 422s automatically if it's missing - no manual `throw` needed), archive the raw payload first (`archive_raw_payload`), then create a signal per symbol via `create_signal_from_ingest` - **skip a bad symbol rather than aborting the whole batch**, same as `_handle_chartink_alert`. Wire the new router into `app/main.py` if it's a new file.
3. Add `systems/signal-engine/backend/tests/processing/test_<provider>_intake.py` for the new parse function - pure-function tests, no network/DB, mirroring `tests/processing/test_chartink_intake.py`. Run `pytest -q` in that backend.
4. Update the provider table in `docs/architecture.md` § Provider adapters.
5. Optionally add `scripts/simulate-<provider>-alert.sh`, mirroring `scripts/simulate-chartink-alert.sh` (posts straight to signal-engine's own port).
6. **Do not touch resolution or execution.** The entire point of this pattern is that a new provider never reaches past `app/domain/processing/intake/` and `app/api/routes/webhooks.py` - if the provider's payload genuinely can't be normalized into `signal-ingest.schema.json` as-is, that means the contract itself needs to change (rare, and a bigger decision) - flag it to the user rather than special-casing downstream code for one provider.
7. If this is a genuinely new provider (not TradingView, which already has a placeholder), widen the `SourceType` literal in `systems/signal-engine/backend/app/domain/generation/models.py` and the `source_type` CHECK constraint in `infra/postgres/init/03-signal-generation.sql` to include it, so a Strategy can be created with that `source_type`. Add a corresponding tab in `systems/signal-engine/frontend/src/App.tsx` (reuse the `StrategyManager` component, `showWebhooks` true) and a `<provider>WebhookUrls` helper in `src/links.ts` (mirror `chartinkWebhookUrls` - both point at signal-engine's own backend port).
8. Tell the user: (a) the new route is live as soon as this backend is rebuilt/redeployed - no manual import/activation step, unlike the old n8n-based flow; (b) they still need to create a Strategy for this provider in signal-engine and activate it before any signal will resolve.
