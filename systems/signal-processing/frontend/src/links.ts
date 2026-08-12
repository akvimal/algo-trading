// Cross-system deep links (each frontend reads ?signal_id= on load to
// filter/highlight). Ports match *_FRONTEND_PORT in .env - update here if
// you changed them locally. Mirrored in execution/frontend/src/links.ts
// and signal-generation/frontend/src/links.ts.
const PORTS = {
  "signal-generation": 8082,
  execution: 8081,
} as const;

function urlFor(system: keyof typeof PORTS, signalId: string): string {
  return `http://${location.hostname}:${PORTS[system]}/?signal_id=${encodeURIComponent(signalId)}`;
}

export const executionUrl = (signalId: string) => urlFor("execution", signalId);
export const generationUrl = (signalId: string) => urlFor("signal-generation", signalId);
