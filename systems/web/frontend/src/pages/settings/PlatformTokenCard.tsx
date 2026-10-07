import { useState } from "react";
import { ApiError } from "../../api/http";
import { getPlatformToken, refreshPlatformToken, renewPlatformToken } from "../../api/settings";
import { ErrorNotice, Skeleton } from "../../components/bits";
import { useResource } from "../../hooks/useResource";
import { expiryLook, refreshMessage } from "../platformTokenModel";

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

/** Admin only. The Dhan token the platform's background jobs, shared price feed and option-chain reads use. It is the token saved on the Dhan
 * card below (the platform owner's), renewed automatically and saved back, so there is no second copy to keep fresh. This shows how long it has
 * left and lets the admin pull a freshly saved token in at once, or renew now. */
export function PlatformTokenCard() {
  const status = useResource(getPlatformToken, [], { pollMs: 60_000 });
  const [busy, setBusy] = useState<"refresh" | "renew" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(kind: "refresh" | "renew") {
    setBusy(kind);
    setResult(null);
    try {
      if (kind === "refresh") {
        setResult(refreshMessage(await refreshPlatformToken()));
      } else {
        const r = await renewPlatformToken();
        setResult({ ok: true, text: r.saved_back_to_settings === false ? "Renewed, but the new token could not be saved back above. Save a fresh one above." : "Renewed for a fresh 24 hours and saved back above." });
      }
      status.reload();
    } catch (e) {
      setResult({ ok: false, text: msg(e) });
    } finally {
      setBusy(null);
    }
  }

  const look = status.data ? expiryLook(status.data.token_expires_at) : null;
  return (
    <div className="card" data-testid="platform-token">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>
          Platform data token
        </h2>
        {look && <span className={`pill ${look.tone === "up" ? "up" : look.tone === "dn" ? "dn" : "warn"}`} data-testid="platform-token-expiry">{look.text}</span>}
      </div>
      <p className="dim" style={{ margin: "8px 0 12px" }}>
        The end-of-day scans, the shared price feed and the option-chain reads run for the whole platform, not for one person, and use this token. It is the Dhan token saved on the card below
        (the platform owner&apos;s, the first admin&apos;s): save a fresh one there and it is picked up within minutes, or press the button to use it now. It renews itself every few hours and
        the renewed token is saved back, so there is only one copy to keep fresh.
      </p>
      {status.loading && <Skeleton lines={1} />}
      {status.error && !status.data && <ErrorNotice error={status.error} onRetry={status.reload} />}
      {result && (
        <div className={result.ok ? "notice" : "notice error"} role={result.ok ? "status" : "alert"} style={{ marginBottom: 12 }}>
          {result.text}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" disabled={busy !== null} onClick={() => void run("renew")}>
          {busy === "renew" ? "Renewing…" : "Renew now"}
        </button>
        <button className="btn btn-primary" disabled={busy !== null} onClick={() => void run("refresh")}>
          {busy === "refresh" ? "Checking…" : "Use my saved token now"}
        </button>
      </div>
    </div>
  );
}
