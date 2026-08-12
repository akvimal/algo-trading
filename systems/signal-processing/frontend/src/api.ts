export type ResolvedSignal = {
  signal_id: string;
  strategy_id: string;
  symbol: string;
  exchange: string;
  action: "BUY" | "SELL";
  price: number;
  source: string;
  received_at: string;
  horizon: string | null;
  instrument_type: string | null;
  status: string | null;
  rejection_reason: string | null;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function fetchSignals(opts: { limit?: number; signalId?: string } = {}): Promise<ResolvedSignal[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.signalId) params.set("signal_id", opts.signalId);

  const res = await fetch(`${API_BASE}/signals?${params}`);
  if (!res.ok) {
    throw new Error(`GET /signals failed: ${res.status}`);
  }
  return res.json();
}

export type ClearSignalsResult = {
  signals_deleted: number;
  resolved_orders_deleted: number;
  raw_payloads_deleted: number;
};

export async function clearSignals(): Promise<ClearSignalsResult> {
  const res = await fetch(`${API_BASE}/signals`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /signals failed: ${res.status}`);
  }
  return res.json();
}
