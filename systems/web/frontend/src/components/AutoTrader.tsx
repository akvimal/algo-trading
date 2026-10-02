import { useEffect, useMemo, useRef, useState } from "react";
import { armAutoTrader, loadAutoTrader, loadAutoTraderTrades, pauseAutoTrader, removeAutoTrader } from "../api/autotrade";
import type { Segment } from "../api/types";
import {
  DEFAULT_CONFIG, INTERVAL_CHOICES, MONEYNESS_CHOICES, cleanConfig, configFromServer, isHhmm, optionEligible, sameConfig, summarise, validateConfig,
  type AutoConfig, type AutoInterval, type Moneyness,
} from "../autotrader/model";
import { tradeRows } from "../autotrader/trades";
import { formatDay, formatInr, formatPnl, formatTime } from "../format";
import { useResource } from "../hooks/useResource";
import { ErrorNotice, Signed } from "./bits";
import { TextField } from "./Field";

const DRAFT_KEY = "web.autotrader.draft";
const POLL_MS = 20_000;

const loadDraft = (): AutoConfig => {
  try {
    return cleanConfig(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
};
const saveDraft = (c: AutoConfig) => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(c));
  } catch {
    // storage is optional: the setting simply is not remembered
  }
};

type Text = { period: string; multiplier: string; lots: string; balance: string };
const textOf = (c: AutoConfig): Text => ({ period: String(c.period), multiplier: String(c.multiplier), lots: String(c.lots), balance: String(c.balance) });

type Confirm = "on" | "apply" | "remove" | null;

/** The intraday auto-trader for the instrument on the chart. It is a strategy on the server: it watches a
 * SuperTrend on the interval chosen, trades a future (or a naked option) each time it flips, with the
 * SuperTrend line as a trailing stop, and reverses on the next flip. Because it runs there and not in this
 * page, it keeps going with the page closed. It trades its own practice account, never the person's own. */
export function AutoTrader({ segment, symbol, contracts }: { segment: Segment; symbol: string; contracts: boolean }) {
  if (!contracts) {
    return (
      <section className="card auto-trader" aria-label="Auto-trader">
        <h2 className="section-title">Auto-trader</h2>
        <p className="faint" style={{ margin: 0 }}>
          The auto-trader trades contracts, so it is available for an index, gold, crude, Bitcoin or Ether. A stock is traded as shares, which it does not do.
        </p>
      </section>
    );
  }
  return <AutoTraderCard segment={segment} symbol={symbol} />;
}

