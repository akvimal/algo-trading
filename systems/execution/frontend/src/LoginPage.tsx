import { FormEvent, useState } from "react";
import { login, setAuthEmail, setAuthToken, signup } from "./auth";

export default function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const token = mode === "login" ? await login(email, password) : await signup(name, email, password);
      setAuthToken(token);
      setAuthEmail(email);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${mode}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>{mode === "login" ? "Log in" : "Sign up"}</h1>
        {/* Login-only accounts already have a name from when they signed
            up - only a fresh signup needs to collect one, shown in the
            shell's own top-bar user area afterward (see shell/index.html). */}
        {mode === "signup" && (
          <label>
            Name
            <input type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label>
          Email
          <input type="email" required autoFocus={mode === "login"} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting || !email || !password || (mode === "signup" && !name.trim())}>
          {submitting ? "..." : mode === "login" ? "Log in" : "Sign up"}
        </button>
        <button
          type="button"
          className="login-toggle"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Log in"}
        </button>
      </form>
    </div>
  );
}
