// Cross-system deep link to execution (it reads ?signal_id= on load to
// filter/highlight). Port matches EXECUTION_FRONTEND_PORT in .env -
// update here if you changed it locally. The old signal-processing
// cross-link (processingUrl) is gone since the signal-engine merge
// (2026-08-28, see docs/architecture.md) - the Signals tab is part of
// this same app now, so App.tsx links to it with a plain in-app
// `?tab=signals&signal_id=...` href instead of a separate origin.
const EXECUTION_FRONTEND_PORT = 8081;

export function executionUrl(signalId: string): string {
  return `http://${location.hostname}:${EXECUTION_FRONTEND_PORT}/?signal_id=${encodeURIComponent(signalId)}`;
}

// This service's own backend (signal-engine, not any frontend) - the same
// VITE_SIGNAL_ENGINE_PORT convention api.ts uses.
const SIGNAL_ENGINE_BACKEND_PORT = import.meta.env.VITE_SIGNAL_ENGINE_PORT ?? "8000";
const signalEngineBackendUrl = `http://${location.hostname}:${SIGNAL_ENGINE_BACKEND_PORT}`;

// A strategy's webhook URLs - one route per provider+direction handles
// every strategy for that provider, differentiated by this query param
// (see docs/architecture.md § Cross-linking / Strategy webhooks). Used to
// live on n8n; Chartink intake now lives directly here
// (app/api/routes/webhooks.py).
export function chartinkWebhookUrls(strategyId: string): { buy: string; sell: string } {
  const qs = `?strategy_id=${encodeURIComponent(strategyId)}`;
  return {
    buy: `${signalEngineBackendUrl}/webhook/chartink-buy${qs}`,
    sell: `${signalEngineBackendUrl}/webhook/chartink-sell${qs}`,
  };
}
