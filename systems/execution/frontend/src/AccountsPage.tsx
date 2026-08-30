import { useEffect, useState } from "react";

import {
  type Account,
  type LiveTradingStatus,
  type StrategyAccount,
  type StrategySummary,
  createStrategyAccount,
  deleteStrategyAccount,
  fetchLiveTradingStatus,
  fetchPlatformAccounts,
  fetchStrategyAccounts,
  fetchStrategyNames,
  resetStrategyAccount,
  updatePlatformAccount,
  updateStrategyAccount,
} from "./api";
import { getAuthIsAdmin } from "./auth";
import { CheckIcon, RotateCcwIcon, TrashIcon } from "./Icons";
import { InfoDisclosure } from "./InfoDisclosure";
import { SEGMENTS, formatPct } from "./format";

const POLL_INTERVAL_MS = 5000;
const LEVERAGE_OPTIONS = [1, 10, 25, 50, 100, 150, 200];

export default function AccountsPage() {
  // See PositionsPage.tsx's own isAdmin comment - gates the platform-wide
  // fetch/section below the same way, fixed alongside it 2026-08-29
  // (fetchPlatformAccounts' own comment had the same now-stale "no
  // separate admin check is needed here" assumption from execution/
  // frontend's old admin-only era).
  const isAdmin = getAuthIsAdmin();
  // Platform-wide (user_id IS NULL) accounts - the rows the automated
  // Strategy-driven flow actually reads (see api.ts's own comment on
  // fetchPlatformAccounts). This admin/ops-only concept, plus dedicated
  // strategy accounts below, is the only account data left on this page -
  // a caller's own personal capital/risk/leverage/square-off account and
  // the USDINR rate moved to Manual Trading's own "Risk & Accounts" page
  // (both hit the exact same execution.accounts/execution.settings rows,
  // and that page's own UI - risk %, min reward:risk, enforce-lots - was
  // already the richer, actual product-facing one; this page having a
  // second, thinner copy of the same settings was pure redundancy once
  // this whole app opened up to every logged-in user, not just admins).
  const [platformAccounts, setPlatformAccounts] = useState<Account[]>([]);
  const [platformDrafts, setPlatformDrafts] = useState<
    Record<string, { leverage: number | ""; mtfInterestRate: number | ""; squareOffTime: string }>
  >({});
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [savingPlatform, setSavingPlatform] = useState<string | null>(null);
  const [platformMessage, setPlatformMessage] = useState<string | null>(null);

  // Optional per-strategy dedicated accounts (execution.strategy_accounts) -
  // strategies list comes from signal-generation directly (same
  // cross-system CORS pattern PositionsPage already uses for the same
  // data), so the picker/segment auto-fill below work without execution
  // owning a copy of Strategy names.
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [strategyAccounts, setStrategyAccounts] = useState<StrategyAccount[]>([]);
  const [strategyAccountError, setStrategyAccountError] = useState<string | null>(null);
  const [strategyAccountMessage, setStrategyAccountMessage] = useState<string | null>(null);
  const [strategyDrafts, setStrategyDrafts] = useState<
    Record<
      string,
      {
        capital: number | "";
        risk: number | "";
        liveUserId: string;
        liveEnabled: boolean;
        maxOrderValue: number | "";
        maxDailyLoss: number | "";
      }
    >
  >({});
  const [savingStrategyAccount, setSavingStrategyAccount] = useState<string | null>(null);
  const [resettingStrategyAccount, setResettingStrategyAccount] = useState<string | null>(null);
  const [deletingStrategyAccount, setDeletingStrategyAccount] = useState<string | null>(null);

  // Live-broker-adapter status-check helper (see docs/architecture.md) -
  // GET /live-trading/status, admin-only.
  const [liveStatus, setLiveStatus] = useState<LiveTradingStatus | null>(null);
  const [liveStatusError, setLiveStatusError] = useState<string | null>(null);

  const [newStrategyId, setNewStrategyId] = useState("");
  const [newStartingBalance, setNewStartingBalance] = useState<number | "">(200000);
  const [newCapitalPerTrade, setNewCapitalPerTrade] = useState<number | "">(50000);
  const [newRiskPerTrade, setNewRiskPerTrade] = useState<number | "">(1);
  const [creatingStrategyAccount, setCreatingStrategyAccount] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
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
              next[a.segment] = {
                leverage: a.leverage,
                mtfInterestRate: a.mtf_annual_interest_rate_pct ?? "",
                squareOffTime: a.square_off_time ? a.square_off_time.slice(0, 5) : "",
              };
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
            if (!(a.strategy_id in next))
              next[a.strategy_id] = {
                capital: a.capital_per_trade,
                risk: a.risk_per_trade_pct,
                liveUserId: a.live_trading_user_id ?? "",
                liveEnabled: a.live_trading_enabled,
                maxOrderValue: a.max_order_value ?? "",
                maxDailyLoss: a.max_daily_loss ?? "",
              };
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

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchLiveTradingStatus();
        if (!cancelled) {
          setLiveStatus(data);
          setLiveStatusError(null);
        }
      } catch (err) {
        if (!cancelled) setLiveStatusError(err instanceof Error ? err.message : "Failed to load live-trading status");
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
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

    const existing = strategyAccounts.find((a) => a.strategy_id === strategyId);
    const turningLiveOn = draft.liveEnabled && !(existing?.live_trading_enabled ?? false);
    if (turningLiveOn) {
      const confirmed = window.confirm(
        `Turn ON real order placement for ${strategyName(strategyId)}?\n\n` +
          "Every signal this strategy generates from now on will place a REAL order on Dhan, using the named " +
          "live_trading_user_id's own saved credentials - fully unattended, with no review step. Make sure the " +
          "platform-wide kill switch is off and this is really what you want before confirming.",
      );
      if (!confirmed) return;
    }

    setSavingStrategyAccount(strategyId);
    setStrategyAccountMessage(null);
    try {
      const updated = await updateStrategyAccount(strategyId, {
        capital_per_trade: draft.capital,
        risk_per_trade_pct: draft.risk,
        live_trading_user_id: draft.liveUserId.trim() === "" ? null : draft.liveUserId.trim(),
        live_trading_enabled: draft.liveEnabled,
        max_order_value: draft.maxOrderValue === "" ? null : draft.maxOrderValue,
        max_daily_loss: draft.maxDailyLoss === "" ? null : draft.maxDailyLoss,
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

  async function handleSavePlatform(segment: Account["segment"]) {
    const draft = platformDrafts[segment];
    if (!draft || draft.leverage === "") return;
    setSavingPlatform(segment);
    setPlatformMessage(null);
    try {
      const updated = await updatePlatformAccount(segment, {
        leverage: draft.leverage,
        mtf_annual_interest_rate_pct: draft.mtfInterestRate === "" ? null : draft.mtfInterestRate,
        square_off_time: draft.squareOffTime ? `${draft.squareOffTime}:00` : null,
      });
      setPlatformAccounts((prev) => prev.map((a) => (a.segment === segment ? updated : a)));
      setPlatformMessage(`Platform ${segment} account saved.`);
    } catch (err) {
      setPlatformMessage(err instanceof Error ? err.message : `Failed to save platform ${segment} account`);
    } finally {
      setSavingPlatform(null);
    }
  }

  return (
    <>
      <p className="subtitle">
        Platform/admin account config - your own capital, risk, leverage, square-off, and USD/INR rate now live in
        Manual Trading &rsaquo; Intraday &rsaquo; Risk &amp; Accounts (one place for every logged-in user's own
        settings, instead of a second copy here).
      </p>

      {isAdmin && (
      <>
      <h2>Platform account (admin)</h2>
      <p className="subtitle">The account the automated Strategy-driven flow itself sizes/holds against.</p>
      <InfoDisclosure summary="How square-off and leverage apply here">
        <p>
          Separate from your own personal account above, and edited here since it belongs to no single SaaS user.
        </p>
        <p>
          <strong>Square-off</strong>: a webhook (e.g. Chartink) or in-house signal is checked against THIS row's
          cutoff, not the personal account's own square-off time above - a signal received after it is rejected
          with "received outside intraday window".
        </p>
        <p>
          Leverage/MTF interest here is broker/platform config too - a Strategy opts in via its own{" "}
          <code>use_margin</code> field (signal-generation) before this leverage ever applies to one of its orders.
        </p>
      </InfoDisclosure>
      {platformError && <p className="error">Could not reach the backend: {platformError}</p>}
      {platformMessage && <p className="action-message">{platformMessage}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Segment</th>
              <th>Leverage</th>
              <th>MTF interest %/yr (NSE)</th>
              <th>Square-off (blank = never)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((segment) => {
              const account = platformAccounts.find((a) => a.segment === segment);
              const draft = platformDrafts[segment] ?? { leverage: "", mtfInterestRate: "", squareOffTime: "" };
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
                        title="Dhan MTF (margin trading facility) for a positional order from a Strategy with use_margin=true, OR intraday MIS margin for any NSE spot order (Strategy-driven or Manual tab) - same leverage value drives both, no interest is ever charged on the intraday side."
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
                    <input
                      type="time"
                      title="The automated Strategy-driven flow (webhooks, in-house engine) always sizes/holds against THIS account, not any admin's own personal one above - this is the square-off cutoff a Chartink/in-house signal actually gets checked against."
                      value={draft.squareOffTime}
                      onChange={(e) =>
                        setPlatformDrafts((prev) => ({
                          ...prev,
                          [segment]: { ...draft, squareOffTime: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleSavePlatform(segment)}
                      disabled={savingPlatform === segment || !account}
                      title={savingPlatform === segment ? "Saving..." : "Save"}
                      aria-label="Save"
                    >
                      <CheckIcon />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Live trading status</h2>
      <p className="subtitle">
        Is X actually live right now, and if not, why not - a read-only view, never places an order. See
        docs/architecture.md's live-broker-adapter plan.
      </p>
      {liveStatusError && <p className="error">Could not reach the backend: {liveStatusError}</p>}
      {liveStatus && (
        <>
          <p>
            Platform kill switch:{" "}
            {liveStatus.kill_switch ? (
              <span className="badge badge-sell">ON - blocks every real order</span>
            ) : (
              <span className="badge badge-buy">off</span>
            )}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Owner</th>
                  <th>Segment</th>
                  <th>Live?</th>
                  <th>Today's realized P&amp;L</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {liveStatus.accounts
                  .filter((a) => a.live_trading_enabled)
                  .map((a) => (
                    <tr key={`account-${a.user_id ?? "platform"}-${a.segment}`}>
                      <td className="symbol">{a.user_id ?? "platform"}</td>
                      <td>{a.segment}</td>
                      <td>{a.effectively_live ? <span className="badge badge-live">LIVE</span> : "no"}</td>
                      <td className={a.today_realized_pnl != null && a.today_realized_pnl < 0 ? "pnl-negative" : "pnl-positive"}>
                        {a.today_realized_pnl != null ? a.today_realized_pnl.toFixed(2) : "-"}
                      </td>
                      <td>{a.reason ?? "actually live"}</td>
                    </tr>
                  ))}
                {liveStatus.strategy_accounts
                  .filter((a) => a.live_trading_enabled)
                  .map((a) => (
                    <tr key={`strategy-${a.strategy_id}`}>
                      <td className="symbol">{strategyName(a.strategy_id)}</td>
                      <td>{a.segment}</td>
                      <td>{a.effectively_live ? <span className="badge badge-live">LIVE</span> : "no"}</td>
                      <td className={a.today_realized_pnl != null && a.today_realized_pnl < 0 ? "pnl-negative" : "pnl-positive"}>
                        {a.today_realized_pnl != null ? a.today_realized_pnl.toFixed(2) : "-"}
                      </td>
                      <td>{a.reason ?? "actually live"}</td>
                    </tr>
                  ))}
                {liveStatus.accounts.every((a) => !a.live_trading_enabled) &&
                  liveStatus.strategy_accounts.every((a) => !a.live_trading_enabled) && (
                    <tr>
                      <td colSpan={5}>Nothing has live trading enabled - everything is paper-only right now.</td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
        </>
      )}
      </>
      )}

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
                <th title="Real order placement - see docs/architecture.md's live-broker-adapter plan. Only NSE/MCX can ever go live.">
                  Live?
                </th>
                <th title="Whose own saved Dhan credentials execute this strategy's real orders">Live user id</th>
                <th title="Optional caps, only meaningful once Live? is on">Max order &#8377; / Max daily loss &#8377;</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {strategyAccounts.map((account) => {
                const draft =
                  strategyDrafts[account.strategy_id] ??
                  { capital: "", risk: "", liveUserId: "", liveEnabled: false, maxOrderValue: "", maxDailyLoss: "" };
                const canGoLive = account.segment !== "CRYPTO";
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
                      {canGoLive ? (
                        <>
                          <input
                            type="checkbox"
                            checked={draft.liveEnabled}
                            onChange={(e) =>
                              setStrategyDrafts((prev) => ({
                                ...prev,
                                [account.strategy_id]: { ...draft, liveEnabled: e.target.checked },
                              }))
                            }
                          />
                          {account.live_trading_enabled && <span className="badge badge-live">LIVE</span>}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>
                      {canGoLive ? (
                        <input
                          type="text"
                          placeholder="user id"
                          value={draft.liveUserId}
                          onChange={(e) =>
                            setStrategyDrafts((prev) => ({
                              ...prev,
                              [account.strategy_id]: { ...draft, liveUserId: e.target.value },
                            }))
                          }
                        />
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>
                      {canGoLive ? (
                        <span className="settings-row">
                          <input
                            type="number"
                            min="1"
                            step="1"
                            placeholder="no cap"
                            value={draft.maxOrderValue}
                            onChange={(e) =>
                              setStrategyDrafts((prev) => ({
                                ...prev,
                                [account.strategy_id]: { ...draft, maxOrderValue: e.target.value === "" ? "" : Number(e.target.value) },
                              }))
                            }
                          />
                          <input
                            type="number"
                            min="1"
                            step="1"
                            placeholder="no cap"
                            value={draft.maxDailyLoss}
                            onChange={(e) =>
                              setStrategyDrafts((prev) => ({
                                ...prev,
                                [account.strategy_id]: { ...draft, maxDailyLoss: e.target.value === "" ? "" : Number(e.target.value) },
                              }))
                            }
                          />
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="edit-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => handleSaveStrategyAccount(account.strategy_id)}
                        disabled={savingStrategyAccount === account.strategy_id}
                        title={savingStrategyAccount === account.strategy_id ? "Saving..." : "Save"}
                        aria-label="Save"
                      >
                        <CheckIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-btn secondary"
                        onClick={() => handleResetStrategyAccount(account.strategy_id)}
                        disabled={resettingStrategyAccount === account.strategy_id}
                        title={
                          resettingStrategyAccount === account.strategy_id
                            ? "Resetting..."
                            : `Reset ${strategyName(account.strategy_id)}'s balance to its starting balance`
                        }
                        aria-label="Reset balance"
                      >
                        <RotateCcwIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        onClick={() => handleDeleteStrategyAccount(account.strategy_id)}
                        disabled={deletingStrategyAccount === account.strategy_id}
                        title={
                          deletingStrategyAccount === account.strategy_id
                            ? "Removing..."
                            : `Remove ${strategyName(account.strategy_id)}'s dedicated account`
                        }
                        aria-label="Remove dedicated account"
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
