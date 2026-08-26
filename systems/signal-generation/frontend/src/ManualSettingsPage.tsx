import { useEffect, useState } from "react";

import {
  type Account,
  type ChecklistItem,
  type ChecklistPhase,
  type Segment,
  createChecklistItem,
  deleteChecklistItem,
  fetchAccounts,
  updateAccount,
  updateChecklistItem,
} from "./api";

const ALL_SEGMENTS: Segment[] = ["NSE", "MCX", "CRYPTO"];

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type ManualSettingsPageProps = {
  checklistItems: ChecklistItem[];
  planItems: ChecklistItem[];
  dayItems: ChecklistItem[];
  reviewItems: ChecklistItem[];
  refreshChecklistItems: () => Promise<void>;
  onBack: () => void;
};

// The Manual tab's own settings sub-page - trade discipline checklist items
// (execution.checklist_items) plus the two per-segment risk knobs that
// already lived on execution.accounts (risk_per_trade_pct) or were only a
// hardcoded frontend constant until now (min_reward_risk_ratio), gathered
// here so they're editable without leaving signal-generation or jumping to
// execution's own AccountsPage. checklistItems/planItems/dayItems/
// reviewItems/refreshChecklistItems are owned by ManualTab (its trading
// view reads the same data for the per-row plan checklist and the daily
// checklist boxes) and passed down rather than re-fetched here.
export default function ManualSettingsPage({
  checklistItems,
  planItems,
  dayItems,
  reviewItems,
  refreshChecklistItems,
  onBack,
}: ManualSettingsPageProps) {
  const [newChecklistLabel, setNewChecklistLabel] = useState("");
  const [newChecklistPhase, setNewChecklistPhase] = useState<ChecklistPhase>("plan");
  const [newChecklistSegments, setNewChecklistSegments] = useState<Segment[]>([]);
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistLabel, setEditingChecklistLabel] = useState("");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  // Drafts keyed by segment - only risk_per_trade_pct/min_reward_risk_ratio
  // are editable here (capital_per_trade/leverage/square_off_time stay
  // execution's own AccountsPage concern).
  const [draftRisk, setDraftRisk] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [draftRR, setDraftRR] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  // Spot/future only (see Account.enforce_risk_based_lots's own comment)
  // - when on, ManualTab.tsx auto-computes and locks that segment's Lot
  // field from Risk/trade % instead of leaving it free-typed.
  const [draftEnforceLots, setDraftEnforceLots] = useState<Record<Segment, boolean>>({ NSE: false, MCX: false, CRYPTO: false });
  const [savingSegment, setSavingSegment] = useState<Segment | null>(null);
  const [justSavedSegment, setJustSavedSegment] = useState<Segment | null>(null);

  useEffect(() => {
    void refreshAccounts();
  }, []);

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
      setAccountsError(null);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSegmentRisk(segment: Segment) {
    const risk_per_trade_pct = Number(draftRisk[segment]);
    const min_reward_risk_ratio = Number(draftRR[segment]);
    if (!Number.isFinite(risk_per_trade_pct) || risk_per_trade_pct <= 0 || risk_per_trade_pct > 100) {
      setAccountsError(`${segment}: Risk/trade must be between 0 and 100`);
      return;
    }
    if (!Number.isFinite(min_reward_risk_ratio) || min_reward_risk_ratio <= 0) {
      setAccountsError(`${segment}: Min reward:risk must be greater than 0`);
      return;
    }
    setSavingSegment(segment);
    try {
      await updateAccount(segment, {
        risk_per_trade_pct,
        min_reward_risk_ratio,
        enforce_risk_based_lots: draftEnforceLots[segment],
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

  return (
    <div className="manual-settings-page">
      <button type="button" className="manual-settings-back" onClick={onBack}>
        ← Back to Manual
      </button>
      <h3>Checklist & Risk Settings</h3>

      <section className="manual-settings-section">
        <h4>Risk per trade / segment</h4>
        <p className="manual-settings-hint">
          Risk/trade caps a manual order's size (risk-based sizing, used whenever Lots isn't set explicitly). Min reward:risk
          is the RR floor the Manual tab's Add/Update button enforces on Limit(or live LTP)/Target/SL Limit. Enforce
          risk-based Lot locks the Lot field itself to what Risk/trade % computes (spot/future, once a stop-loss is set).
        </p>
        {accountsError && <p className="error">{accountsError}</p>}
        <div className="manual-risk-grid">
          {ALL_SEGMENTS.map((seg) => {
            const account = accounts.find((a) => a.segment === seg);
            const unit = seg === "CRYPTO" ? "USD" : "INR";
            // Live preview from the DRAFT %, not the last-saved value -
            // so typing a new Risk/trade % shows what it'll actually mean
            // in absolute terms before hitting Save, same immediacy
            // riskLotsEnforced's own live recompute (ManualTab.tsx) uses.
            const draftRiskPct = Number(draftRisk[seg]);
            const riskAmount =
              account && Number.isFinite(draftRiskPct) ? (account.capital_per_trade * draftRiskPct) / 100 : null;
            return (
              <div className="manual-risk-card" key={seg}>
                <span className="manual-risk-card-title">{seg}</span>
                {account && (
                  <span className="manual-risk-card-capital">
                    Capital/trade {fmt(account.capital_per_trade)} {unit} &middot; Balance {fmt(account.current_balance)} {unit}
                    {riskAmount != null && (
                      <>
                        {" "}
                        &middot; Risk amount <strong>{fmt(riskAmount)} {unit}</strong>
                      </>
                    )}
                  </span>
                )}
                <label>
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
                <label>
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
                <label className="checkbox-label tiny manual-risk-card-checkbox" title="Spot/future orders only - auto-computes and locks the Lot field from Risk/trade % once a stop-loss is set, instead of leaving it free-typed.">
                  <input
                    type="checkbox"
                    checked={draftEnforceLots[seg]}
                    disabled={!account}
                    onChange={(e) => setDraftEnforceLots((prev) => ({ ...prev, [seg]: e.target.checked }))}
                  />
                  Enforce risk-based Lot (spot/future)
                </label>
                <button type="button" className="tiny" disabled={!account || savingSegment === seg} onClick={() => void saveSegmentRisk(seg)}>
                  {savingSegment === seg ? "Saving..." : "Save"}
                </button>
                {justSavedSegment === seg && <span className="manual-saved-badge">Saved</span>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="manual-settings-section">
        <h4>Trade discipline checklist ({checklistItems.length} item{checklistItems.length === 1 ? "" : "s"})</h4>
        {([
          ["plan", "Pre-trade (Plan)", planItems],
          ["day", "Once per day", dayItems],
          ["review", "Post-trade (Review)", reviewItems],
        ] as const).map(([phase, title, items]) => (
          <div className="manual-checklist-editor" key={phase}>
            <span className="manual-checklist-title">{title}</span>
            {items.map((item) => (
              <div className="manual-checklist-editor-row" key={item.id}>
                {editingChecklistId === item.id ? (
                  <>
                    <input type="text" value={editingChecklistLabel} onChange={(e) => setEditingChecklistLabel(e.target.value)} />
                    <button
                      type="button"
                      className="tiny"
                      onClick={async () => {
                        const label = editingChecklistLabel.trim();
                        if (!label) return;
                        await updateChecklistItem(item.id, { label });
                        setEditingChecklistId(null);
                        await refreshChecklistItems();
                      }}
                    >
                      Save
                    </button>
                    <button type="button" className="tiny secondary" onClick={() => setEditingChecklistId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    <span className="manual-segment-toggle-group" title="Which segment(s) this item applies to - none selected means every segment">
                      {ALL_SEGMENTS.map((seg) => (
                        <button
                          key={seg}
                          type="button"
                          className={`tiny secondary ${item.segments.includes(seg) ? "active" : ""}`}
                          onClick={async () => {
                            const segments = item.segments.includes(seg) ? item.segments.filter((s) => s !== seg) : [...item.segments, seg];
                            await updateChecklistItem(item.id, { segments });
                            await refreshChecklistItems();
                          }}
                        >
                          {seg[0]}
                        </button>
                      ))}
                    </span>
                    <button
                      type="button"
                      className="tiny secondary"
                      onClick={() => {
                        setEditingChecklistId(item.id);
                        setEditingChecklistLabel(item.label);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="tiny btn-exit"
                      onClick={async () => {
                        await deleteChecklistItem(item.id);
                        await refreshChecklistItems();
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            ))}
            <div className="manual-checklist-editor-row">
              <input
                type="text"
                placeholder={`Add a${phase === "plan" ? " pre-trade" : phase === "day" ? " once-per-day" : " post-trade"} item...`}
                value={newChecklistPhase === phase ? newChecklistLabel : ""}
                onFocus={() => setNewChecklistPhase(phase)}
                onChange={(e) => {
                  setNewChecklistPhase(phase);
                  setNewChecklistLabel(e.target.value);
                }}
              />
              <span className="manual-segment-toggle-group" title="Which segment(s) the new item applies to - none selected means every segment">
                {ALL_SEGMENTS.map((seg) => (
                  <button
                    key={seg}
                    type="button"
                    className={`tiny secondary ${newChecklistPhase === phase && newChecklistSegments.includes(seg) ? "active" : ""}`}
                    onClick={() => {
                      setNewChecklistPhase(phase);
                      setNewChecklistSegments((prev) => (prev.includes(seg) ? prev.filter((s) => s !== seg) : [...prev, seg]));
                    }}
                  >
                    {seg[0]}
                  </button>
                ))}
              </span>
              <button
                type="button"
                className="tiny"
                disabled={newChecklistPhase !== phase || !newChecklistLabel.trim()}
                onClick={async () => {
                  const label = newChecklistLabel.trim();
                  if (!label) return;
                  setNewChecklistLabel("");
                  await createChecklistItem(label, phase, newChecklistSegments);
                  setNewChecklistSegments([]);
                  await refreshChecklistItems();
                }}
              >
                Add
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
