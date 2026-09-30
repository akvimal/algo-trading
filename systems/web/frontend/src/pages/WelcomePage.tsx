import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/http";
import { checkLiveData, saveCredentials, updateAccount } from "../api/settings";
import type { Segment } from "../api/types";
import { useProfile } from "../auth/ProfileContext";
import { TextField } from "../components/Field";
import { formatInr } from "../format";
import {
  BACKGROUNDS, CAPITAL_PRESETS, SEGMENT_CHOICES, accountPatch, deriveRules, parseCapital, suggestExperience,
  type Background, type Experience,
} from "./onboardingModel";
import { buildCredentialsPatch } from "./settingsModel";

const TOTAL = 3;
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

/** First-run setup, three short steps: how you want the app to feel, your practice account, and live
 * prices. Every step can be skipped and everything chosen here can be changed later in Settings. */
export function WelcomePage() {
  const navigate = useNavigate();
  const { profile, update } = useProfile();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await update({ onboarded: true });
      navigate("/", { replace: true });
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  }

  const first = profile?.name?.trim().split(/\s+/)[0];

  return (
    <main className="signin" style={{ maxWidth: 560 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="dim" aria-live="polite">
          Step {step} of {TOTAL}
        </span>
        <button className="btn btn-small" style={{ border: 0, background: "none", color: "var(--text-dim)" }} disabled={busy} onClick={() => void finish()}>
          Skip setup
        </button>
      </div>
      <div className="bar" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={TOTAL} aria-valuenow={step} style={{ marginBottom: 20 }}>
        <i style={{ width: `${(step / TOTAL) * 100}%` }} />
      </div>
      <h1 style={{ marginBottom: 4 }}>{step === 1 ? `Welcome${first ? `, ${first}` : ""}` : step === 2 ? "Your practice account" : "Live prices"}</h1>

      {error && (
        <div className="notice error" role="alert" style={{ margin: "12px 0" }}>
          {error}
        </div>
      )}

      {step === 1 && <ExperienceStep onDone={() => { setError(null); setStep(2); }} onError={setError} />}
      {step === 2 && <AccountStep onBack={() => setStep(1)} onDone={() => { setError(null); setStep(3); }} onError={setError} />}
      {step === 3 && <PricesStep onBack={() => setStep(2)} onFinish={() => void finish()} busy={busy} />}
    </main>
  );
}

function ExperienceStep({ onDone, onError }: { onDone: () => void; onError: (m: string | null) => void }) {
  const { profile, update } = useProfile();
  const [background, setBackground] = useState<Background | null>(null);
  const [choice, setChoice] = useState<Experience>(profile?.experience ?? "guided");
  const [busy, setBusy] = useState(false);

  function pick(b: Background) {
    setBackground(b);
    setChoice(suggestExperience(b)); // a suggestion: the choice below can still be changed
  }

  async function next() {
    setBusy(true);
    onError(null);
    try {
      await update({ experience: choice });
      onDone();
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>
        You will practise with virtual money and real market prices first. Nothing here places a real order.
      </p>
      <h2 className="section-title">How much have you traded before?</h2>
      <div className="stack" role="radiogroup" aria-label="How much have you traded before?">
        {BACKGROUNDS.map((b) => (
          <button key={b.id} className="choice" role="radio" aria-checked={background === b.id} onClick={() => pick(b.id)}>
            <strong>{b.title}</strong>
            <span className="dim">{b.body}</span>
          </button>
        ))}
      </div>
      <h2 className="section-title">Your starting view</h2>
      {background && (
        <p className="dim" style={{ margin: 0 }}>
          We suggest {suggestExperience(background) === "guided" ? "Guided" : "Pro"}. You can change it any time in More.
        </p>
      )}
      <div className="stack" role="radiogroup" aria-label="Your starting view">
        <button className="choice" role="radio" aria-checked={choice === "guided"} onClick={() => setChoice("guided")}>
          <strong>Guided</strong>
          <span className="dim">Plain-English hints next to every number, a plan-first ticket and a first-week checklist.</span>
        </button>
        <button className="choice" role="radio" aria-checked={choice === "pro"} onClick={() => setChoice("pro")}>
          <strong>Pro</strong>
          <span className="dim">Fewer hints and no checklist. For people who already trade with a plan.</span>
        </button>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={() => void next()}>
        {busy ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}

function AccountStep({ onBack, onDone, onError }: { onBack: () => void; onDone: () => void; onError: (m: string | null) => void }) {
  const [preset, setPreset] = useState<number | "custom">(500_000);
  const [custom, setCustom] = useState("");
  const [segments, setSegments] = useState<Segment[]>(["NSE"]);
  const { update } = useProfile();
  const [busy, setBusy] = useState(false);

  const capital = preset === "custom" ? parseCapital(custom) : preset;
  const rules = capital ? deriveRules(capital) : null;

  const toggle = (s: Segment) => setSegments((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  async function create() {
    if (!capital || !rules || segments.length === 0) return;
    setBusy(true);
    onError(null);
    try {
      for (const seg of segments) await updateAccount(seg, accountPatch(seg, capital, rules));
      // Remember which markets were chosen: every market has an account row, and only these count.
      await update({ markets: segments });
      onDone();
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>
        Virtual money, real market prices, realistic costs. It is not real, and you can reset it any time in Settings.
      </p>
      <h2 className="section-title">Starting capital</h2>
      <div className="chips" role="radiogroup" aria-label="Starting capital">
        {CAPITAL_PRESETS.map((c) => (
          <button key={c} role="radio" aria-checked={preset === c} onClick={() => setPreset(c)}>
            {formatInr(c)}
          </button>
        ))}
        <button role="radio" aria-checked={preset === "custom"} onClick={() => setPreset("custom")}>
          Another amount
        </button>
      </div>
      {preset === "custom" && (
        <TextField id="w-capital" label="Amount" suffix="₹" value={custom} onChange={setCustom} error={custom && !capital ? "Enter a whole amount from ₹10,000 to ₹10,00,00,000." : undefined} />
      )}

      <h2 className="section-title">What do you want to practise?</h2>
      <div className="stack">
        {SEGMENT_CHOICES.map((s) => (
          <label key={s.id} className="check choice-check">
            <input type="checkbox" checked={segments.includes(s.id)} onChange={() => toggle(s.id)} />
            <span>
              <strong style={{ color: "var(--text)" }}>{s.title}</strong>
              <span className="faint" style={{ display: "block", fontSize: 12 }}>
                {s.note}
              </span>
            </span>
          </label>
        ))}
      </div>
      {segments.length === 0 && (
        <p className="dn" role="alert" style={{ margin: 0 }}>
          Pick at least one.
        </p>
      )}

      <p style={{ margin: "4px 0" }}>
        <strong>Realistic costs, always on.</strong> <span className="dim">Brokerage, taxes and charges, plus a little slippage on every fill, so your practice results are honest.</span>
      </p>

      {rules && (
        <div className="card">
          <strong>Your starting rules</strong>
          <p className="faint" style={{ margin: "2px 0 8px", fontSize: 12 }}>
            Worked out from your capital. The ticket uses them from your first order. You can change every one later.
          </p>
          <dl className="summary" data-testid="rules" style={{ margin: 0 }}>
            <div>
              <dt>Money in one trade</dt>
              <dd className="num">{formatInr(rules.capitalPerTrade)}</dd>
            </div>
            <div>
              <dt>Most you risk on a trade</dt>
              <dd className="num">{rules.riskPct}% ({formatInr((capital! * rules.riskPct) / 100)})</dd>
            </div>
            <div>
              <dt>Daily loss limit</dt>
              <dd className="num">{formatInr(rules.dailyLossLimit)}</dd>
            </div>
            <div>
              <dt>Smallest reward-to-risk</dt>
              <dd className="num">{rules.minRewardRisk} to 1</dd>
            </div>
            <div>
              <dt>Stop-loss on every order</dt>
              <dd>Required</dd>
            </div>
          </dl>
        </div>
      )}

      <div className="row">
        <button className="btn" disabled={busy} onClick={onBack}>
          Back
        </button>
        <button className="btn btn-primary" disabled={busy || !rules || segments.length === 0} onClick={() => void create()}>
          {busy ? "Creating…" : "Create my practice account"}
        </button>
      </div>
    </div>
  );
}

function PricesStep({ onBack, onFinish, busy }: { onBack: () => void; onFinish: () => void; busy: boolean }) {
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [connected, setConnected] = useState(false);

  async function connect() {
    const { patch, error } = buildCredentialsPatch({ dhan_client_id: clientId, dhan_access_token: token }, null);
    if (error) return setResult({ kind: "error", text: error });
    setWorking(true);
    setResult(null);
    try {
      await saveCredentials(patch);
      setClientId("");
      setToken("");
      const q = await checkLiveData();
      setConnected(true);
      setResult({ kind: "ok", text: `Connected. Live prices are working: ${q.symbol} is ${formatInr(q.ltp, 2)}.` });
    } catch (e) {
      setResult({ kind: "error", text: msg(e) });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>
        Live prices, charts and practice orders use your own Dhan account, so the prices are yours and free of a shared limit. Your keys are stored encrypted and never shown again.
      </p>
      <div className="card">
        <strong>How to get them</strong>
        <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          <li>Open your Dhan account (you need one to trade on Dhan).</li>
          <li>Find the API or DhanHQ section and generate an access token.</li>
          <li>Copy your client ID and the token into the boxes below.</li>
        </ol>
        <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
          The token lasts 24 hours. When prices stop, paste a fresh one in Settings.
        </p>
      </div>
      <TextField id="w-client" label="Dhan client ID" inputMode="text" value={clientId} onChange={setClientId} />
      <TextField id="w-token" label="Access token" type="password" inputMode="text" value={token} onChange={setToken} />
      {result && (
        <div className={result.kind === "error" ? "notice error" : "notice"} role={result.kind === "error" ? "alert" : "status"}>
          {result.text}
        </div>
      )}
      {!connected && (
        <button className="btn btn-primary" disabled={working || busy || (!clientId.trim() && !token.trim())} onClick={() => void connect()}>
          {working ? "Checking…" : "Connect and check"}
        </button>
      )}
      <div className="card" style={{ background: "var(--surface-2)" }}>
        <strong>Skip for now?</strong>
        <p className="dim" style={{ margin: "4px 0 0" }}>
          You can. Scan (end-of-day) works without keys. Live prices, charts and placing practice orders need them, and you can add them any time in Settings.
        </p>
      </div>
      <div className="row">
        <button className="btn" disabled={busy || working} onClick={onBack}>
          Back
        </button>
        <button className={connected ? "btn btn-primary" : "btn"} disabled={busy || working} onClick={onFinish}>
          {busy ? "Finishing…" : connected ? "Finish" : "Skip and finish"}
        </button>
      </div>
    </div>
  );
}
