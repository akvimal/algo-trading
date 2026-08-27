import { useEffect, useState } from "react";

import { type CredentialsOut, fetchCredentials, saveCredentials } from "./api";

// Intraday > My Credentials - BYO Dhan/Delta broker keys (systems/
// accounts), split out of the old combined "Checklist & Risk Settings"
// page (see docs/architecture.md § "Manual Trading SaaS"). Drafts always
// start blank - GET /credentials never echoes a decrypted secret back,
// only presence flags, same convention execution/frontend's own (now
// admin-only) platform Dhan block already used.
export default function MyCredentialsPage() {
  const [credentials, setCredentials] = useState<CredentialsOut | null>(null);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [draftDhanClientId, setDraftDhanClientId] = useState("");
  const [draftDhanAccessToken, setDraftDhanAccessToken] = useState("");
  const [savingDhanCreds, setSavingDhanCreds] = useState(false);
  const [dhanCredsMessage, setDhanCredsMessage] = useState<string | null>(null);
  const [draftDeltaApiKey, setDraftDeltaApiKey] = useState("");
  const [draftDeltaApiSecret, setDraftDeltaApiSecret] = useState("");
  const [savingDeltaCreds, setSavingDeltaCreds] = useState(false);
  const [deltaCredsMessage, setDeltaCredsMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchCredentials()
      .then(setCredentials)
      .catch((err) => setCredentialsError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function handleSaveDhanCredentials() {
    if (!draftDhanClientId.trim() || !draftDhanAccessToken.trim()) return;
    setSavingDhanCreds(true);
    setDhanCredsMessage(null);
    try {
      const updated = await saveCredentials({
        dhan_client_id: draftDhanClientId.trim(),
        dhan_access_token: draftDhanAccessToken.trim(),
      });
      setCredentials(updated);
      setDraftDhanAccessToken("");
      setDhanCredsMessage("Saved.");
    } catch (err) {
      setDhanCredsMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingDhanCreds(false);
    }
  }

  async function handleSaveDeltaCredentials() {
    if (!draftDeltaApiKey.trim() || !draftDeltaApiSecret.trim()) return;
    setSavingDeltaCreds(true);
    setDeltaCredsMessage(null);
    try {
      const updated = await saveCredentials({
        delta_api_key: draftDeltaApiKey.trim(),
        delta_api_secret: draftDeltaApiSecret.trim(),
      });
      setCredentials(updated);
      setDraftDeltaApiKey("");
      setDraftDeltaApiSecret("");
      setDeltaCredsMessage("Saved.");
    } catch (err) {
      setDeltaCredsMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingDeltaCreds(false);
    }
  }

  return (
    <div className="manual-settings-page">
      <div className="manual-page-header">
        <h3>My Credentials</h3>
      </div>

      <section className="manual-settings-section">
        <p className="subtitle">
          Your own Dhan (NSE/MCX) and Delta Exchange India (CRYPTO) keys - once saved, quotes/candles/option chains and your own manual
          orders use YOUR credentials and rate budget instead of the platform default. Never shown back once saved - paste a new value to
          replace it.
        </p>
        {credentialsError && <p className="error">{credentialsError}</p>}

        <div className="strategy-form">
          <label>
            Dhan client ID
            <input type="text" autoComplete="off" value={draftDhanClientId} onChange={(e) => setDraftDhanClientId(e.target.value)} />
          </label>
          <label>
            Dhan access token
            <input
              type="password"
              autoComplete="new-password"
              placeholder={credentials?.has_dhan ? `Configured (${credentials.dhan_client_id_masked}) - paste a new one to replace` : "Not set"}
              value={draftDhanAccessToken}
              onChange={(e) => setDraftDhanAccessToken(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="tiny"
            disabled={savingDhanCreds || !draftDhanClientId.trim() || !draftDhanAccessToken.trim()}
            onClick={() => void handleSaveDhanCredentials()}
          >
            {savingDhanCreds ? "Saving..." : "Save"}
          </button>
          {dhanCredsMessage && <span className="manual-saved-badge">{dhanCredsMessage}</span>}
        </div>

        <div className="strategy-form">
          <label>
            Delta API key
            <input type="text" autoComplete="off" value={draftDeltaApiKey} onChange={(e) => setDraftDeltaApiKey(e.target.value)} />
          </label>
          <label>
            Delta API secret
            <input
              type="password"
              autoComplete="new-password"
              placeholder={credentials?.has_delta ? "Configured - paste a new one to replace" : "Not set"}
              value={draftDeltaApiSecret}
              onChange={(e) => setDraftDeltaApiSecret(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="tiny"
            disabled={savingDeltaCreds || !draftDeltaApiKey.trim() || !draftDeltaApiSecret.trim()}
            onClick={() => void handleSaveDeltaCredentials()}
          >
            {savingDeltaCreds ? "Saving..." : "Save"}
          </button>
          {deltaCredsMessage && <span className="manual-saved-badge">{deltaCredsMessage}</span>}
        </div>
      </section>
    </div>
  );
}
