import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ApiError } from "../api/http";
import { useAuth } from "../auth/AuthContext";

// Keep in step with systems/execution/frontend/src/auth.ts RISK_DISCLOSURE_TEXT and the
// version in systems/accounts/backend/app/domain/risk_ack.py. Placeholder wording pending
// the legal review in docs/redesign-rollout-plan.md.
export const RISK_DISCLOSURE_TEXT =
  "I understand that trading stocks, futures, options and crypto can lose money, including more than I put in. " +
  "This platform is a paper-trading and analysis tool, and nothing on it is investment advice or a recommendation. " +
  "Results on paper do not predict live results, and I am solely responsible for any trade I place with real money.";

export function SignInPage() {
  const { session, signIn, signUp } = useAuth();
  const location = useLocation();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "in") await signIn(email.trim(), password);
      else await signUp({ name: name.trim(), email: email.trim(), password, acceptRisk });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <h1 style={{ marginBottom: 4 }}>{mode === "in" ? "Sign in" : "Create your account"}</h1>
      <p className="dim" style={{ marginTop: 0 }}>
        Practice trading with paper money first. Nothing here places a real order unless you turn it on yourself.
      </p>
      <form onSubmit={submit} className="card" noValidate>
        {mode === "up" && (
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            minLength={mode === "up" ? 8 : undefined}
            required
          />
        </label>
        {mode === "up" && (
          <label className="check">
            <input type="checkbox" checked={acceptRisk} onChange={(e) => setAcceptRisk(e.target.checked)} />
            <span>{RISK_DISCLOSURE_TEXT}</span>
          </label>
        )}
        {error && (
          <div className="notice error" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <button
          className="btn btn-primary"
          style={{ width: "100%" }}
          type="submit"
          disabled={busy || !email || !password || (mode === "up" && (!name || !acceptRisk || password.length < 8))}
        >
          {busy ? "Please wait…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
      </form>
      <p style={{ textAlign: "center" }}>
        <button
          className="btn btn-small"
          style={{ border: 0, background: "none", color: "var(--accent)" }}
          onClick={() => {
            setMode(mode === "in" ? "up" : "in");
            setError(null);
          }}
        >
          {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
      </p>
    </main>
  );
}
