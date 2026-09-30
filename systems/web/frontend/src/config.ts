// Where the backends are. Like every other frontend in this repo, the browser talks to
// each backend directly on its own port (CORS-enabled); the HOST comes from the page, so
// the same build works on localhost, a LAN address and a VPS. Local dev is plain http; a
// domain deploy behind Caddy terminates TLS on the same ports, so the scheme follows the
// page (a hardcoded http: would be blocked as mixed content on an https page).

const protocol = location.protocol === "https:" ? "https:" : "http:";

function base(portVar: string | undefined, fallback: string): string {
  return `${protocol}//${location.hostname}:${portVar ?? fallback}`;
}

export type Service = "execution" | "marketData" | "accounts" | "signalEngine";

export const SERVICE_URLS: Record<Service, string> = {
  execution: base(import.meta.env.VITE_EXECUTION_PORT, "8002"),
  marketData: base(import.meta.env.VITE_MARKET_DATA_PORT, "8001"),
  accounts: base(import.meta.env.VITE_ACCOUNTS_PORT, "8004"),
  signalEngine: base(import.meta.env.VITE_SIGNAL_ENGINE_PORT, "8000"),
};

export const SEGMENTS = ["NSE", "MCX", "CRYPTO"] as const;
export type Segment = (typeof SEGMENTS)[number];
