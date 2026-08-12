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

export const n8nUrl = `http://${location.hostname}:5678`;

// A strategy's webhook URLs - one n8n workflow per provider+direction
// handles every strategy for that provider, differentiated by this query
// param (see docs/architecture.md § Cross-linking / Strategy webhooks).
export function chartinkWebhookUrls(strategyId: string): { buy: string; sell: string } {
  const qs = `?strategy_id=${encodeURIComponent(strategyId)}`;
  return {
    buy: `${n8nUrl}/webhook/chartink-buy${qs}`,
    sell: `${n8nUrl}/webhook/chartink-sell${qs}`,
  };
}
