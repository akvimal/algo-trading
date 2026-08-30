import { useEffect, useState } from "react";

import {
  type Account,
  type CredentialsOut,
  type LiveTradingStatus,
  type SignalCount,
  type Settings,
  type StrategyAccount,
  type StrategyPerformance,
  type StrategySummary,
  createStrategyAccount,
  deleteStrategyAccount,
  fetchAccounts,
  fetchCredentials,
  fetchLiveTradingStatus,
  fetchPlatformAccounts,
  fetchSettings,
  fetchSignalCounts,
  fetchStrategyAccounts,
  fetchStrategyNames,
  fetchStrategyPerformance,
  resetAccount,
  resetStrategyAccount,
  saveCredentials,
  updateAccount,
  updatePlatformAccount,
  updateSettings,
  updateStrategyAccount,
} from "./api";
import { getAuthIsAdmin } from "./auth";
import { CheckIcon, PencilIcon, RotateCcwIcon, TrashIcon, XIcon } from "./Icons";
import { InfoDisclosure } from "./InfoDisclosure";
import { SEGMENTS, formatDateTime } from "./format";

const POLL_INTERVAL_MS = 5000;
const LEVERAGE_OPTIONS = [1, 10, 25, 50, 100, 150, 200];

type Segment = Account["segment"];
type AccountsTab = "mine" | "platform" | "live-status" | "strategy-accounts" | "performance";

