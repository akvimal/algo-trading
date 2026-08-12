# n8n workflows

Exported workflow JSON, version-controlled here and imported manually into n8n (Workflows -> Import from File, or drag the file onto the canvas). This is a one-way export/import for now — n8n doesn't read this folder at runtime (it's mounted read-only into the container at `/workflows` purely for reference/copy-paste).

- `chartink-buy-intake.json` — webhook path `chartink-buy`, fixed `action: BUY`.
- `chartink-sell-intake.json` — webhook path `chartink-sell`, fixed `action: SELL`.

Both require a `?strategy_id=<uuid>` query param — get one by creating a Strategy in signal-generation (http://localhost:8082, Chartink tab, or `POST /strategies` on its API) and copying its webhook URLs. The **same two workflows handle every Chartink strategy** — the query param is what scopes a signal to a specific strategy's configuration, not a new workflow per strategy. A request missing `strategy_id` is rejected by the workflow itself (the `Normalize + fan-out` Code node throws before anything reaches signal-processing).

## Setting up in Chartink

For each strategy, create a Chartink scan alert (Chartink -> Scanner -> Create Alert -> Webhook) pointing at that strategy's URLs (copy them from the signal-generation frontend):

```
http://<your-host>:5678/webhook/chartink-buy?strategy_id=<id>    (buy-condition scans)
http://<your-host>:5678/webhook/chartink-sell?strategy_id=<id>   (sell-condition scans)
```

Locally this means exposing n8n to the internet (e.g. via `ngrok http 5678` or a tunnel) since Chartink's servers need to reach the webhook — `localhost` alone won't work. `make test-signal` simulates a Chartink call locally without needing that exposed yet (and auto-creates a throwaway strategy if you don't pass one).

## Adding a new provider

Use the `add-signal-provider` Claude Code skill, or copy one of these files as a starting point: new webhook path, new `Normalize + fan-out` Code node mapping that provider's payload shape onto `docs/contracts/signal-ingest.schema.json` (including pulling `strategy_id` from `$json.query.strategy_id` and throwing if it's absent), same `Archive raw payload` -> `POST /signals` -> `Respond 200` shape. The backend never needs to change.
