import type { Signal, Strategy } from "../../api/strategies";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { formatDay, formatPrice, formatTime } from "../../format";
import type { Resource } from "../../hooks/useResource";

/** Read-only: the most recent signals across every strategy the caller can see, newest first, with the
 * order it resolved to (when one exists) and why one was rejected. */
export function SignalsTab({ signals, strategies }: { signals: Resource<Signal[]>; strategies: Strategy[] }) {
  if (signals.loading) return <Skeleton lines={4} />;
  if (signals.error && !signals.data) return <ErrorNotice error={signals.error} onRetry={signals.reload} />;
  const nameOf = (id: string) => strategies.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="stack">
      {signals.data && signals.data.length === 0 && <Empty title="No signals yet">A signal appears here the moment a strategy fires, or a webhook posts one.</Empty>}
      {signals.data?.map((sig) => (
        <div className="list-row" key={sig.signal_id} data-testid="signal-row">
          <span>
            <span className={`pill ${sig.action === "BUY" ? "up" : "dn"}`}>{sig.action}</span> {sig.symbol} @ {formatPrice(sig.price)}
            <span className="faint" style={{ display: "block", fontSize: 12 }}>
              {nameOf(sig.strategy_id)} · {sig.source} · {formatDay(sig.received_at)} {formatTime(sig.received_at)}
            </span>
          </span>
          <span className={`pill ${sig.status === "REJECTED" ? "dn" : sig.status ? "up" : ""}`} title={sig.rejection_reason ?? undefined}>
            {sig.status ?? "pending"}
          </span>
        </div>
      ))}
    </div>
  );
}