// current_balance broken into realized (banked, since starting_balance)
// and unrealized (live mark-to-market on OPEN positions) - the same pair
// shown for "Your account"/Platform/Dedicated strategy accounts, so one
// shared renderer keeps the three displays consistent.
function BalanceBreakdown({
  currentBalance,
  realizedPnl,
  unrealizedPnl,
  currency = "₹",
  locale = "en-IN",
}: {
  currentBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  currency?: string;
  locale?: string;
}) {
  return (
    <span className="balance-breakdown">
      <strong>
        {currency}
        {fmtMoney(currentBalance, locale)}
      </strong>
      <span className={`balance-breakdown-detail ${realizedPnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
        Realized {realizedPnl >= 0 ? "+" : ""}
        {currency}
        {fmtMoney(realizedPnl, locale)}
      </span>
      <span className={`balance-breakdown-detail ${unrealizedPnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
        Unrealized {unrealizedPnl >= 0 ? "+" : ""}
        {currency}
        {fmtMoney(unrealizedPnl, locale)}
      </span>
    </span>
  );
}

// Whole numbers (the common case - capital/trade and risk amount are
// almost always round configured/computed figures) show with no decimals;
// only a genuinely fractional value (real paise from a compounding
// balance) keeps its 2 decimals. `locale` defaults to Indian digit
// grouping (10,00,000 not 1,000,000) to match the rest of the "Your
// account" cards below - callers pass "en-US" for CRYPTO's USD balances.
// Ported as-is from manual-trading's own RiskAccountsPage (see
// docs/architecture.md) - deliberately distinct from this file's own
// money()/moneySigned() imports (format.ts), which use a plainer style
// that the Positions grid already depends on elsewhere.
function fmtMoney(n: number, locale = "en-IN"): string {
  const hasFraction = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString(locale, hasFraction ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 });
}

export default function AccountsPage() {
  // See PositionsPage.tsx's own isAdmin comment - gates the platform-wide
  // fetch/section below the same way, fixed alongside it 2026-08-29
  // (fetchPlatformAccounts' own comment had the same now-stale "no
  // separate admin check is needed here" assumption from execution/
  // frontend's old admin-only era).
  const isAdmin = getAuthIsAdmin();

  // Top-level page layout - one section visible at a time instead of a
  // long stack of every form (each was already independently useful, just
  // not all needed at once). "platform"/"live-status" are admin-only, same
  // gating the sections themselves already had.
  const [activeTab, setActiveTab] = useState<AccountsTab>("mine");

  // Every editable section below defaults to READ-ONLY - a saved value is
  // shown as plain text, not a live input, so loading the page can never
  // itself risk a fat-fingered edit. Clicking Edit (PencilIcon) copies the
  // current server value into that row/card's own draft state (already
  // kept in sync by each section's own poll/refresh below) and reveals the
  // input fields; Cancel (XIcon) discards the draft and reverts to
  // read-only without saving; Save persists then reverts to read-only too.
  const [myEditing, setMyEditing] = useState<Record<Segment, boolean>>({ NSE: false, MCX: false, CRYPTO: false });
  const [myEditingUsdinr, setMyEditingUsdinr] = useState(false);
  const [platformEditing, setPlatformEditing] = useState<Record<string, boolean>>({});
  const [strategyEditing, setStrategyEditing] = useState<Record<string, boolean>>({});

  // "Your account" - the caller's OWN personal capital/risk/leverage/
  // square-off/live-trading settings (execution.accounts, one row per
  // segment) plus the USDINR rate (execution.settings) - moved here from
  // Manual Trading's own former "Risk & Accounts" page (see
  // docs/architecture.md) since this data was always execution's own
  // (Manual Trading's page was just a thin cross-origin UI over the same
  // GET/PUT /accounts and /settings routes this file already calls for
  // the platform/strategy sections below) - the Manual tab's own
  // WorkspacePage.tsx still reads GET /accounts directly for its own
  // Lot-sizing math, unaffected by where the EDITING UI lives. Every
  // logged-in user sees this section (not admin-gated) - only the
  // platform-wide section below is.
  const [myAccounts, setMyAccounts] = useState<Account[]>([]);
  const [myAccountsError, setMyAccountsError] = useState<string | null>(null);
  const [myDraftRisk, setMyDraftRisk] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [myDraftRR, setMyDraftRR] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [myDraftEnforceLots, setMyDraftEnforceLots] = useState<Record<Segment, boolean>>({ NSE: false, MCX: false, CRYPTO: false });
  const [myDraftCapital, setMyDraftCapital] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [myDraftLeverage, setMyDraftLeverage] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [myDraftLeverageBuffer, setMyDraftLeverageBuffer] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [myDraftSquareOffTime, setMyDraftSquareOffTime] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [myDraftNeverSquareOff, setMyDraftNeverSquareOff] = useState<Record<Segment, boolean>>({ NSE: false, MCX: false, CRYPTO: false });
  const [myDraftLiveEnabled, setMyDraftLiveEnabled] = useState<Record<Segment, boolean>>({ NSE: false, MCX: false, CRYPTO: false });
  const [myDraftMaxOrderValue, setMyDraftMaxOrderValue] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [myDraftMaxDailyLoss, setMyDraftMaxDailyLoss] = useState<Record<Segment, string>>({ NSE: "", MCX: "", CRYPTO: "" });
  const [mySavingSegment, setMySavingSegment] = useState<Segment | null>(null);
  const [myJustSavedSegment, setMyJustSavedSegment] = useState<Segment | null>(null);
  const [myResettingSegment, setMyResettingSegment] = useState<Segment | null>(null);

  // USD/INR rate (CRYPTO sizing only) - execution.settings, same "your
  // own" scoping as the accounts above.
  const [mySettings, setMySettings] = useState<Settings | null>(null);
  const [myUsdinrDraft, setMyUsdinrDraft] = useState("");
  const [mySavingUsdinr, setMySavingUsdinr] = useState(false);
  const [myUsdinrMessage, setMyUsdinrMessage] = useState<string | null>(null);

  // BYO broker credentials (systems/accounts) - moved here from
  // manual-trading's former "My Credentials" page, see api.ts's own
  // comment on fetchCredentials/saveCredentials. Drafts always start
  // blank - GET /credentials never echoes a decrypted secret back, only
  // presence flags.
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

  // Platform-wide (user_id IS NULL) accounts - the rows the automated
  // Strategy-driven flow actually reads (see api.ts's own comment on
  // fetchPlatformAccounts). Admin-only, unlike "Your account" above.
  const [platformAccounts, setPlatformAccounts] = useState<Account[]>([]);
  const [platformDrafts, setPlatformDrafts] = useState<
    Record<string, { leverage: number | ""; leverageBufferPct: number | ""; mtfInterestRate: number | ""; squareOffTime: string }>
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

  // "Performance" tab - total signal count comes from signal-engine
  // (GET /signals/counts), everything else (trades/win rate/PnL/drawdown)
  // from execution's own GET /strategies/performance - combined
  // client-side by strategy_id, same cross-system-but-no-shared-DB
  // pattern fetchStrategyNames already uses for the picker above.
  const [signalCounts, setSignalCounts] = useState<SignalCount[]>([]);
  const [strategyPerformance, setStrategyPerformance] = useState<StrategyPerformance[]>([]);
  const [performanceError, setPerformanceError] = useState<string | null>(null);

  const [newStrategyId, setNewStrategyId] = useState("");
  const [newStartingBalance, setNewStartingBalance] = useState<number | "">(200000);
  const [newCapitalPerTrade, setNewCapitalPerTrade] = useState<number | "">(50000);
  const [newRiskPerTrade, setNewRiskPerTrade] = useState<number | "">(1);
  const [creatingStrategyAccount, setCreatingStrategyAccount] = useState(false);

  useEffect(() => {
    void refreshMyAccounts();
    fetchSettings()
      .then((s) => {
        setMySettings(s);
        setMyUsdinrDraft(s.usdinr_rate != null ? String(s.usdinr_rate) : "");
      })
      .catch(() => {
        // Non-CRYPTO users have no reason to care - this section just
        // shows its own "couldn't load" state below.
      });
  }, []);

  async function refreshMyAccounts() {
    try {
      const data = await fetchAccounts();
      setMyAccounts(data);
      setMyDraftRisk((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.risk_per_trade_pct);
        return next;
      });
      setMyDraftRR((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.min_reward_risk_ratio);
        return next;
      });
      setMyDraftEnforceLots((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.enforce_risk_based_lots;
        return next;
      });
      setMyDraftCapital((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.capital_per_trade);
        return next;
      });
      setMyDraftLeverage((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.leverage);
        return next;
      });
      setMyDraftLeverageBuffer((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = String(a.leverage_buffer_pct);
        return next;
      });
      setMyDraftSquareOffTime((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.square_off_time ? a.square_off_time.slice(0, 5) : "";
        return next;
      });
      setMyDraftNeverSquareOff((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.square_off_time == null;
        return next;
      });
      setMyDraftLiveEnabled((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.live_trading_enabled;
        return next;
      });
      setMyDraftMaxOrderValue((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.max_order_value != null ? String(a.max_order_value) : "";
        return next;
      });
      setMyDraftMaxDailyLoss((prev) => {
        const next = { ...prev };
        for (const a of data) next[a.segment] = a.max_daily_loss != null ? String(a.max_daily_loss) : "";
        return next;
      });
      setMyAccountsError(null);
    } catch (err) {
      setMyAccountsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveMyUsdinr() {
    const usdinr_rate = Number(myUsdinrDraft);
    if (!Number.isFinite(usdinr_rate) || usdinr_rate <= 0) {
      setMyUsdinrMessage("USD/INR rate must be greater than 0");
      return;
    }
    setMySavingUsdinr(true);
    setMyUsdinrMessage(null);
    try {
      const updated = await updateSettings({ usdinr_rate });
      setMySettings(updated);
      setMyUsdinrMessage("Saved.");
    } catch (err) {
      setMyUsdinrMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setMySavingUsdinr(false);
    }
  }

  async function saveMySegmentRisk(segment: Segment) {
    const risk_per_trade_pct = Number(myDraftRisk[segment]);
    const min_reward_risk_ratio = Number(myDraftRR[segment]);
    const capital_per_trade = Number(myDraftCapital[segment]);
    if (!Number.isFinite(risk_per_trade_pct) || risk_per_trade_pct <= 0 || risk_per_trade_pct > 100) {
      setMyAccountsError(`${segment}: Risk/trade must be between 0 and 100`);
      return;
    }
    if (!Number.isFinite(min_reward_risk_ratio) || min_reward_risk_ratio <= 0) {
      setMyAccountsError(`${segment}: Min reward:risk must be greater than 0`);
      return;
    }
    if (!Number.isFinite(capital_per_trade) || capital_per_trade <= 0) {
      setMyAccountsError(`${segment}: Capital/trade must be greater than 0`);
      return;
    }
    let leverage: number | undefined;
    if (segment === "CRYPTO" || segment === "NSE") {
      leverage = Number(myDraftLeverage[segment]);
      if (!Number.isFinite(leverage) || leverage <= 0) {
        setMyAccountsError(`${segment}: Leverage must be greater than 0`);
        return;
      }
    }
    let leverageBufferPct: number | undefined;
    if (segment === "NSE") {
      leverageBufferPct = Number(myDraftLeverageBuffer[segment]);
      if (!Number.isFinite(leverageBufferPct) || leverageBufferPct < 0 || leverageBufferPct >= 100) {
        setMyAccountsError(`${segment}: Leverage buffer must be between 0 and 100`);
        return;
      }
    }
    const square_off_time = myDraftNeverSquareOff[segment] || !myDraftSquareOffTime[segment] ? null : `${myDraftSquareOffTime[segment]}:00`;

    const maxOrderValueNum = myDraftMaxOrderValue[segment] === "" ? null : Number(myDraftMaxOrderValue[segment]);
    const maxDailyLossNum = myDraftMaxDailyLoss[segment] === "" ? null : Number(myDraftMaxDailyLoss[segment]);
    if (maxOrderValueNum != null && (!Number.isFinite(maxOrderValueNum) || maxOrderValueNum <= 0)) {
      setMyAccountsError(`${segment}: Max order value must be greater than 0`);
      return;
    }
    if (maxDailyLossNum != null && (!Number.isFinite(maxDailyLossNum) || maxDailyLossNum <= 0)) {
      setMyAccountsError(`${segment}: Max daily loss must be greater than 0`);
      return;
    }

    const existing = myAccounts.find((a) => a.segment === segment);
    const turningLiveOn = myDraftLiveEnabled[segment] && !(existing?.live_trading_enabled ?? false);
    if (turningLiveOn) {
      const confirmed = window.confirm(
        `Turn ON real order placement for your ${segment} account?\n\n` +
          "Every order you place here from now on will be a REAL order sent to Dhan using your own saved " +
          "credentials, not a paper trade. Make sure your Dhan credentials are saved (Credentials section " +
          "below) and this is really what you want before confirming.",
      );
      if (!confirmed) return;
    }

    setMySavingSegment(segment);
    try {
      await updateAccount(segment, {
        risk_per_trade_pct,
        min_reward_risk_ratio,
        enforce_risk_based_lots: myDraftEnforceLots[segment],
        capital_per_trade,
        ...(leverage !== undefined ? { leverage } : {}),
        ...(leverageBufferPct !== undefined ? { leverage_buffer_pct: leverageBufferPct } : {}),
        square_off_time,
        ...(segment !== "CRYPTO"
          ? { live_trading_enabled: myDraftLiveEnabled[segment], max_order_value: maxOrderValueNum, max_daily_loss: maxDailyLossNum }
          : {}),
      });
      await refreshMyAccounts();
      setMyJustSavedSegment(segment);
      setTimeout(() => setMyJustSavedSegment((s) => (s === segment ? null : s)), 2500);
      setMyAccountsError(null);
      setMyEditing((prev) => ({ ...prev, [segment]: false }));
    } catch (err) {
      setMyAccountsError(err instanceof Error ? err.message : String(err));
    } finally {
      setMySavingSegment(null);
    }
  }

  // Shared by startMyEdit/cancelMyEdit below - re-derives `segment`'s
  // drafts from the account row already held in myAccounts (kept current
  // by refreshMyAccounts) rather than re-fetching, so entering edit mode
  // never shows a stale draft and cancelling always discards local typing.
  function syncMyDraftsFromAccount(segment: Segment) {
    const account = myAccounts.find((a) => a.segment === segment);
    if (!account) return;
    setMyDraftRisk((prev) => ({ ...prev, [segment]: String(account.risk_per_trade_pct) }));
    setMyDraftRR((prev) => ({ ...prev, [segment]: String(account.min_reward_risk_ratio) }));
    setMyDraftEnforceLots((prev) => ({ ...prev, [segment]: account.enforce_risk_based_lots }));
    setMyDraftCapital((prev) => ({ ...prev, [segment]: String(account.capital_per_trade) }));
    setMyDraftLeverage((prev) => ({ ...prev, [segment]: String(account.leverage) }));
    setMyDraftLeverageBuffer((prev) => ({ ...prev, [segment]: String(account.leverage_buffer_pct) }));
    setMyDraftSquareOffTime((prev) => ({ ...prev, [segment]: account.square_off_time ? account.square_off_time.slice(0, 5) : "" }));
    setMyDraftNeverSquareOff((prev) => ({ ...prev, [segment]: account.square_off_time == null }));
    setMyDraftLiveEnabled((prev) => ({ ...prev, [segment]: account.live_trading_enabled }));
    setMyDraftMaxOrderValue((prev) => ({ ...prev, [segment]: account.max_order_value != null ? String(account.max_order_value) : "" }));
    setMyDraftMaxDailyLoss((prev) => ({ ...prev, [segment]: account.max_daily_loss != null ? String(account.max_daily_loss) : "" }));
  }

  function startMyEdit(segment: Segment) {
    syncMyDraftsFromAccount(segment);
    setMyAccountsError(null);
    setMyEditing((prev) => ({ ...prev, [segment]: true }));
  }

  function cancelMyEdit(segment: Segment) {
    syncMyDraftsFromAccount(segment);
    setMyAccountsError(null);
    setMyEditing((prev) => ({ ...prev, [segment]: false }));
  }

  async function resetMySegmentBalance(segment: Segment) {
    const confirmed = window.confirm(
      `Reset the ${segment} account's balance back to its starting balance? This doesn't undo any positions.`,
    );
    if (!confirmed) return;
    setMyResettingSegment(segment);
    try {
      await resetAccount(segment);
      await refreshMyAccounts();
      setMyAccountsError(null);
    } catch (err) {
      setMyAccountsError(err instanceof Error ? err.message : String(err));
    } finally {
      setMyResettingSegment(null);
    }
  }

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
                leverageBufferPct: a.leverage_buffer_pct,
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
    // Polled, not fetched once on mount - signal-generation is a separate
    // frontend/tab, so a strategy created there while this page is
    // already open used to never appear in the picker below until a full
    // reload (found live: create a strategy, switch to this tab, the new
    // one is missing from "Dedicated strategy accounts" until refresh).
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchStrategyNames();
        if (!cancelled) setStrategies(data);
      } catch {
        // signal-generation may be unreachable - the create form just
        // shows an empty picker below rather than blocking this page.
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

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const [countsResult, performanceResult] = await Promise.allSettled([fetchSignalCounts(), fetchStrategyPerformance()]);
      if (cancelled) return;
      if (countsResult.status === "fulfilled") setSignalCounts(countsResult.value);
      if (performanceResult.status === "fulfilled") setStrategyPerformance(performanceResult.value);
      if (countsResult.status === "rejected" && performanceResult.status === "rejected") {
        setPerformanceError("Failed to load strategy performance");
      } else {
        setPerformanceError(null);
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

  function strategySegment(strategyId: string): Account["segment"] {
    return strategies.find((s) => s.id === strategyId)?.segment ?? "NSE";
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
      setStrategyEditing((prev) => ({ ...prev, [strategyId]: false }));
    } catch (err) {
      setStrategyAccountMessage(err instanceof Error ? err.message : "Failed to save dedicated account");
    } finally {
      setSavingStrategyAccount(null);
    }
  }

  // Shared by startStrategyEdit/cancelStrategyEdit below - the per-strategy
  // poll only ever seeds a draft once (it must not clobber one being
  // actively typed into), so entering/leaving edit mode must explicitly
  // resync from strategyAccounts itself or a stale draft could show.
  function syncStrategyDraftFromAccount(strategyId: string) {
    const account = strategyAccounts.find((a) => a.strategy_id === strategyId);
    if (!account) return;
    setStrategyDrafts((prev) => ({
      ...prev,
      [strategyId]: {
        capital: account.capital_per_trade,
        risk: account.risk_per_trade_pct,
        liveUserId: account.live_trading_user_id ?? "",
        liveEnabled: account.live_trading_enabled,
        maxOrderValue: account.max_order_value ?? "",
        maxDailyLoss: account.max_daily_loss ?? "",
      },
    }));
  }

  function startStrategyEdit(strategyId: string) {
    syncStrategyDraftFromAccount(strategyId);
    setStrategyAccountMessage(null);
    setStrategyEditing((prev) => ({ ...prev, [strategyId]: true }));
  }

  function cancelStrategyEdit(strategyId: string) {
    syncStrategyDraftFromAccount(strategyId);
    setStrategyAccountMessage(null);
    setStrategyEditing((prev) => ({ ...prev, [strategyId]: false }));
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
        ...(segment === "NSE" && draft.leverageBufferPct !== "" ? { leverage_buffer_pct: draft.leverageBufferPct } : {}),
        mtf_annual_interest_rate_pct: draft.mtfInterestRate === "" ? null : draft.mtfInterestRate,
        square_off_time: draft.squareOffTime ? `${draft.squareOffTime}:00` : null,
      });
      setPlatformAccounts((prev) => prev.map((a) => (a.segment === segment ? updated : a)));
      setPlatformMessage(`Platform ${segment} account saved.`);
      setPlatformEditing((prev) => ({ ...prev, [segment]: false }));
    } catch (err) {
      setPlatformMessage(err instanceof Error ? err.message : `Failed to save platform ${segment} account`);
    } finally {
      setSavingPlatform(null);
    }
  }

  // Shared by startPlatformEdit/cancelPlatformEdit below - same "poll only
  // ever seeds a draft once" reasoning as syncStrategyDraftFromAccount.
  function syncPlatformDraftFromAccount(segment: Account["segment"]) {
    const account = platformAccounts.find((a) => a.segment === segment);
    if (!account) return;
    setPlatformDrafts((prev) => ({
      ...prev,
      [segment]: {
        leverage: account.leverage,
        leverageBufferPct: account.leverage_buffer_pct,
        mtfInterestRate: account.mtf_annual_interest_rate_pct ?? "",
        squareOffTime: account.square_off_time ? account.square_off_time.slice(0, 5) : "",
      },
    }));
  }

  function startPlatformEdit(segment: Account["segment"]) {
    syncPlatformDraftFromAccount(segment);
    setPlatformMessage(null);
    setPlatformEditing((prev) => ({ ...prev, [segment]: true }));
  }

  function cancelPlatformEdit(segment: Account["segment"]) {
    syncPlatformDraftFromAccount(segment);
    setPlatformMessage(null);
    setPlatformEditing((prev) => ({ ...prev, [segment]: false }));
  }

  return (
    <>
      <nav className="tabs">
        <button type="button" className={activeTab === "mine" ? "active" : ""} onClick={() => setActiveTab("mine")}>
          Your account
        </button>
        {isAdmin && (
          <button type="button" className={activeTab === "platform" ? "active" : ""} onClick={() => setActiveTab("platform")}>
            Platform (admin)
          </button>
        )}
        {isAdmin && (
          <button type="button" className={activeTab === "live-status" ? "active" : ""} onClick={() => setActiveTab("live-status")}>
            Live trading status
          </button>
        )}
        <button
          type="button"
          className={activeTab === "strategy-accounts" ? "active" : ""}
          onClick={() => setActiveTab("strategy-accounts")}
        >
          Dedicated strategy accounts
        </button>
        <button
          type="button"
          className={activeTab === "performance" ? "active" : ""}
          onClick={() => setActiveTab("performance")}
        >
          Performance
        </button>
      </nav>

      {activeTab === "mine" && (
      <>
      <h2>Your account</h2>
      <p className="subtitle">
        Your own personal capital, risk, leverage, square-off, and live-trading settings, per segment - the Manual
        tab's own order entry (Manual Trading &rsaquo; Intraday &rsaquo; Workspace) sizes and enforces against
        these. Platform/admin config (the automated Strategy-driven flow's own account) is further down.
      </p>
      {myAccountsError && <p className="error">Could not reach the backend: {myAccountsError}</p>}

      <section className="account-summary">
        {SEGMENTS.map((seg) => {
          const account = myAccounts.find((a) => a.segment === seg);
          if (!account) return null;
          const currency = seg === "CRYPTO" ? "$" : "₹";
          const locale = seg === "CRYPTO" ? "en-US" : "en-IN";
          const riskAmount = (account.capital_per_trade * account.risk_per_trade_pct) / 100;
          return (
            <div className="stat account-summary-card" key={seg}>
              <span className="stat-label">{seg}</span>
              <BalanceBreakdown
                currentBalance={account.current_balance}
                realizedPnl={account.realized_pnl}
                unrealizedPnl={account.unrealized_pnl}
                currency={currency}
                locale={locale}
              />
              <span className="account-summary-detail">
                Capital/trade {currency}
                {fmtMoney(account.capital_per_trade, locale)} &middot; Risk {currency}
                {fmtMoney(riskAmount, locale)} ({account.risk_per_trade_pct}%)
              </span>
              {(seg === "CRYPTO" || seg === "NSE") && (
                <span className="account-summary-detail">
                  Leverage {account.leverage}x
                  {seg === "NSE" && <> &middot; Buffer {account.leverage_buffer_pct}%</>}
                </span>
              )}
              <span className="account-summary-detail">
                Square-off {account.square_off_time ? account.square_off_time.slice(0, 5) : "never"}
              </span>
              {seg !== "CRYPTO" && (
                <span className="account-summary-detail">
                  Live trading {account.live_trading_enabled ? <span className="badge badge-live">LIVE</span> : "off"}
                  {account.max_order_value != null && <> &middot; Max order {currency}{fmtMoney(account.max_order_value, locale)}</>}
                  {account.max_daily_loss != null && <> &middot; Max daily loss {currency}{fmtMoney(account.max_daily_loss, locale)}</>}
                </span>
              )}
            </div>
          );
        })}
      </section>

      <div className="manual-settings-page">
        <section className="manual-settings-section">
          <h4>Settings</h4>
          <div className="manual-risk-grid">
            {SEGMENTS.map((seg) => {
              const account = myAccounts.find((a) => a.segment === seg);
              const editing = myEditing[seg];
              return (
                <div className="manual-risk-card" key={seg}>
                  <span className="manual-risk-card-title">
                    {seg}
                    {!editing && (
                      <button
                        type="button"
                        className="icon-btn edit-icon"
                        disabled={!account}
                        onClick={() => startMyEdit(seg)}
                        title="Edit"
                        aria-label={`Edit ${seg} account`}
                      >
                        <PencilIcon />
                      </button>
                    )}
                  </span>
                  {editing && (
                    <>
                      <label title="Caps a manual order's size - risk-based sizing, used whenever Lots isn't set explicitly.">
                        Risk/trade %
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={myDraftRisk[seg]}
                          disabled={!account}
                          onChange={(e) => setMyDraftRisk((prev) => ({ ...prev, [seg]: e.target.value }))}
                        />
                      </label>
                      <label title="The RR floor the Manual tab's Add/Update button enforces on Limit (or live LTP)/Target/SL Limit.">
                        Min reward:risk (1:x)
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={myDraftRR[seg]}
                          disabled={!account}
                          onChange={(e) => setMyDraftRR((prev) => ({ ...prev, [seg]: e.target.value }))}
                        />
                      </label>
                      <label title="Total capital allocated to a single trade in this segment - what Risk/trade % above is computed against.">
                        Capital/trade
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={myDraftCapital[seg]}
                          disabled={!account}
                          onChange={(e) => setMyDraftCapital((prev) => ({ ...prev, [seg]: e.target.value }))}
                        />
                      </label>
                      {(seg === "CRYPTO" || seg === "NSE") && (
                        <label
                          title={
                            seg === "CRYPTO"
                              ? "Margin multiplier applied before sizing (Delta Exchange India trades perpetual futures on margin)."
                              : "Margin multiplier for intraday MIS orders in this segment (spot only) - no interest cost, unlike NSE MTF for positional trades (admin/broker-config only, see Platform account below)."
                          }
                        >
                          Leverage
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={myDraftLeverage[seg]}
                            disabled={!account}
                            onChange={(e) => setMyDraftLeverage((prev) => ({ ...prev, [seg]: e.target.value }))}
                          />
                        </label>
                      )}
                      {seg === "NSE" && (
                        <label title="Shaves this % off the leveraged capital before sizing, as headroom against slippage between the signal/order price and the actual fill price - e.g. leverage 5x with a 10% buffer sizes against 4.5x, not the full 5x.">
                          Leverage buffer %
                          <input
                            type="number"
                            min="0"
                            max="99"
                            step="1"
                            value={myDraftLeverageBuffer[seg]}
                            disabled={!account}
                            onChange={(e) => setMyDraftLeverageBuffer((prev) => ({ ...prev, [seg]: e.target.value }))}
                          />
                        </label>
                      )}
                      <label title="Any OPEN intraday position in this segment still open past this local time gets forcefully closed.">
                        Square-off time
                        <input
                          type="time"
                          value={myDraftSquareOffTime[seg]}
                          disabled={!account || myDraftNeverSquareOff[seg]}
                          onChange={(e) => setMyDraftSquareOffTime((prev) => ({ ...prev, [seg]: e.target.value }))}
                        />
                      </label>
                      <label
                        className="checkbox-label tiny manual-risk-card-checkbox"
                        title="Never force-close - a position in this segment stays open past any time of day (e.g. CRYPTO, which trades 24/7)."
                      >
                        <input
                          type="checkbox"
                          checked={myDraftNeverSquareOff[seg]}
                          disabled={!account}
                          onChange={(e) => setMyDraftNeverSquareOff((prev) => ({ ...prev, [seg]: e.target.checked }))}
                        />
                        Never force-close
                      </label>
                      <label
                        className="checkbox-label tiny manual-risk-card-checkbox"
                        title="Auto-computes and locks the Lot field from Risk/trade % once a stop-loss is set, instead of leaving it free-typed."
                      >
                        <input
                          type="checkbox"
                          checked={myDraftEnforceLots[seg]}
                          disabled={!account}
                          onChange={(e) => setMyDraftEnforceLots((prev) => ({ ...prev, [seg]: e.target.checked }))}
                        />
                        Enforce risk-based Lot
                      </label>
                      {seg !== "CRYPTO" && (
                        <div className="manual-risk-card-live">
                          <label
                            className="checkbox-label tiny manual-risk-card-checkbox"
                            title="Places REAL orders on Dhan using your own saved credentials instead of paper trades. Also needs the platform-wide kill switch to be off."
                          >
                            <input
                              type="checkbox"
                              checked={myDraftLiveEnabled[seg]}
                              disabled={!account}
                              onChange={(e) => setMyDraftLiveEnabled((prev) => ({ ...prev, [seg]: e.target.checked }))}
                            />
                            Live trading (real orders)
                            {account?.live_trading_enabled && <span className="badge badge-live">LIVE</span>}
                          </label>
                          <label title="Optional - a single order worth more than this is rejected rather than placed live.">
                            Max order value
                            <input
                              type="number"
                              min="1"
                              step="1"
                              placeholder="no cap"
                              value={myDraftMaxOrderValue[seg]}
                              disabled={!account}
                              onChange={(e) => setMyDraftMaxOrderValue((prev) => ({ ...prev, [seg]: e.target.value }))}
                            />
                          </label>
                          <label title="Optional - once today's realized loss reaches this, live trading pauses for this account for the rest of the day.">
                            Max daily loss
                            <input
                              type="number"
                              min="1"
                              step="1"
                              placeholder="no cap"
                              value={myDraftMaxDailyLoss[seg]}
                              disabled={!account}
                              onChange={(e) => setMyDraftMaxDailyLoss((prev) => ({ ...prev, [seg]: e.target.value }))}
                            />
                          </label>
                        </div>
                      )}
                      <span className="edit-actions">
                        <button
                          type="button"
                          className="tiny"
                          disabled={!account || mySavingSegment === seg}
                          onClick={() => void saveMySegmentRisk(seg)}
                        >
                          {mySavingSegment === seg ? "Saving..." : "Save"}
                        </button>
                        <button
                          type="button"
                          className="icon-btn secondary"
                          disabled={mySavingSegment === seg}
                          onClick={() => cancelMyEdit(seg)}
                          title="Cancel"
                          aria-label="Cancel"
                        >
                          <XIcon />
                        </button>
                      </span>
                    </>
                  )}
                  <span className="edit-actions">
                    <button
                      type="button"
                      className="icon-btn secondary"
                      disabled={!account || myResettingSegment === seg}
                      onClick={() => void resetMySegmentBalance(seg)}
                      title={myResettingSegment === seg ? "Resetting..." : `Reset ${seg} balance to its starting balance`}
                      aria-label="Reset balance"
                    >
                      <RotateCcwIcon />
                    </button>
                  </span>
                  {myJustSavedSegment === seg && <span className="manual-saved-badge">Saved</span>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="manual-settings-section">
          <h4>USD/INR rate</h4>
          <p className="subtitle">Manually configured - converts CRYPTO capital/balance into USD-equivalent before sizing a position.</p>
          {!myEditingUsdinr ? (
            <div className="settings-row">
              <span>Rate: {myUsdinrDraft || "not set"}</span>
              <button
                type="button"
                className="icon-btn edit-icon"
                onClick={() => setMyEditingUsdinr(true)}
                title="Edit"
                aria-label="Edit USD/INR rate"
              >
                <PencilIcon />
              </button>
            </div>
          ) : (
            <div className="settings-row">
              <label>
                Rate
                <input type="number" min="0" step="0.01" value={myUsdinrDraft} onChange={(e) => setMyUsdinrDraft(e.target.value)} />
              </label>
              <button
                type="button"
                className="tiny"
                disabled={mySavingUsdinr || !myUsdinrDraft}
                onClick={() => {
                  void handleSaveMyUsdinr();
                  setMyEditingUsdinr(false);
                }}
              >
                {mySavingUsdinr ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className="icon-btn secondary"
                onClick={() => {
                  setMyUsdinrDraft(mySettings?.usdinr_rate != null ? String(mySettings.usdinr_rate) : "");
                  setMyEditingUsdinr(false);
                }}
                title="Cancel"
                aria-label="Cancel"
              >
                <XIcon />
              </button>
            </div>
          )}
          {myUsdinrMessage && <p className="manual-saved-badge">{myUsdinrMessage}</p>}
          {mySettings == null && <p className="error">Could not load settings.</p>}
        </section>

        <details className="manual-settings-section">
          <summary>Credentials</summary>
          <p className="subtitle">Your own Dhan (NSE/MCX) and Delta Exchange India (CRYPTO) keys.</p>
          <InfoDisclosure summary="Why set these?">
            <p>
              Once saved, quotes/candles/option chains, your own manual orders, and the Live trading section
              above all use YOUR credentials and rate budget instead of the platform default. Never shown back
              once saved - paste a new value to replace it.
            </p>
          </InfoDisclosure>
          {credentialsError && <p className="error">{credentialsError}</p>}

          <div className="settings-row">
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

          <div className="settings-row">
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
        </details>
      </div>
      </>
      )}

      {activeTab === "platform" && isAdmin && (
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
        <p>
          <strong>Leverage buffer %</strong> (NSE only): shaved off the leveraged capital before sizing, as headroom
          against slippage between the signal price and the actual fill - e.g. 5x leverage with a 10% buffer sizes
          against 4.5x, not the full 5x.
        </p>
      </InfoDisclosure>
      {platformError && <p className="error">Could not reach the backend: {platformError}</p>}
      {platformMessage && <p className="action-message">{platformMessage}</p>}

      <section className="account-summary">
        {SEGMENTS.map((segment) => {
          const account = platformAccounts.find((a) => a.segment === segment);
          if (!account) return null;
          const currency = segment === "CRYPTO" ? "$" : "₹";
          const locale = segment === "CRYPTO" ? "en-US" : "en-IN";
          return (
            <div className="stat account-summary-card" key={segment}>
              <span className="stat-label">{segment}</span>
              <BalanceBreakdown
                currentBalance={account.current_balance}
                realizedPnl={account.realized_pnl}
                unrealizedPnl={account.unrealized_pnl}
                currency={currency}
                locale={locale}
              />
              <span className="account-summary-detail">Last updated {formatDateTime(account.updated_at)}</span>
            </div>
          );
        })}
      </section>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Segment</th>
              <th>Leverage</th>
              <th>Leverage buffer % (NSE)</th>
              <th>MTF interest %/yr (NSE)</th>
              <th>Square-off (blank = never)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((segment) => {
              const account = platformAccounts.find((a) => a.segment === segment);
              const draft = platformDrafts[segment] ?? { leverage: "", leverageBufferPct: "", mtfInterestRate: "", squareOffTime: "" };
              const editing = platformEditing[segment];
              return (
                <tr key={segment}>
                  <td className="symbol">{segment}</td>
                  {!editing ? (
                    <>
                      <td>{segment === "MCX" ? "-" : `${account?.leverage ?? "-"}x`}</td>
                      <td>{segment === "NSE" ? `${account?.leverage_buffer_pct ?? "-"}%` : "-"}</td>
                      <td>{segment === "NSE" ? account?.mtf_annual_interest_rate_pct ?? "not set" : "-"}</td>
                      <td>{account?.square_off_time ? account.square_off_time.slice(0, 5) : "never"}</td>
                      <td>
                        <button
                          type="button"
                          className="icon-btn edit-icon"
                          disabled={!account}
                          onClick={() => startPlatformEdit(segment)}
                          title="Edit"
                          aria-label={`Edit platform ${segment} account`}
                        >
                          <PencilIcon />
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
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
                            max="99"
                            step="1"
                            title="Shaves this % off the leveraged capital before sizing, as headroom against slippage between the signal/order price and the actual fill price."
                            value={draft.leverageBufferPct}
                            onChange={(e) =>
                              setPlatformDrafts((prev) => ({
                                ...prev,
                                [segment]: { ...draft, leverageBufferPct: e.target.value === "" ? "" : Number(e.target.value) },
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
                      <td className="edit-actions">
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
                        <button
                          type="button"
                          className="icon-btn secondary"
                          disabled={savingPlatform === segment}
                          onClick={() => cancelPlatformEdit(segment)}
                          title="Cancel"
                          aria-label="Cancel"
                        >
                          <XIcon />
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
      )}

      {activeTab === "live-status" && isAdmin && (
      <>
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

      {activeTab === "strategy-accounts" && (
      <>
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
                const editing = strategyEditing[account.strategy_id];
                const currency = account.segment === "CRYPTO" ? "$" : "₹";
                const locale = account.segment === "CRYPTO" ? "en-US" : "en-IN";
                return (
                  <tr key={account.strategy_id}>
                    <td className="symbol">{strategyName(account.strategy_id)}</td>
                    <td>{account.segment}</td>
                    <td>
                      <BalanceBreakdown
                        currentBalance={account.current_balance}
                        realizedPnl={account.realized_pnl}
                        unrealizedPnl={account.unrealized_pnl}
                        currency={currency}
                        locale={locale}
                      />
                    </td>
                    {!editing ? (
                      <>
                        <td>{account.capital_per_trade}</td>
                        <td>{account.risk_per_trade_pct}</td>
                        <td>
                          {canGoLive ? (
                            account.live_trading_enabled ? (
                              <span className="badge badge-live">LIVE</span>
                            ) : (
                              "off"
                            )
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>{canGoLive ? account.live_trading_user_id ?? "-" : "-"}</td>
                        <td>
                          {canGoLive
                            ? `${account.max_order_value ?? "no cap"} / ${account.max_daily_loss ?? "no cap"}`
                            : "-"}
                        </td>
                        <td className="edit-actions">
                          <button
                            type="button"
                            className="icon-btn edit-icon"
                            onClick={() => startStrategyEdit(account.strategy_id)}
                            title="Edit"
                            aria-label={`Edit ${strategyName(account.strategy_id)}'s dedicated account`}
                          >
                            <PencilIcon />
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
                      </>
                    ) : (
                      <>
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
                            disabled={savingStrategyAccount === account.strategy_id}
                            onClick={() => cancelStrategyEdit(account.strategy_id)}
                            title="Cancel"
                            aria-label="Cancel"
                          >
                            <XIcon />
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}

      {activeTab === "performance" && (
      <>
      <h2>Performance</h2>
      <p className="subtitle">
        Per-strategy trade performance - Total signals comes from signal-engine (every signal this strategy has ever
        received, any status); Trades/Win rate/Realized P&amp;L/Max drawdown come from execution's own position
        history. Every strategy that's ever received a signal shows up here, including draft/paused ones.
      </p>
      {performanceError && <p className="error">Could not reach the backend: {performanceError}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Segment</th>
              <th title="Every signal this strategy has ever received, regardless of outcome">Total signals</th>
              <th title="Open / Closed / Rejected">Trades (O / C / R)</th>
              <th title="Wins ÷ closed trades - '-' until this strategy has at least one closed trade">Win rate</th>
              <th>Realized P&amp;L</th>
              <th title="Max peak-to-trough decline of the cumulative realized-P&L curve, built from closed trades in exit order">
                Max drawdown
              </th>
            </tr>
          </thead>
          <tbody>
            {signalCounts.length === 0 ? (
              <tr>
                <td colSpan={7}>No strategy has received a signal yet.</td>
              </tr>
            ) : (
              signalCounts.map((sc) => {
                const perf = strategyPerformance.find((p) => p.strategy_id === sc.strategy_id);
                const segment = strategySegment(sc.strategy_id);
                const currency = segment === "CRYPTO" ? "$" : "₹";
                const locale = segment === "CRYPTO" ? "en-US" : "en-IN";
                const pnl = perf?.total_realized_pnl ?? 0;
                const drawdown = perf?.max_drawdown ?? 0;
                return (
                  <tr key={sc.strategy_id}>
                    <td className="symbol">{strategyName(sc.strategy_id)}</td>
                    <td>{segment}</td>
                    <td className="num">{sc.total_signals}</td>
                    <td className="num">
                      {perf?.trades_open ?? 0} / {perf?.trades_closed ?? 0} / {perf?.trades_rejected ?? 0}
                    </td>
                    <td className="num">{perf?.win_rate != null ? `${perf.win_rate.toFixed(1)}%` : "-"}</td>
                    <td className={`num ${pnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                      {pnl >= 0 ? "+" : ""}
                      {currency}
                      {fmtMoney(pnl, locale)}
                    </td>
                    <td className={`num ${drawdown > 0 ? "pnl-negative" : ""}`}>
                      {currency}
                      {fmtMoney(drawdown, locale)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      </>
      )}
    </>
  );
}
