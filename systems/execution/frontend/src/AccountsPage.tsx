import { useEffect, useState } from "react";

import {
  type Account,
  type DhanStatus,
  type FeedStatus,
  type Settings,
  type StrategyAccount,
  type StrategySummary,
  createStrategyAccount,
  deleteStrategyAccount,
  fetchAccounts,
  fetchDhanStatus,
  fetchFeedStatus,
  fetchPlatformAccounts,
  fetchSettings,
  fetchStrategyAccounts,
  fetchStrategyNames,
  renewDhanToken,
  resetAccount,
  resetStrategyAccount,
  subscribeFeed,
  updateAccount,
  updateDhanCredentials,
  updatePlatformAccount,
  updateSettings,
  updateStrategyAccount,
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

  // Platform-wide (user_id IS NULL) accounts - the rows the automated
  // Strategy-driven flow actually reads (see api.ts's own comment on
  // fetchPlatformAccounts). Deliberately separate state from the per-caller
  // `accounts`/`drafts` above - this is broker/platform config (leverage,
  // MTF interest), not this admin's own personal paper-trading account.
  const [platformAccounts, setPlatformAccounts] = useState<Account[]>([]);
  const [platformDrafts, setPlatformDrafts] = useState<
    Record<string, { leverage: number | ""; mtfInterestRate: number | "" }>
  >({});
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [savingPlatform, setSavingPlatform] = useState<string | null>(null);
  const [platformMessage, setPlatformMessage] = useState<string | null>(null);

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
  const [renewingDhan, setRenewingDhan] = useState(false);

  // Live tick feed status/subscribe (app/providers/dhan_feed.py) - same
  // admin-only ops surface as the credentials block above.
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null);
  const [feedExchangeDraft, setFeedExchangeDraft] = useState("NSE");
  const [feedSymbolDraft, setFeedSymbolDraft] = useState("");
  const [subscribingFeed, setSubscribingFeed] = useState(false);
  const [feedMessage, setFeedMessage] = useState<string | null>(null);

  // Optional per-strategy dedicated accounts (execution.strategy_accounts) -
  // strategies list comes from signal-generation directly (same
  // cross-system CORS pattern PositionsPage already uses for the same
  // data), so the picker/segment auto-fill below work without execution
  // owning a copy of Strategy names.
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [strategyAccounts, setStrategyAccounts] = useState<StrategyAccount[]>([]);
  const [strategyAccountError, setStrategyAccountError] = useState<string | null>(null);
  const [strategyAccountMessage, setStrategyAccountMessage] = useState<string | null>(null);
  const [strategyDrafts, setStrategyDrafts] = useState<Record<string, { capital: number | ""; risk: number | "" }>>({});
  const [savingStrategyAccount, setSavingStrategyAccount] = useState<string | null>(null);
  const [resettingStrategyAccount, setResettingStrategyAccount] = useState<string | null>(null);
  const [deletingStrategyAccount, setDeletingStrategyAccount] = useState<string | null>(null);

  const [newStrategyId, setNewStrategyId] = useState("");
  const [newStartingBalance, setNewStartingBalance] = useState<number | "">(200000);
  const [newCapitalPerTrade, setNewCapitalPerTrade] = useState<number | "">(50000);
  const [newRiskPerTrade, setNewRiskPerTrade] = useState<number | "">(1);
  const [creatingStrategyAccount, setCreatingStrategyAccount] = useState(false);

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
    fetchFeedStatus()
      .then(setFeedStatus)
      .catch(() => {
        // Same "don't block the rest of the page" reasoning as above.
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

  async function handleRenewDhanToken() {
    setRenewingDhan(true);
    setDhanMessage(null);
    try {
      await renewDhanToken();
      setDhanStatus(await fetchDhanStatus());
      setDhanMessage("Token renewed.");
    } catch (err) {
      setDhanMessage(err instanceof Error ? err.message : "Failed to renew token");
    } finally {
      setRenewingDhan(false);
    }
  }

  async function handleSubscribeFeed() {
    if (!feedSymbolDraft.trim()) return;
    setSubscribingFeed(true);
    setFeedMessage(null);
    try {
      const updated = await subscribeFeed(feedExchangeDraft, feedSymbolDraft.trim());
      setFeedStatus(updated);
      setFeedMessage(`Subscribed to ${feedExchangeDraft}:${feedSymbolDraft.trim()}.`);
    } catch (err) {
      setFeedMessage(err instanceof Error ? err.message : "Failed to subscribe");
    } finally {
      setSubscribingFeed(false);
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

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchPlatformAccounts();
        if (cancelled) return;
        setPlatformAccounts(data);
        setPlatformDrafts((prev) => {
          const next = { ...prev };
          for (const a of data) {
            if (!(a.segment in next))
              next[a.segment] = { leverage: a.leverage, mtfInterestRate: a.mtf_annual_interest_rate_pct ?? "" };
          }
          return next;
        });
        setPlatformError(null);
      } catch (err) {
        if (!cancelled) setPlatformError(err instanceof Error ? err.message : "Failed to load platform accounts");
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchStrategyAccounts();
        if (cancelled) return;
        setStrategyAccounts(data);
        setStrategyDrafts((prev) => {
          const next = { ...prev };
          for (const a of data) {
            if (!(a.strategy_id in next)) next[a.strategy_id] = { capital: a.capital_per_trade, risk: a.risk_per_trade_pct };
          }
          return next;
        });
        setStrategyAccountError(null);
      } catch (err) {
        if (!cancelled) setStrategyAccountError(err instanceof Error ? err.message : "Failed to load dedicated accounts");
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    fetchStrategyNames()
      .then(setStrategies)
      .catch(() => {
        // signal-generation may be unreachable - the create form just
        // shows an empty picker below rather than blocking this page.
      });
  }, []);

  function strategyName(strategyId: string): string {
    return strategies.find((s) => s.id === strategyId)?.name ?? strategyId;
  }

  async function handleCreateStrategyAccount() {
    if (!newStrategyId || newStartingBalance === "" || newCapitalPerTrade === "" || newRiskPerTrade === "") return;
    const strategy = strategies.find((s) => s.id === newStrategyId);
    if (!strategy) return;
    setCreatingStrategyAccount(true);
    setStrategyAccountMessage(null);
    try {
      const created = await createStrategyAccount(newStrategyId, {
        segment: strategy.segment,
        starting_balance: newStartingBalance,
        capital_per_trade: newCapitalPerTrade,
        risk_per_trade_pct: newRiskPerTrade,
      });
      setStrategyAccounts((prev) => [...prev, created]);
      setNewStrategyId("");
      setStrategyAccountMessage(`Dedicated account created for ${strategy.name}.`);
    } catch (err) {
      setStrategyAccountMessage(err instanceof Error ? err.message : "Failed to create dedicated account");
    } finally {
      setCreatingStrategyAccount(false);
    }
  }

  async function handleSaveStrategyAccount(strategyId: string) {
    const draft = strategyDrafts[strategyId];
    if (!draft || draft.capital === "" || draft.risk === "") return;
    setSavingStrategyAccount(strategyId);
    setStrategyAccountMessage(null);
    try {
      const updated = await updateStrategyAccount(strategyId, {
        capital_per_trade: draft.capital,
        risk_per_trade_pct: draft.risk,
      });
      setStrategyAccounts((prev) => prev.map((a) => (a.strategy_id === strategyId ? updated : a)));
      setStrategyAccountMessage(`${strategyName(strategyId)}'s dedicated account saved.`);
    } catch (err) {
      setStrategyAccountMessage(err instanceof Error ? err.message : "Failed to save dedicated account");
    } finally {
      setSavingStrategyAccount(null);
    }
  }

  async function handleResetStrategyAccount(strategyId: string) {
    const confirmed = window.confirm(
      `Reset ${strategyName(strategyId)}'s dedicated account balance back to its starting balance? This doesn't undo any positions.`,
    );
    if (!confirmed) return;
    setResettingStrategyAccount(strategyId);
    setStrategyAccountMessage(null);
    try {
      const updated = await resetStrategyAccount(strategyId);
      setStrategyAccounts((prev) => prev.map((a) => (a.strategy_id === strategyId ? updated : a)));
      setStrategyAccountMessage(`${strategyName(strategyId)}'s dedicated account balance reset.`);
    } catch (err) {
      setStrategyAccountMessage(err instanceof Error ? err.message : "Failed to reset dedicated account");
    } finally {
      setResettingStrategyAccount(null);
    }
  }

  async function handleDeleteStrategyAccount(strategyId: string) {
    const confirmed = window.confirm(
      `Remove ${strategyName(strategyId)}'s dedicated account? It goes back to sharing its segment's account. ` +
        "Already-open positions/orders are unaffected.",
    );
    if (!confirmed) return;
    setDeletingStrategyAccount(strategyId);
    setStrategyAccountMessage(null);
    try {
      await deleteStrategyAccount(strategyId);
      setStrategyAccounts((prev) => prev.filter((a) => a.strategy_id !== strategyId));
      setStrategyAccountMessage(`${strategyName(strategyId)}'s dedicated account removed.`);
    } catch (err) {
      setStrategyAccountMessage(err instanceof Error ? err.message : "Failed to remove dedicated account");
    } finally {
      setDeletingStrategyAccount(null);
    }
  }

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

  async function handleSavePlatform(segment: Account["segment"]) {
    const draft = platformDrafts[segment];
    if (!draft || draft.leverage === "") return;
    setSavingPlatform(segment);
    setPlatformMessage(null);
    try {
      const updated = await updatePlatformAccount(segment, {
        leverage: draft.leverage,
        mtf_annual_interest_rate_pct: draft.mtfInterestRate === "" ? null : draft.mtfInterestRate,
      });
      setPlatformAccounts((prev) => prev.map((a) => (a.segment === segment ? updated : a)));
      setPlatformMessage(`Platform ${segment} account saved.`);
    } catch (err) {
      setPlatformMessage(err instanceof Error ? err.message : `Failed to save platform ${segment} account`);
    } finally {
      setSavingPlatform(null);
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
            autoComplete="off"
            placeholder="Dhan client ID"
            value={dhanClientIdDraft}
            onChange={(e) => setDhanClientIdDraft(e.target.value)}
          />
        </label>
        <label>
          Access token
          <input
            type="password"
            autoComplete="new-password"
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
        <button type="button" className="secondary tiny" onClick={handleRenewDhanToken} disabled={renewingDhan}>
          {renewingDhan ? "Renewing..." : "Renew token"}
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

      <h2>Live feed</h2>
      {feedStatus ? (
        <p className="subtitle">
          {feedStatus.connected ? "Connected" : "Not connected"}
          {feedStatus.last_message_at ? ` · last tick ${feedStatus.last_message_at}` : ""}
          {feedStatus.reconnect_count > 0 ? ` · reconnected ${feedStatus.reconnect_count}x` : ""}
          {feedStatus.last_error ? ` · last error: ${feedStatus.last_error}` : ""}
        </p>
      ) : (
        <p className="subtitle">Could not reach market-data to check the feed status.</p>
      )}
      <div className="settings-row">
        <label>
          Exchange
          <select value={feedExchangeDraft} onChange={(e) => setFeedExchangeDraft(e.target.value)}>
            {/* Dhan-only feed (see app/providers/dhan_feed.py) - no CRYPTO here, unlike SEGMENTS elsewhere on this page. */}
            <option value="NSE">NSE</option>
            <option value="MCX">MCX</option>
          </select>
        </label>
        <label>
          Symbol
          <input type="text" placeholder="e.g. RELIANCE" value={feedSymbolDraft} onChange={(e) => setFeedSymbolDraft(e.target.value)} />
        </label>
        <button type="button" className="secondary tiny" onClick={handleSubscribeFeed} disabled={subscribingFeed || !feedSymbolDraft.trim()}>
          {subscribingFeed ? "Subscribing..." : "Subscribe"}
        </button>
      </div>
      {feedMessage && <p className="action-message">{feedMessage}</p>}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Segment</th>
              <th>Balance</th>
              <th>Capital per trade (&#8377;)</th>
              <th>Risk per trade (%)</th>
              <th>Leverage (CRYPTO)</th>
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

      <h2>Platform account (admin)</h2>
      <p className="subtitle">
        The platform-wide account the automated Strategy-driven flow actually sizes/holds against - separate from
        this admin's own personal account above. Leverage/MTF interest configured here is broker/platform config,
        not a per-SaaS-user setting - a Strategy opts in via its own <code>use_margin</code> field
        (signal-generation) before this leverage ever applies to one of its orders.
      </p>
      {platformError && <p className="error">Could not reach the backend: {platformError}</p>}
      {platformMessage && <p className="action-message">{platformMessage}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Segment</th>
              <th>Leverage</th>
              <th>MTF interest %/yr (NSE)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((segment) => {
              const account = platformAccounts.find((a) => a.segment === segment);
              const draft = platformDrafts[segment] ?? { leverage: "", mtfInterestRate: "" };
              return (
                <tr key={segment}>
                  <td className="symbol">{segment}</td>
                  <td>
                    {segment === "CRYPTO" ? (
                      <select
                        value={draft.leverage}
                        onChange={(e) =>
                          setPlatformDrafts((prev) => ({
                            ...prev,
                            [segment]: { ...draft, leverage: e.target.value === "" ? "" : Number(e.target.value) },
                          }))
                        }
                      >
                        {LEVERAGE_OPTIONS.map((lev) => (
                          <option key={lev} value={lev}>
                            {lev}x
                          </option>
                        ))}
                      </select>
                    ) : segment === "NSE" ? (
                      <input
                        type="number"
                        min="1"
                        step="0.1"
                        title="Dhan MTF (margin trading facility) - only applies to a positional order from a Strategy with use_margin=true, never intraday or a Manual tab order."
                        value={draft.leverage}
                        onChange={(e) =>
                          setPlatformDrafts((prev) => ({
                            ...prev,
                            [segment]: { ...draft, leverage: e.target.value === "" ? "" : Number(e.target.value) },
                          }))
                        }
                      />
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    {segment === "NSE" ? (
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        placeholder="e.g. 18"
                        title="Required before a positional use_margin order can use leverage > 1 above."
                        value={draft.mtfInterestRate}
                        onChange={(e) =>
                          setPlatformDrafts((prev) => ({
                            ...prev,
                            [segment]: { ...draft, mtfInterestRate: e.target.value === "" ? "" : Number(e.target.value) },
                          }))
                        }
                      />
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="tiny"
                      onClick={() => handleSavePlatform(segment)}
                      disabled={savingPlatform === segment || !account}
                    >
                      {savingPlatform === segment ? "Saving..." : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Dedicated strategy accounts</h2>
      <p className="subtitle">
        Optional - a strategy with its own account here sizes/tracks P&amp;L against it instead of sharing its
        segment's account above. Every strategy without one keeps sharing the segment account as before.
      </p>

      {strategyAccountError && <p className="error">Could not reach the backend: {strategyAccountError}</p>}
      {strategyAccountMessage && <p className="action-message">{strategyAccountMessage}</p>}

      <div className="settings-row">
        <label>
          Strategy
          <select value={newStrategyId} onChange={(e) => setNewStrategyId(e.target.value)}>
            <option value="">&mdash; select &mdash;</option>
            {strategies
              .filter((s) => !strategyAccounts.some((a) => a.strategy_id === s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.segment})
                </option>
              ))}
          </select>
        </label>
        <label>
          Starting balance (&#8377;)
          <input
            type="number"
            min="1"
            step="1"
            value={newStartingBalance}
            onChange={(e) => setNewStartingBalance(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
        <label>
          Capital per trade (&#8377;)
          <input
            type="number"
            min="1"
            step="1"
            value={newCapitalPerTrade}
            onChange={(e) => setNewCapitalPerTrade(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
        <label>
          Risk per trade (%)
          <input
            type="number"
            min="0.01"
            max="100"
            step="0.1"
            value={newRiskPerTrade}
            onChange={(e) => setNewRiskPerTrade(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="secondary tiny"
          onClick={handleCreateStrategyAccount}
          disabled={
            creatingStrategyAccount ||
            !newStrategyId ||
            newStartingBalance === "" ||
            newCapitalPerTrade === "" ||
            newRiskPerTrade === ""
          }
        >
          {creatingStrategyAccount ? "Creating..." : "Create"}
        </button>
      </div>

      {strategyAccounts.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Segment</th>
                <th>Balance</th>
                <th>Capital per trade (&#8377;)</th>
                <th>Risk per trade (%)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {strategyAccounts.map((account) => {
                const draft = strategyDrafts[account.strategy_id] ?? { capital: "", risk: "" };
                const delta = account.current_balance - account.starting_balance;
                return (
                  <tr key={account.strategy_id}>
                    <td className="symbol">{strategyName(account.strategy_id)}</td>
                    <td>{account.segment}</td>
                    <td className={`num ${delta >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                      {account.current_balance.toFixed(2)}
                      {formatPct((delta / account.starting_balance) * 100)}
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={draft.capital}
                        onChange={(e) =>
                          setStrategyDrafts((prev) => ({
                            ...prev,
                            [account.strategy_id]: { ...draft, capital: e.target.value === "" ? "" : Number(e.target.value) },
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
                          setStrategyDrafts((prev) => ({
                            ...prev,
                            [account.strategy_id]: { ...draft, risk: e.target.value === "" ? "" : Number(e.target.value) },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="tiny"
                        onClick={() => handleSaveStrategyAccount(account.strategy_id)}
                        disabled={savingStrategyAccount === account.strategy_id}
                      >
                        {savingStrategyAccount === account.strategy_id ? "Saving..." : "Save"}
                      </button>{" "}
                      <button
                        type="button"
                        className="secondary tiny"
                        onClick={() => handleResetStrategyAccount(account.strategy_id)}
                        disabled={resettingStrategyAccount === account.strategy_id}
                      >
                        {resettingStrategyAccount === account.strategy_id ? "Resetting..." : "Reset balance"}
                      </button>{" "}
                      <button
                        type="button"
                        className="secondary tiny"
                        onClick={() => handleDeleteStrategyAccount(account.strategy_id)}
                        disabled={deletingStrategyAccount === account.strategy_id}
                      >
                        {deletingStrategyAccount === account.strategy_id ? "Removing..." : "Remove"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
