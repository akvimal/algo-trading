import { useEffect, useState } from "react";

import {
  type Account,
  type DhanStatus,
  type Settings,
  fetchAccounts,
  fetchDhanStatus,
  fetchSettings,
  resetAccount,
  updateAccount,
  updateDhanCredentials,
  updateSettings,
} from "./api";
import Nav from "./Nav";
import { SEGMENTS, formatPct } from "./format";

const POLL_INTERVAL_MS = 5000;
const LEVERAGE_OPTIONS = [1, 10, 25, 50, 100, 150, 200];

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [drafts, setDrafts] = useState<
    Record<string, { capital: number | ""; risk: number | ""; leverage: number | ""; squareOffTime: string }>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [usdinrDraft, setUsdinrDraft] = useState<number | "">("");
  const [savingUsdinr, setSavingUsdinr] = useState(false);
  const [usdinrMessage, setUsdinrMessage] = useState<string | null>(null);

  // Data provider (Dhan) credentials - fetched from market-data directly
  // (see api.ts's own comment on this section). accessTokenDraft is never
  // pre-filled from the fetched status (has_access_token is a presence
  // check only, market-data never echoes the real secret back) - blank
  // means "leave the currently-configured token alone" is NOT an option
  // here (PUT /dhan/credentials always sets both fields together), so the
  // Save button stays disabled until both are typed.
  const [dhanStatus, setDhanStatus] = useState<DhanStatus | null>(null);
  const [dhanClientIdDraft, setDhanClientIdDraft] = useState("");
  const [dhanAccessTokenDraft, setDhanAccessTokenDraft] = useState("");
  const [savingDhan, setSavingDhan] = useState(false);
  const [dhanMessage, setDhanMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setSettings(s);
        setUsdinrDraft(s.usdinr_rate ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings"));
    fetchDhanStatus()
      .then((s) => {
        setDhanStatus(s);
        setDhanClientIdDraft(s.dhan_client_id);
      })
      .catch(() => {
        // market-data may be down/unreachable - this section just shows
        // its own "couldn't load" state below rather than blocking the
        // rest of the page (accounts/USDINR are unrelated to it).
      });
  }, []);

  async function handleSaveDhanCredentials() {
    if (!dhanClientIdDraft.trim() || !dhanAccessTokenDraft.trim()) return;
    setSavingDhan(true);
    setDhanMessage(null);
    try {
      const updated = await updateDhanCredentials(dhanClientIdDraft.trim(), dhanAccessTokenDraft.trim());
      setDhanStatus(updated);
      setDhanAccessTokenDraft("");
      setDhanMessage("Data provider keys saved.");
    } catch (err) {
      setDhanMessage(err instanceof Error ? err.message : "Failed to save data provider keys");
    } finally {
      setSavingDhan(false);
    }
  }

  async function handleSaveUsdinr() {
    if (usdinrDraft === "") return;
    setSavingUsdinr(true);
    setUsdinrMessage(null);
    try {
      const updated = await updateSettings({ usdinr_rate: usdinrDraft });
      setSettings(updated);
      setUsdinrMessage("USDINR rate saved.");
    } catch (err) {
      setUsdinrMessage(err instanceof Error ? err.message : "Failed to save USDINR rate");
    } finally {
      setSavingUsdinr(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchAccounts();
        if (cancelled) return;
        setAccounts(data);
        setDrafts((prev) => {
          const next = { ...prev };
          for (const a of data) {
            if (!(a.segment in next))
              next[a.segment] = {
                capital: a.capital_per_trade,
                risk: a.risk_per_trade_pct,
                leverage: a.leverage,
                squareOffTime: a.square_off_time ? a.square_off_time.slice(0, 5) : "",
              };
          }
          return next;
        });
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load accounts");
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function handleSave(segment: Account["segment"]) {
    const draft = drafts[segment];
    if (!draft || draft.capital === "" || draft.risk === "" || draft.leverage === "") return;
    setSaving(segment);
    setMessage(null);
    try {
      const updated = await updateAccount(segment, {
        capital_per_trade: draft.capital,
        risk_per_trade_pct: draft.risk,
        leverage: draft.leverage,
        square_off_time: draft.squareOffTime ? `${draft.squareOffTime}:00` : null,
      });
      setAccounts((prev) => prev.map((a) => (a.segment === segment ? updated : a)));
      setMessage(`${segment} account saved.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : `Failed to save ${segment} account`);
    } finally {
      setSaving(null);
    }
  }

  async function handleReset(segment: Account["segment"]) {
    const confirmed = window.confirm(
      `Reset the ${segment} account's balance back to its starting balance? This doesn't undo any positions.`,
    );
    if (!confirmed) return;
    setResetting(segment);
    setMessage(null);
    try {
      const updated = await resetAccount(segment);
      setAccounts((prev) => prev.map((a) => (a.segment === segment ? updated : a)));
      setMessage(`${segment} account balance reset.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : `Failed to reset ${segment} account`);
    } finally {
      setResetting(null);
    }
  }

  return (
    <main>
      <header>
        <div className="header-row">
          <h1>execution</h1>
          <Nav active="accounts" />
        </div>
        <p className="subtitle">One paper-trading account per segment - balance moves only on realized P&amp;L.</p>
      </header>

      {error && <p className="error">Could not reach the backend: {error}</p>}
      {message && <p className="action-message">{message}</p>}

      <div className="settings-row">
        <label>
          USDINR rate (&#8377; per $1, CRYPTO sizing only)
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Not set"
            value={usdinrDraft}
            onChange={(e) => setUsdinrDraft(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
        <button type="button" className="secondary tiny" onClick={handleSaveUsdinr} disabled={savingUsdinr || usdinrDraft === ""}>
          {savingUsdinr ? "Saving..." : "Save"}
        </button>
      </div>
      {usdinrMessage && <p className="action-message">{usdinrMessage}</p>}
      {settings && settings.usdinr_rate == null && (
        <p className="subtitle">No USDINR rate set - CRYPTO positions will reject until one is configured.</p>
      )}

      <h2>Data provider (Dhan)</h2>
      <p className="subtitle">
        Client ID and access token for NSE/MCX quotes and candles (market-data's own credentials) - saving here takes
        effect immediately, no restart needed, but doesn't survive one (in-memory only, same as a renewed token).
      </p>
      <div className="settings-row">
        <label>
          Client ID
          <input
            type="text"
            placeholder="Dhan client ID"
            value={dhanClientIdDraft}
            onChange={(e) => setDhanClientIdDraft(e.target.value)}
          />
        </label>
        <label>
          Access token
          <input
            type="password"
            placeholder={dhanStatus?.has_access_token ? "Configured (hidden) - paste a new one to replace" : "Not set"}
            value={dhanAccessTokenDraft}
            onChange={(e) => setDhanAccessTokenDraft(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary tiny"
          onClick={handleSaveDhanCredentials}
          disabled={savingDhan || !dhanClientIdDraft.trim() || !dhanAccessTokenDraft.trim()}
        >
          {savingDhan ? "Saving..." : "Save"}
        </button>
      </div>
      {dhanMessage && <p className="action-message">{dhanMessage}</p>}
      {dhanStatus ? (
        <p className="subtitle">
          {dhanStatus.has_access_token
            ? `Configured (client ID ${dhanStatus.dhan_client_id})${dhanStatus.dhan_client_name ? ` - ${dhanStatus.dhan_client_name}` : ""}.`
            : "No access token configured - Dhan-backed quotes/candles (NSE, MCX) will fail until one is set."}
        </p>
      ) : (
        <p className="subtitle">Could not reach market-data to check the current status.</p>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Segment</th>
              <th>Balance</th>
              <th>Capital per trade (&#8377;)</th>
              <th>Risk per trade (%)</th>
              <th>Leverage (CRYPTO only)</th>
              <th>Square-off (blank = never)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((segment) => {
              const account = accounts.find((a) => a.segment === segment);
              const draft = drafts[segment] ?? { capital: "", risk: "", leverage: "", squareOffTime: "" };
              const delta = account ? account.current_balance - account.starting_balance : null;
              return (
                <tr key={segment}>
                  <td className="symbol">{segment}</td>
                  <td className={`num ${delta != null ? (delta >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}>
                    {account ? account.current_balance.toFixed(2) : "-"}
                    {delta != null && formatPct(account ? (delta / account.starting_balance) * 100 : null)}
                  </td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={draft.capital}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [segment]: { ...draft, capital: e.target.value === "" ? "" : Number(e.target.value) },
                        }))
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0.01"
                      max="100"
                      step="0.1"
                      value={draft.risk}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [segment]: { ...draft, risk: e.target.value === "" ? "" : Number(e.target.value) },
                        }))
                      }
                    />
                  </td>
                  <td>
                    {segment === "CRYPTO" ? (
                      <select
                        value={draft.leverage}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [segment]: { ...draft, leverage: e.target.value === "" ? "" : Number(e.target.value) },
                          }))
                        }
                      >
                        {/* Delta Exchange India's own BTCUSD leverage tiers - picking one of
                            these keeps our simulated buying power comparable to what the same
                            capital would actually get you there, rather than an arbitrary number. */}
                        {LEVERAGE_OPTIONS.map((lev) => (
                          <option key={lev} value={lev}>
                            {lev}x
                          </option>
                        ))}
                      </select>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <input
                      type="time"
                      value={draft.squareOffTime}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [segment]: { ...draft, squareOffTime: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td>
                    <button type="button" className="tiny" onClick={() => handleSave(segment)} disabled={saving === segment}>
                      {saving === segment ? "Saving..." : "Save"}
                    </button>{" "}
                    <button
                      type="button"
                      className="secondary tiny"
                      onClick={() => handleReset(segment)}
                      disabled={resetting === segment}
                    >
                      {resetting === segment ? "Resetting..." : "Reset balance"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