function AutoTraderCard({ segment, symbol }: { segment: Segment; symbol: string }) {
  const state = useResource(() => loadAutoTrader(segment, symbol), [segment, symbol], { pollMs: POLL_MS });
  const strategy = state.data?.strategy ?? null;
  const account = state.data?.account ?? null;
  const trades = useResource(() => loadAutoTraderTrades(strategy!.id), [strategy?.id], { pollMs: POLL_MS, enabled: strategy != null });

  const [draft, setDraft] = useState<AutoConfig>(loadDraft);
  const [text, setText] = useState<Text>(() => textOf(draft));
  const [showSettings, setShowSettings] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The form shows what the server is really running the first time it is known for this instrument,
  // not a stale draft.
  const hydrated = useRef("");
  const serverConfig = useMemo(
    () => (state.data ? configFromServer(state.data.strategy, state.data.rule, state.data.account?.starting_balance ?? null) : null),
    [state.data],
  );
  useEffect(() => {
    const key = `${segment}:${symbol}`;
    if (serverConfig && hydrated.current !== key) {
      hydrated.current = key;
      setDraft(serverConfig);
      setText(textOf(serverConfig));
    }
  }, [serverConfig, segment, symbol]);
  useEffect(() => {
    setError(null);
    setConfirm(null);
  }, [segment, symbol]);

  const config: AutoConfig = { ...draft, period: Number(text.period), multiplier: Number(text.multiplier), lots: Number(text.lots), balance: Number(text.balance) };
  const change = (patch: Partial<AutoConfig>) =>
    setDraft((d) => {
      const next = { ...d, ...patch };
      saveDraft(cleanConfig({ ...next, period: Number(text.period), multiplier: Number(text.multiplier), lots: Number(text.lots), balance: Number(text.balance) }));
      return next;
    });
  const changeText = (patch: Partial<Text>) => {
    const next = { ...text, ...patch };
    setText(next);
    saveDraft(cleanConfig({ ...draft, period: Number(next.period), multiplier: Number(next.multiplier), lots: Number(next.lots), balance: Number(next.balance) }));
  };

  const armed = strategy?.status === "live";
  const changed = armed && serverConfig != null && !sameConfig(config, serverConfig);
  const instrument = optionEligible(segment, symbol) ? config.instrument : "future";
  const effective: AutoConfig = { ...config, instrument };

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      state.reload();
      trades.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  function askToTurnOn(kind: "on" | "apply") {
    const problems = validateConfig(effective);
    if (problems.length) {
      setError(problems.join(" "));
      setShowSettings(true);
      return;
    }
    setError(null);
    setConfirm(kind);
  }

  const rows = tradeRows(trades.data?.positions ?? [], trades.data?.groups ?? []);
  const statusWord = armed ? "On" : strategy ? "Off (paused)" : "Off";
  const windowIssue = (w: { start: string; end: string }) => !isHhmm(w.start) || !isHhmm(w.end) || w.end <= w.start;

  return (
    <section className="card auto-trader" aria-label="Auto-trader" data-testid="auto-trader">
      <div className="auto-head">
        <h2 className="section-title" style={{ margin: 0 }}>
          Auto-trader · {symbol}
        </h2>
        <span className={`pill ${armed ? "up" : ""}`} data-testid="auto-status">
          {statusWord}
        </span>
        <span className="auto-actions">
          {armed && (
            <button className="btn btn-small" disabled={busy} onClick={() => void run(() => pauseAutoTrader(strategy!.id))}>
              Turn off
            </button>
          )}
          {armed && changed && (
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => askToTurnOn("apply")}>
              Apply changes
            </button>
          )}
          {!armed && (
            <button className="btn btn-small btn-primary" disabled={busy || state.loading} onClick={() => askToTurnOn("on")}>
              Turn on
            </button>
          )}
        </span>
      </div>
      <p className="faint" style={{ margin: "6px 0 0" }} data-testid="auto-summary">
        {summarise(effective)}
      </p>

      {confirm && confirm !== "remove" && (
        <div className="notice" role="alertdialog" aria-label="Confirm auto-trader" data-testid="auto-confirm">
          <p style={{ margin: "0 0 8px" }}>
            {confirm === "apply" ? "Apply these changes? " : `Turn on auto-trading for ${symbol}? `}
            It enters the current trend straight away, then trades every flip after that, using practice money
            {account ? ` in its own account (₹${Math.round(account.current_balance).toLocaleString("en-IN")} now)` : ` (${formatInr(config.balance)} in its own new account)`}. It keeps going with this page closed.
          </p>
          <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void run(() => armAutoTrader(segment, symbol, effective))}>
            {confirm === "apply" ? "Apply" : "Turn on"}
          </button>{" "}
          <button className="btn btn-small" disabled={busy} onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <div className="notice error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      <button className="link-btn" style={{ marginTop: 8 }} aria-expanded={showSettings} onClick={() => setShowSettings((s) => !s)}>
        {showSettings ? "Hide settings" : "Settings"}
      </button>

      {showSettings && (
        <div className="auto-settings" data-testid="auto-settings">
          <div className="field">
            <label htmlFor="at-instrument">What it trades</label>
            <select id="at-instrument" value={instrument} disabled={busy} onChange={(e) => change({ instrument: e.target.value === "option" ? "option" : "future" })}>
              <option value="future">A future</option>
              <option value="option" disabled={!optionEligible(segment, symbol)}>
                A naked option (call when it turns up, put when it turns down)
              </option>
            </select>
          </div>
          {instrument === "option" && (
            <div className="field">
              <label htmlFor="at-strike">Strike</label>
              <select id="at-strike" value={config.moneyness} disabled={busy} onChange={(e) => change({ moneyness: e.target.value as Moneyness })}>
                {MONEYNESS_CHOICES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="at-interval">Interval</label>
            <select id="at-interval" value={config.interval} disabled={busy} onChange={(e) => change({ interval: e.target.value as AutoInterval })}>
              {INTERVAL_CHOICES.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>
          <TextField id="at-period" label="Average range (candles)" value={text.period} onChange={(v) => changeText({ period: v })} inputMode="numeric" hint="SuperTrend's ATR period." />
          <TextField id="at-mult" label="Multiplier" value={text.multiplier} onChange={(v) => changeText({ multiplier: v })} hint="Wider means fewer, later flips." />
          <TextField id="at-lots" label="Lots per trade" value={text.lots} onChange={(v) => changeText({ lots: v })} inputMode="numeric" />
          <TextField
            id="at-balance"
            label="Practice money"
            value={account ? String(Math.round(account.starting_balance)) : text.balance}
            onChange={(v) => changeText({ balance: v })}
            inputMode="numeric"
            suffix="₹"
            hint={account ? "Set when it was first turned on." : "Its own paper account, apart from yours. Set once, when it is first turned on."}
          />
          <label className="check">
            <input type="checkbox" checked={config.adxGate} disabled={busy} onChange={(e) => change({ adxGate: e.target.checked })} />
            <span>Only trade a flip when the trend strength (ADX) agrees with it</span>
          </label>
          <fieldset className="auto-windows">
            <legend>Only trade between these times (India time)</legend>
            {config.windows.length === 0 && <p className="faint" style={{ margin: "0 0 6px" }}>No limit: it trades a flip at any time the market is open.</p>}
            {config.windows.map((w, i) => (
              <div key={i} className="auto-window-row">
                <input aria-label={`Window ${i + 1} start`} type="time" value={w.start} disabled={busy} onChange={(e) => change({ windows: config.windows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
                <span>to</span>
                <input aria-label={`Window ${i + 1} end`} type="time" value={w.end} disabled={busy} onChange={(e) => change({ windows: config.windows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
                <button className="link-btn" disabled={busy} onClick={() => change({ windows: config.windows.filter((_, j) => j !== i) })}>
                  Remove
                </button>
                {windowIssue(w) && <span className="error-text">Ends before it starts</span>}
              </div>
            ))}
            <button className="link-btn" disabled={busy} onClick={() => change({ windows: [...config.windows, { start: "09:15", end: "15:15" }] })}>
              Add a window
            </button>
          </fieldset>
        </div>
      )}

      {state.error && !state.data && (
        <div style={{ marginTop: 8 }}>
          <ErrorNotice error={state.error} onRetry={state.reload} />
        </div>
      )}

      {strategy && (
        <div className="auto-results" data-testid="auto-results">
          <p className="faint" style={{ margin: "8px 0 4px" }}>
            {armed ? "Watching" : "Not watching"}
            {strategy.last_scan_at ? ` · last checked ${formatDay(strategy.last_scan_at)} ${formatTime(strategy.last_scan_at)}` : " · not checked yet"}
          </p>
          {account && (
            <p style={{ margin: "0 0 6px" }} data-testid="auto-account">
              Practice account: <strong className="num">{formatInr(account.current_balance)}</strong> (started with {formatInr(account.starting_balance)}) · booked{" "}
              <Signed value={account.realized_pnl} text={formatPnl(account.realized_pnl)} /> · open <Signed value={account.unrealized_pnl} text={formatPnl(account.unrealized_pnl)} />
            </p>
          )}
          {rows.length > 0 ? (
            <div data-testid="auto-trades">
              {rows.map((r) => (
                <div className="list-row" key={r.id}>
                  <span>
                    <span className={`pill ${r.side === "BUY" ? "up" : "dn"}`}>{r.side}</span> {r.label}
                    <span className="faint" style={{ display: "block", fontSize: 12 }}>
                      {r.state === "open" ? "open" : `closed${r.reason ? ` · ${r.reason.replace(/_/g, " ")}` : ""}`} · {formatDay(r.when)} {formatTime(r.when)}
                    </span>
                  </span>
                  <Signed value={r.pnl} text={formatPnl(r.pnl)} />
                </div>
              ))}
            </div>
          ) : (
            !trades.loading && <p className="faint" style={{ margin: 0 }}>No trades yet.</p>
          )}
        </div>
      )}

      <p className="faint auto-note">
        It runs on the server, so it keeps trading with this page closed, and trades its own practice money, apart from your account: it does not change your balance,
        your track record or your discipline score. Turning it off stops new entries; a trade already open keeps its stop and closes at square-off time.
      </p>

      {strategy &&
        (confirm === "remove" ? (
          <p style={{ margin: "6px 0 0" }} role="alertdialog" aria-label="Confirm remove" data-testid="auto-remove-confirm">
            Remove this auto-trader and its settings? Trades it has made stay in its practice account.{" "}
            <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void run(() => removeAutoTrader(segment, symbol, strategy.id))}>
              Remove
            </button>{" "}
            <button className="btn btn-small" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </p>
        ) : (
          <button className="link-btn" style={{ marginTop: 6 }} disabled={busy} onClick={() => setConfirm("remove")}>
            Remove auto-trader
          </button>
        ))}
    </section>
  );
}
