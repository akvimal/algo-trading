// Cross-system deep links (each frontend reads ?signal_id= on load to
// filter/highlight). Ports match *_FRONTEND_PORT in .env - update here if
// you changed them locally. Mirrored in signal-processing/frontend/src/links.ts
// and execution/frontend/src/links.ts.
const PORTS = {
  "signal-processing": 8080,
  execution: 8081,
} as const;

function urlFor(system: keyof typeof PORTS, signalId: string): string {
  return `http://${location.hostname}:${PORTS[system]}/?signal_id=${encodeURIComponent(signalId)}`;
}

export const processingUrl = (signalId: string) => urlFor("signal-processing", signalId);
export const executionUrl = (signalId: string) => urlFor("execution", signalId);

// signal-processing's BACKEND port (its API, not its frontend UI) - a
// separate port from PORTS["signal-processing"] above, which points at
// its frontend. Same VITE_SIGNAL_PROCESSING_PORT convention api.ts uses.
const SIGNAL_PROCESSING_BACKEND_PORT = import.meta.env.VITE_SIGNAL_PROCESSING_PORT ?? "8000";
const signalProcessingBackendUrl = `http://${location.hostname}:${SIGNAL_PROCESSING_BACKEND_PORT}`;

// A strategy's webhook URLs - one route per provider+direction on
// signal-processing handles every strategy for that provider,
// differentiated by this query param (see docs/architecture.md §
// Cross-linking / Strategy webhooks). Used to live on n8n; Chartink
// intake now lives directly in signal-processing (app/api/routes/webhooks.py).
export function chartinkWebhookUrls(strategyId: string): { buy: string; sell: string } {
  const qs = `?strategy_id=${encodeURIComponent(strategyId)}`;
  return {
    buy: `${signalProcessingBackendUrl}/webhook/chartink-buy${qs}`,
    sell: `${signalProcessingBackendUrl}/webhook/chartink-sell${qs}`,
  };
}
