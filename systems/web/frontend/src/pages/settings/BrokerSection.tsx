import { useState } from "react";
import { ApiError, api } from "../../api/http";
import { checkLiveData, refreshPlatformToken, saveCredentials, updateAccount } from "../../api/settings";
import { useIsAdmin } from "../../auth/AuthContext";
import type { Account, Credentials, LiveEligibility } from "../../api/types";
import { ErrorNotice, Skeleton } from "../../components/bits";
import { TextField } from "../../components/Field";
import { formatInr } from "../../format";
import { useResource, type Resource } from "../../hooks/useResource";
import { buildCredentialsPatch, buildLiveOnPatch, liveStatus, type KeyField } from "../settingsModel";
import { refreshMessage } from "../platformTokenModel";
import { PlatformTokenCard } from "./PlatformTokenCard";
import { graduation } from "../portfolioModel";

export const LIVE_CONSENT_TEXT =
  "I understand that turning this on means every order I place is a REAL order sent to my own Dhan account using my saved keys, not a paper trade, and that I can lose more than I put in. I am responsible for every order.";

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

type Props = { creds: Resource<Credentials>; accounts: Account[]; onAccountSaved: () => void };

export function BrokerSection({ creds, accounts, onAccountSaved }: Props) {
  const isAdmin = useIsAdmin();
  return (
    <div className="stack">
      <DhanCard creds={creds} />
      {isAdmin && <PlatformTokenCard />}
      {accounts
        .filter((a) => a.segment !== "CRYPTO")
        .map((a) => (
          <LiveCard key={a.segment} account={a} hasDhan={Boolean(creds.data?.has_dhan)} onSaved={onAccountSaved} />
        ))}
      <OtherConnections creds={creds} />
    </div>
  );
}

