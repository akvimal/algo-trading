import { useEffect, useState } from "react";

import { type Account, type Segment, type Settings, fetchAccounts, fetchSettings, resetAccount, updateAccount, updateSettings } from "./api";
import { RotateCcwIcon } from "./Icons";

const ALL_SEGMENTS: Segment[] = ["NSE", "MCX", "CRYPTO"];

// Whole numbers (the common case here - capital/trade and risk amount
// are almost always round configured/computed figures) show with no
// decimals; only a genuinely fractional value (real paise from a
// compounding balance) keeps its 2 decimals. `locale` defaults to Indian
// digit grouping (10,00,000 not 1,000,000) to match every other
// INR-denominated figure in this app - callers pass "en-US" for CRYPTO's
// USD balances.
function fmt(n: number, locale = "en-IN"): string {
  const hasFraction = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString(locale, hasFraction ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 });
}

// Intraday > Risk & Accounts - per-segment capital/risk/leverage/
// square-off (execution.accounts) plus the USD/INR rate (execution.
// settings) - split out of the old combined "Checklist & Risk Settings"
// page (see docs/architecture.md § "Manual Trading SaaS") since Phase 5
// piled all of this on top of what used to be just Risk% + the checklist
// editor.
export default function RiskAccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [draftRisk, setDraftRisk] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [draftRR, setDraftRR] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  // Spot/future only (see Account.enforce_risk_based_lots's own comment)
  // - when on, WorkspacePage.tsx auto-computes and locks that segment's
  // Lot field from Risk/trade % instead of leaving it free-typed.
  const [draftEnforceLots, setDraftEnforceLots] = useState<Record<Segment, boolean>>({ NSE: false, MCX: false, CRYPTO: false });
  // draftSquareOffTime holds an <input type="time"> value ("HH:MM")
  // reconciled to/from the backend's "HH:MM:SS"/null.
  const [draftCapital, setDraftCapital] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  // CRYPTO only - see Account.leverage's own comment (NSE's own leverage/
  // MTF interest is admin/broker-config only now, execution/frontend's
  // AccountsPage "Platform account (admin)" section, not here).
  const [draftLeverage, setDraftLeverage] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [draftSquareOffTime, setDraftSquareOffTime] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [draftNeverSquareOff, setDraftNeverSquareOff] = useState<Record<Segment, boolean>>({ NSE: false, MCX: false, CRYPTO: false });
  const [savingSegment, setSavingSegment] = useState<Segment | null>(null);
  const [justSavedSegment, setJustSavedSegment] = useState<Segment | null>(null);
  const [resettingSegment, setResettingSegment] = useState<Segment | null>(null);

  // USD/INR rate (CRYPTO sizing only).
  const [settings, setSettings] = useState<Settings | null>(null);
  const [usdinrDraft, setUsdinrDraft] = useState("");
  const [savingUsdinr, setSavingUsdinr] = useState(false);
  const [usdinrMessage, setUsdinrMessage] = useState<string | null>(null);

  useEffect(() => {
    void refreshAccounts();
    fetchSettings()
      .then((s) => {
        setSettings(s);
        setUsdinrDraft(s.usdinr_rate != null ? String(s.usdinr_rate) : "");
      })
      .catch(() => {
        // Non-CRYPTO users have no reason to care - this section just
        // shows its own "couldn't load" state below.
      });
  }, []);

  async function handleSaveUsdinr() {
    const usdinr_rate = Number(usdinrDraft);
    if (!Number.isFinite(usdinr_rate) || usdinr_rate <= 0) {
      setUsdinrMessage("USD/INR rate must be greater than 0");
      return;
    }
    setSavingUsdinr(true);
    setUsdinrMessage(null);
    try {
      const updated = await updateSettings({ usdinr_rate });
      setSettings(updated);
      setUsdinrMessage("Saved.");
    } catch (err) {
      setUsdinrMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingUsdinr(false);
    }
  }

  async function refreshAccounts() {
    try {
      const data = await fetchAccounts();
      setAccounts(data);
      setDraftRisk((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.risk_per_trade_pct);
        return next;
      });
      setDraftRR((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.min_reward_risk_ratio);
        return next;
      });
      setDraftEnforceLots((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.enforce_risk_based_lots;
        return next;
      });
      setDraftCapital((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.capital_per_trade);
        return next;
      });
      setDraftLeverage((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.leverage);
        return next;
      });
      setDraftSquareOffTime((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.square_off_time ? a.square_off_time.slice(0, 5) : "";
        return next;
      });
      setDraftNeverSquareOff((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.square_off_time == null;
        return next;
      });
      setAccountsError(null);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSegmentRisk(segment: Segment) {
    const risk_per_trade_pct = Number(draftRisk[segment]);
    const min_reward_risk_ratio = Number(draftRR[segment]);
    const capital_per_trade = Number(draftCapital[segment]);
    if (!Number.isFinite(risk_per_trade_pct) || risk_per_trade_pct <= 0 || risk_per_trade_pct > 100) {
      setAccountsError(`${segment}: Risk/trade must be between 0 and 100`);
      return;
    }
    if (!Number.isFinite(min_reward_risk_ratio) || min_reward_risk_ratio <= 0) {
      setAccountsError(`${segment}: Min reward:risk must be greater than 0`);
      return;
    }
    if (!Number.isFinite(capital_per_trade) || capital_per_trade <= 0) {
      setAccountsError(`${segment}: Capital/trade must be greater than 0`);
      return;
    }
    let leverage: number | undefined;
    if (segment === "CRYPTO") {
      leverage = Number(draftLeverage[segment]);
      if (!Number.isFinite(leverage) || leverage <= 0) {
        setAccountsError(`${segment}: Leverage must be greater than 0`);
        return;
      }
    }
    const square_off_time = draftNeverSquareOff[segment] || !draftSquareOffTime[segment] ? null : `${draftSquareOffTime[segment]}:00`;
    setSavingSegment(segment);
    try {
      await updateAccount(segment, {
        risk_per_trade_pct,
        min_reward_risk_ratio,
        enforce_risk_based_lots: draftEnforceLots[segment],
        capital_per_trade,
        ...(leverage !== undefined ? { leverage } : {}),
        square_off_time,
      });
      await refreshAccounts();
      setJustSavedSegment(segment);
      setTimeout(() => setJustSavedSegment((s) => (s === segment ? null : s)), 2500);
      setAccountsError(null);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSegment(null);
    }
  }

  async function resetSegmentBalance(segment: Segment) {
    const confirmed = window.confirm(
      `Reset the ${segment} account's balance back to its starting balance? This doesn't undo any positions.`,
    );
    if (!confirmed) return;
    setResettingSegment(segment);
    try {
      await resetAccount(segment);
      await refreshAccounts();
      setAccountsError(null);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : String(err));
    } finally {
      setResettingSegment(null);
    }
  }

  return (
    <div className="manual-settings-page">
      <div className="manual-page-header">
        <h3>Risk & Accounts</h3>
      </div>

      <section className="manual-settings-section">
        <h4>Risk per trade / segment</h4>
        {accountsError && <p className="error">{accountsError}</p>}
        <div className="manual-risk-grid">
          {ALL_SEGMENTS.map((seg) => {
            const account = accounts.find((a) => a.segment === seg);
            const currency = seg === "CRYPTO" ? "$" : "₹";
            const locale = seg === "CRYPTO" ? "en-US" : "en-IN";
            const draftRiskPct = Number(draftRisk[seg]);
            const riskAmount =
              account && Number.isFinite(draftRiskPct) ? (account.capital_per_trade * draftRiskPct) / 100 : null;
            return (
              <div className="manual-risk-card" key={seg}>
                <span className="manual-risk-card-title">{seg}</span>
                {account && (
                  <span className="manual-risk-card-capital">
                    Capital {currency}
                    {fmt(account.capital_per_trade, locale)} &middot; Bal {currency}
                    {fmt(account.current_balance, locale)}
                    {riskAmount != null && (
                      <>
                        {" "}
                        &middot; Risk{" "}
                        <strong>
                          {currency}
                          {fmt(riskAmount, locale)}
                        </strong>
                      </>
                    )}
                  </span>
                )}
                <label title="Caps a manual order's size - risk-based sizing, used whenever Lots isn't set explicitly.">
                  Risk/trade %
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={draftRisk[seg]}
                    disabled={!account}
                    onChange={(e) => setDraftRisk((prev) => ({ ...prev, [seg]: e.target.value }))}
                  />
                </label>
                <label title="The RR floor the Manual tab's Add/Update button enforces on Limit (or live LTP)/Target/SL Limit.">
                  Min reward:risk (1:x)
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={draftRR[seg]}
                    disabled={!account}
                    onChange={(e) => setDraftRR((prev) => ({ ...prev, [seg]: e.target.value }))}
                  />
                </label>
                <label title="Total capital allocated to a single trade in this segment - what Risk/trade % above is computed against.">
                  Capital/trade
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={draftCapital[seg]}
                    disabled={!account}
                    onChange={(e) => setDraftCapital((prev) => ({ ...prev, [seg]: e.target.value }))}
                  />
                </label>
                {seg === "CRYPTO" && (
                  <label title="Margin multiplier applied before sizing (Delta Exchange India trades perpetual futures on margin).">
                    Leverage
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={draftLeverage[seg]}
                      disabled={!account}
                      onChange={(e) => setDraftLeverage((prev) => ({ ...prev, [seg]: e.target.value }))}
                    />
                  </label>
                )}
                <label title="Any OPEN intraday position in this segment still open past this local time gets forcefully closed.">
                  Square-off time
                  <input
                    type="time"
                    value={draftSquareOffTime[seg]}
                    disabled={!account || draftNeverSquareOff[seg]}
                    onChange={(e) => setDraftSquareOffTime((prev) => ({ ...prev, [seg]: e.target.value }))}
                  />
                </label>
                <label className="checkbox-label tiny manual-risk-card-checkbox" title="Never force-close - a position in this segment stays open past any time of day (e.g. CRYPTO, which trades 24/7).">
                  <input
                    type="checkbox"
                    checked={draftNeverSquareOff[seg]}
                    disabled={!account}
                    onChange={(e) => setDraftNeverSquareOff((prev) => ({ ...prev, [seg]: e.target.checked }))}
                  />
                  Never force-close
                </label>
                <label className="checkbox-label tiny manual-risk-card-checkbox" title="Auto-computes and locks the Lot field from Risk/trade % once a stop-loss is set (spot/future: spot SL Limit; option: the option row's own Premium SL, against its ATM leg's live premium), instead of leaving it free-typed.">
                  <input
                    type="checkbox"
                    checked={draftEnforceLots[seg]}
                    disabled={!account}
                    onChange={(e) => setDraftEnforceLots((prev) => ({ ...prev, [seg]: e.target.checked }))}
                  />
                  Enforce risk-based Lot
                </label>
                <span className="edit-actions">
                  <button type="button" className="tiny" disabled={!account || savingSegment === seg} onClick={() => void saveSegmentRisk(seg)}>
                    {savingSegment === seg ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn secondary"
                    disabled={!account || resettingSegment === seg}
                    onClick={() => void resetSegmentBalance(seg)}
                    title={resettingSegment === seg ? "Resetting..." : `Reset ${seg} balance to its starting balance`}
                    aria-label="Reset balance"
                  >
                    <RotateCcwIcon />
                  </button>
                </span>
                {justSavedSegment === seg && <span className="manual-saved-badge">Saved</span>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="manual-settings-section">
        <h4>USD/INR rate</h4>
        <p className="subtitle">Manually configured - converts CRYPTO capital/balance into USD-equivalent before sizing a position.</p>
        <div className="strategy-form">
          <label>
            Rate
            <input type="number" min="0" step="0.01" value={usdinrDraft} onChange={(e) => setUsdinrDraft(e.target.value)} />
          </label>
          <button type="button" className="tiny" disabled={savingUsdinr || !usdinrDraft} onClick={() => void handleSaveUsdinr()}>
            {savingUsdinr ? "Saving..." : "Save"}
          </button>
        </div>
        {usdinrMessage && <p className="manual-saved-badge">{usdinrMessage}</p>}
        {settings == null && <p className="error">Could not load settings.</p>}
      </section>
    </div>
  );
}
