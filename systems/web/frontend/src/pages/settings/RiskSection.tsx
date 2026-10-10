import { useEffect, useState } from "react";
import { ApiError } from "../../api/http";
import { getUsdInr, resetAccount, saveUsdInr, updateAccount } from "../../api/settings";
import type { Account, Book } from "../../api/types";
import { TextField, ToggleField } from "../../components/Field";
import { formatInr } from "../../format";
import { buildAccountPatch, draftFrom, hasErrors, parseUsdInr, type AccountDraft, type DraftErrors } from "../settingsModel";

/** Risk limits and paper-account behaviour for one segment. These apply to paper orders now
 * and to live ones later: the point is that the limits are yours and the server keeps them. */
export function RiskSection({ account, onSaved, book = "intraday" }: { account: Account; onSaved: () => void; book?: Book }) {
  // The positional book is paper only and never force-closed: a daily loss limit and a square-off time have no meaning there.
  const positional = book === "positional";
  const [draft, setDraft] = useState<AccountDraft>(() => draftFrom(account));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // Crypto is priced in dollars while capital is rupees: the rate between them is a setting of its own (not part of the account), kept by hand.
  const [rate, setRate] = useState("");
  const [savedRate, setSavedRate] = useState<number | null>(null);
  const [rateLoaded, setRateLoaded] = useState(false);

  // A different segment (or a saved value coming back) replaces the form's starting point.
  useEffect(() => {
    setDraft(draftFrom(account));
    setAttempted(false);
  }, [account]);
  // The "Saved." note must survive the refresh that follows a save, so it is only cleared
  // when the person moves to another segment.
  useEffect(() => setMessage(null), [account.segment]);

  useEffect(() => {
    if (account.segment !== "CRYPTO") return;
    let live = true;
    getUsdInr()
      .then((r) => {
        if (!live) return;
        setSavedRate(r);
        setRate(r == null ? "" : String(r));
        setRateLoaded(true);
      })
      .catch(() => live && setRateLoaded(true));
    return () => {
      live = false;
    };
  }, [account.segment]);

  const set = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  // "Changed" compares the form to what was loaded, not the patch: an invalid value produces no
  // patch, and Save must stay usable then so the person is told what is wrong.
  const { errors: live } = buildAccountPatch(account, draft);
  const errors: DraftErrors = attempted ? live : {};
  const seg = account.segment;
  const rateErrorLive = seg === "CRYPTO" && rateLoaded && (rate.trim() !== "" || savedRate == null) ? parseUsdInr(rate).error : null;
  const rateChanged = seg === "CRYPTO" && rateLoaded && rate.trim() !== "" && Number(rate) !== savedRate;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(account)) || rateChanged;

  async function save() {
    const { patch, errors } = buildAccountPatch(account, draft);
    setAttempted(true);
    if (hasErrors(errors) || (seg === "CRYPTO" && rateChanged && parseUsdInr(rate).error)) return;
    setBusy(true);
    setMessage(null);
    try {
      if (Object.keys(patch).length > 0) await updateAccount(seg, patch, book);
      if (seg === "CRYPTO" && rateChanged) {
        const saved = await saveUsdInr(parseUsdInr(rate).rate as number);
        setSavedRate(saved.usdinr_rate);
      }
      setMessage({ kind: "ok", text: "Saved." });
      onSaved();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Could not save. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <h2 className="section-title" style={{ margin: "0 0 12px" }}>
          Sizing
        </h2>
        <TextField id={`${seg}-capital`} label="Capital per trade" suffix="₹" value={draft.capital_per_trade} onChange={(v) => set("capital_per_trade", v)} error={errors.capital_per_trade} hint="How much money goes into one trade. The number of shares or lots follows from it." />
        <TextField id={`${seg}-risk`} label="Risk per trade" suffix="%" value={draft.risk_per_trade_pct} onChange={(v) => set("risk_per_trade_pct", v)} error={errors.risk_per_trade_pct} hint="The share of your account you are willing to lose if the stop-loss is hit." />
        <ToggleField id={`${seg}-lots`} label="Size trades by risk" hint="Work out the quantity from your stop-loss and risk per trade, instead of capital per trade." checked={draft.enforce_risk_based_lots} onChange={(v) => set("enforce_risk_based_lots", v)} />
        <TextField id={`${seg}-rr`} label="Smallest reward-to-risk ratio" value={draft.min_reward_risk_ratio} onChange={(v) => set("min_reward_risk_ratio", v)} error={errors.min_reward_risk_ratio} hint="A trade whose target is less than this many times its risk is flagged. 2 means the target is at least twice the stop distance." />
      </div>

      {seg === "CRYPTO" && (
        <div className="card">
          <h2 className="section-title" style={{ margin: "0 0 12px" }}>
            Dollars and leverage
          </h2>
          <TextField id="CRYPTO-usdinr" label="Rupees per US dollar" suffix="₹" inputMode="decimal" value={rate} onChange={setRate} error={attempted || rate.trim() !== "" ? rateErrorLive ?? undefined : undefined} placeholder={rateLoaded ? "Not set" : "Loading…"} hint={savedRate == null && rateLoaded ? "Not set yet: crypto orders are refused until it is. Crypto is priced in dollars and your capital is in rupees; this is the rate between them. It is kept by hand, so update it when the dollar moves." : "Crypto is priced in dollars and your capital is in rupees; this is the rate between them. It is kept by hand, so update it when the dollar moves. A closed trade keeps the rate it closed at."} />
          <TextField id="CRYPTO-leverage" label="Leverage" suffix="×" inputMode="decimal" value={draft.leverage} onChange={(v) => set("leverage", v)} error={errors.leverage} hint="Your capital per trade is the margin; leverage multiplies how much it buys. At 5×, ₹10,000 buys about ₹50,000 of crypto. A move against you of about 1 ÷ leverage (less a small margin) liquidates the trade and loses the whole margin." />
        </div>
      )}

      <div className="card">
        <h2 className="section-title" style={{ margin: "0 0 12px" }}>
          Safety limits
        </h2>
        {!positional && <TextField id={`${seg}-loss`} label="Daily loss limit" suffix="₹" value={draft.max_daily_loss} onChange={(v) => set("max_daily_loss", v)} error={errors.max_daily_loss} placeholder="No limit" hint="Shown as a meter on Today. Leave blank for no limit." />}
        <ToggleField id={`${seg}-sl`} label="Require a stop-loss on every order" hint="An order without a stop-loss is refused." checked={draft.require_stop_loss} onChange={(v) => set("require_stop_loss", v)} />
        {!positional && <TextField id={`${seg}-sqoff`} label="Square off open trades at" inputMode="text" value={draft.square_off_time} onChange={(v) => set("square_off_time", v)} error={errors.square_off_time} placeholder="Never" hint={seg === "CRYPTO" ? "Crypto trades all day, so this is usually left blank." : "24-hour time, for example 15:15. Intraday trades still open then are closed for you."} />}
      </div>

      <div className="card">
        <h2 className="section-title" style={{ margin: "0 0 12px" }}>
          Realistic costs
        </h2>
        {seg !== "CRYPTO" && (
          <ToggleField id={`${seg}-charges`} label="Include brokerage, taxes and charges" hint="Deducts the costs a real trade would pay, so paper results are honest. Needed for the live-trading track record." checked={draft.apply_charges} onChange={(v) => set("apply_charges", v)} />
        )}
        <TextField id={`${seg}-slip`} label="Slippage" suffix="bps" value={draft.slippage_bps} onChange={(v) => set("slippage_bps", v)} error={errors.slippage_bps} hint="How much worse than the quoted price a market order fills, in hundredths of a percent. 3 is a sensible floor." />
      </div>

      {message && (
        <div className={message.kind === "error" ? "notice error" : "notice"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft(draftFrom(account))}>
          Discard changes
        </button>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>

      <ResetCard account={account} onSaved={onSaved} book={book} />
    </div>
  );
}

/** Starting over. Resetting also starts a new equity curve, and the live-trading track record
 * counts from it, so it is guarded by typing a word and says so plainly. */
function ResetCard({ account, onSaved, book }: { account: Account; onSaved: () => void; book: Book }) {
  const [amount, setAmount] = useState(String(account.starting_balance));
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => setAmount(String(account.starting_balance)), [account.segment, account.starting_balance]);
  // "Account reset." must survive the refresh that follows it; only a segment change clears it.
  useEffect(() => {
    setWord("");
    setError(null);
    setDone(false);
  }, [account.segment]);

  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0;

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      // A new amount re-baselines the account (and starts the new curve) in one call; the same
      // amount is a plain reset.
      if (n !== account.starting_balance) await updateAccount(account.segment, { starting_balance: n }, book);
      else await resetAccount(account.segment, book);
      setWord("");
      setDone(true);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reset. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: "var(--dn)" }}>
      <h2 className="section-title" style={{ margin: "0 0 8px", color: "var(--dn)" }}>
        Start over
      </h2>
      <p style={{ marginTop: 0 }}>
        Sets your paper balance back to {formatInr(n > 0 && Number.isFinite(n) ? n : account.starting_balance)} and starts a new equity curve. Your open trades and history stay. {book === "positional" ? "" : " The live-trading track record counts from the new start."}
      </p>
      <TextField id={`${account.segment}-start`} label="Starting balance" suffix="₹" value={amount} onChange={setAmount} error={valid ? undefined : "Enter an amount above 0."} />
      <TextField id={`${account.segment}-resetword`} label='Type RESET to confirm' inputMode="text" value={word} onChange={setWord} />
      {error && (
        <div className="notice error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {done && (
        <div className="notice" role="status" style={{ marginBottom: 12 }}>
          Account reset.
        </div>
      )}
      <button className="btn btn-danger" disabled={busy || !valid || word !== "RESET"} onClick={() => void reset()}>
        {busy ? "Resetting…" : "Reset account"}
      </button>
    </div>
  );
}