function StatusPill({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return <span className={`pill ${on ? "up" : "warn"}`}>{on ? yes : no}</span>;
}

/** The connection that drives live prices, and later real orders. Secrets are write-only: after
 * saving, only "connected" and a masked client ID ever come back. */
function DhanCard({ creds }: { creds: Resource<Credentials> }) {
  const isAdmin = useIsAdmin();
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save() {
    const { patch, error } = buildCredentialsPatch({ dhan_client_id: clientId, dhan_access_token: token }, creds.data);
    if (error) return setResult({ kind: "error", text: error });
    setBusy(true);
    setResult(null);
    try {
      await saveCredentials(patch);
      setClientId("");
      setToken("");
      let text = "Saved. Use “Check live data” to confirm it works.";
      if (isAdmin && patch.dhan_access_token) {
        // The platform's scans and feed use the owner's saved token: pull it in now rather than waiting for the periodic check.
        try {
          const r = refreshMessage(await refreshPlatformToken());
          text += r.ok ? ` ${r.text.replace("Now using the token saved above.", "The platform\u2019s scans and price feed now use it too.")}` : ` The platform kept its own token: ${r.text}`;
        } catch {
          text += " The platform will pick it up within a few minutes.";
        }
      }
      setResult({ kind: "ok", text });
      creds.reload();
    } catch (e) {
      setResult({ kind: "error", text: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setCheck(true);
    setResult(null);
    try {
      const q = await checkLiveData();
      setResult({ kind: "ok", text: `Live prices are working. ${q.symbol} is ${formatInr(q.ltp, 2)}.` });
    } catch (e) {
      setResult({ kind: "error", text: msg(e) });
    } finally {
      setCheck(false);
    }
  }

  const c = creds.data;
  return (
    <div className="card" id="dhan">
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>
          Dhan connection
        </h2>
        {c && <StatusPill on={c.has_dhan} yes="Connected" no="Not connected" />}
      </div>
      {creds.loading && <Skeleton lines={2} />}
      {creds.error && <ErrorNotice error={creds.error} onRetry={creds.reload} />}
      {c && (
        <>
          <p className="dim" style={{ margin: "8px 0 12px" }}>
            {c.has_dhan
              ? `Client ${c.dhan_client_id_masked ?? ""}. Live prices come from your own Dhan account.`
              : "Live prices come from your own Dhan account. Add your Dhan client ID and access token to see them."}
          </p>
          <TextField id="dhan-client" label={c.has_dhan ? "Client ID (leave blank to keep)" : "Client ID"} inputMode="text" value={clientId} onChange={setClientId} />
          <TextField
            id="dhan-token"
            label={c.has_dhan ? "New access token" : "Access token"}
            type="password"
            inputMode="text"
            value={token}
            onChange={setToken}
            hint="Dhan access tokens expire after 24 hours. When live prices stop, paste a fresh one here. It is stored encrypted and never shown again."
          />
          {result && (
            <div className={result.kind === "error" ? "notice error" : "notice"} role={result.kind === "error" ? "alert" : "status"} style={{ marginBottom: 12 }}>
              {result.text}
            </div>
          )}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" disabled={check || busy} onClick={() => void test()}>
              {check ? "Checking…" : "Check live data"}
            </button>
            <button className="btn btn-primary" disabled={busy || (!clientId.trim() && !token.trim())} onClick={() => void save()}>
              {busy ? "Saving…" : c.has_dhan ? "Update" : "Connect"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Real-money orders. The server is the gate (consent, caps, keys, track record, kill switch) and
 * lists everything unmet; this screen shows it and never decides it. Switching back to paper is
 * always one tap. */
function LiveCard({ account, hasDhan, onSaved }: { account: Account; hasDhan: boolean; onSaved: () => void }) {
  const status = liveStatus(account);
  const elig = useResource(() => api<LiveEligibility>("execution", `/live-eligibility/${account.segment}`), [account.segment]);
  const [orderCap, setOrderCap] = useState(account.max_order_value == null ? "" : String(account.max_order_value));
  const [lossCap, setLossCap] = useState(account.max_daily_loss == null ? "" : String(account.max_daily_loss));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function turnOn() {
    const { patch, error } = buildLiveOnPatch({ maxOrderValue: orderCap, maxDailyLoss: lossCap, consent });
    if (!patch) return setError(error);
    setBusy(true);
    setError(null);
    try {
      await updateAccount(account.segment, patch);
      setConsent(false);
      onSaved();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      await updateAccount(account.segment, { live_trading_enabled: false });
      onSaved();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  const label = account.segment === "NSE" ? "Stocks & F&O" : "Commodities";
  const g = elig.data ? graduation(elig.data) : null;

  return (
    <div className="card" data-testid={`live-${account.segment}`}>
      <div className="row">
        <h2 className="section-title" style={{ margin: 0 }}>
          Live trading · {label}
        </h2>
        {status === "live" ? <span className="pill dn">LIVE</span> : <span className="pill">Paper</span>}
      </div>

      {status === "live" ? (
        <>
          <p style={{ margin: "8px 0" }}>
            Orders on this account now go to your Dhan account as real orders.
            {account.max_order_value != null && ` Largest single order: ${formatInr(account.max_order_value)}.`}
            {account.max_daily_loss != null && ` Daily loss limit: ${formatInr(account.max_daily_loss)}.`}
          </p>
          {error && <ErrorNoticeText text={error} />}
          <button className="btn" disabled={busy} onClick={() => void turnOff()}>
            {busy ? "Switching…" : "Switch back to paper"}
          </button>
        </>
      ) : (
        <>
          <p className="dim" style={{ margin: "8px 0" }}>
            You are trading on paper. Live orders use real money and stay off until you turn them on here.
          </p>
          {elig.loading && <Skeleton lines={2} />}
          {g && (
            <div style={{ marginBottom: 12 }}>
              <div className="row">
                <span>Paper track record</span>
                <span className={`pill ${g.eligible ? "up" : "warn"}`}>
                  {g.met} of {g.total}
                </span>
              </div>
              {g.unmet.map((r) => (
                <div className="list-row" key={r.key}>
                  <span className="dim">{r.label}</span>
                  <span className="num dim">
                    {r.actual} / {r.required}
                  </span>
                </div>
              ))}
              {!g.enforced && <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>Right now this is a guide and does not block you.</p>}
            </div>
          )}
          <div className="row" style={{ marginBottom: 8 }}>
            <span>Dhan keys</span>
            <StatusPill on={hasDhan} yes="Saved" no="Not saved" />
          </div>
          <TextField id={`${account.segment}-ordercap`} label="Largest single order" suffix="₹" value={orderCap} onChange={setOrderCap} hint="No real order above this value is sent." />
          <TextField id={`${account.segment}-losscap`} label="Daily loss limit" suffix="₹" value={lossCap} onChange={setLossCap} hint="Live orders stop once your losses for the day reach this." />
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{LIVE_CONSENT_TEXT}</span>
          </label>
          {error && <ErrorNoticeText text={error} />}
          <button className="btn btn-danger" disabled={busy} onClick={() => void turnOn()}>
            {busy ? "Checking…" : "Turn on live trading"}
          </button>
        </>
      )}
    </div>
  );
}

function ErrorNoticeText({ text }: { text: string }) {
  return (
    <div className="notice error" role="alert" style={{ marginBottom: 12 }}>
      {text}
    </div>
  );
}

const OTHER: { title: string; blurb: string; has: (c: Credentials) => boolean; fields: { key: KeyField; label: string }[] }[] = [
  { title: "Delta Exchange (crypto)", blurb: "Only needed for crypto orders and account data.", has: (c) => c.has_delta, fields: [{ key: "delta_api_key", label: "API key" }, { key: "delta_api_secret", label: "API secret" }] },
  { title: "OpenRouter (AI news notes)", blurb: "Powers the AI news summaries. Your own key, your own usage.", has: (c) => c.has_openrouter, fields: [{ key: "openrouter_api_key", label: "API key" }] },
];

function OtherConnections({ creds }: { creds: Resource<Credentials> }) {
  if (!creds.data) return null;
  return (
    <>
      <h2 className="section-title">Other connections</h2>
      {OTHER.map((o) => (
        <KeyCard key={o.title} spec={o} creds={creds} />
      ))}
    </>
  );
}

function KeyCard({ spec, creds }: { spec: (typeof OTHER)[number]; creds: Resource<Credentials> }) {
  const [values, setValues] = useState<Partial<Record<KeyField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const has = creds.data ? spec.has(creds.data) : false;

  async function save() {
    const { patch, error } = buildCredentialsPatch(values, creds.data);
    if (error) return setResult({ kind: "error", text: error });
    setBusy(true);
    setResult(null);
    try {
      await saveCredentials(patch);
      setValues({});
      setResult({ kind: "ok", text: "Saved." });
      creds.reload();
    } catch (e) {
      setResult({ kind: "error", text: msg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <strong>{spec.title}</strong>
        <StatusPill on={has} yes="Saved" no="Not set" />
      </div>
      <p className="dim" style={{ margin: "6px 0 12px" }}>{spec.blurb}</p>
      {spec.fields.map((f) => (
        <TextField key={f.key} id={f.key} type="password" inputMode="text" label={has ? `${f.label} (leave blank to keep)` : f.label} value={values[f.key] ?? ""} onChange={(v) => setValues({ ...values, [f.key]: v })} />
      ))}
      {result && (
        <div className={result.kind === "error" ? "notice error" : "notice"} role={result.kind === "error" ? "alert" : "status"} style={{ marginBottom: 12 }}>
          {result.text}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
