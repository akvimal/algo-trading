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

// Manual-trading's Live Chart (its default tab, no ?tab= needed) - reads
// ?symbol= on load. As of 2026-09-12 this accepts ANY NSE symbol, not just
// its fixed 7-symbol desk (see LiveChartPage.tsx's isCustomSymbol) - opens
// as a one-off view with full drawing-toolbar support, not added to the
// permanent desk. Used by WeeklyAdvisorPage's "Open chart" link.
const MANUAL_TRADING_FRONTEND_PORT = 8084;

export function manualTradingChartUrl(symbol: string): string {
  return `http://${location.hostname}:${MANUAL_TRADING_FRONTEND_PORT}/?symbol=${encodeURIComponent(symbol)}`;
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
