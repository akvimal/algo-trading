import { useState } from "react";
import { BackLink } from "../components/nav";
import { ApiError, api } from "../api/http";
import { ErrorNotice, Skeleton } from "../components/bits";
import { useResource } from "../hooks/useResource";

type Holiday = { date: string; name: string; nse: string; mcx: string; detail: string | null; source: "built_in" | "admin" };
type Holidays = { holidays: Holiday[]; covered_through: string; stale: boolean; warning: string | null };

const NSE_LABEL: Record<string, string> = { closed: "Closed", special: "Special session", open: "Open (not a holiday)" };
const MCX_LABEL: Record<string, string> = { closed: "Closed", morning_closed: "Morning closed", special: "Special session", open: "Open (not a holiday)" };

export function HolidaysPage() {
  const data = useResource(() => api<Holidays>("marketData", "/holidays"), []);
  const [form, setForm] = useState({ date: "", name: "", nse: "closed", mcx: "closed" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = data.data?.holidays ?? [];

  async function save(h: { date: string; name: string; nse: string; mcx: string }) {
    setSaving(true);
    setError(null);
    try {
      await api(`marketData`, `/holidays/${h.date}`, { method: "PUT", json: { name: h.name, nse: h.nse, mcx: h.mcx } });
      setForm({ date: "", name: "", nse: "closed", mcx: "closed" });
      data.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(date: string) {
    setError(null);
    try {
      await api("marketData", `/holidays/${date}`, { method: "DELETE" });
      data.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not remove it. Try again.");
    }
  }

  const canSave = /^\d{4}-\d{2}-\d{2}$/.test(form.date) && form.name.trim().length > 0 && !saving;

  return (
    <div className="stack">
      <BackLink to="/more" />
      <h1>Exchange holidays</h1>
      <p className="dim" style={{ margin: 0 }}>
        Days the nightly OI snapshot skips and the Calendar tab marks as closed. The built-in list is checked against NSE's circular; anything you add or change here wins over it.
      </p>
      {data.loading && <Skeleton lines={5} />}
      {data.error && <ErrorNotice error={data.error} onRetry={data.reload} />}
      {data.data?.warning && (
        <div className="notice" role="status">
          {data.data.warning}
        </div>
      )}
      {data.data && <p className="dim" style={{ margin: 0 }}>Covered through {data.data.covered_through}.</p>}
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save(form);
        }}
      >
        <strong>Add or change a holiday</strong>
        <div className="field-row">
          <label className="field">
            <span>Date</span>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </label>
          <label className="field">
            <span>Name</span>
            <input type="text" value={form.name} placeholder="e.g. Diwali" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>NSE</span>
            <select value={form.nse} onChange={(e) => setForm({ ...form, nse: e.target.value })}>
              {Object.entries(NSE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>MCX</span>
            <select value={form.mcx} onChange={(e) => setForm({ ...form, mcx: e.target.value })}>
              {Object.entries(MCX_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className="notice" role="alert">{error}</div>}
        <button type="submit" disabled={!canSave}>{saving ? "Saving…" : "Save holiday"}</button>
      </form>
      <div className="stack" data-testid="holiday-list">
        {list.map((h) => (
          <div className="card" key={h.date} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div>
              <strong>{h.date}</strong> · {h.name}
              <div className="dim">NSE: {NSE_LABEL[h.nse] ?? h.nse} · MCX: {MCX_LABEL[h.mcx] ?? h.mcx} · {h.source === "admin" ? "added here" : "built in"}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="link-btn" onClick={() => setForm({ date: h.date, name: h.name, nse: h.nse, mcx: h.mcx })}>Edit</button>
              {h.source === "admin" && (
                <button className="link-btn" onClick={() => void remove(h.date)}>Remove</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
