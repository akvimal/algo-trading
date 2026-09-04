import { useEffect, useState } from "react";

import {
  type PriceAlert,
  createPriceAlert,
  deletePriceAlert,
  fetchPriceAlerts,
  fetchTelegramStatus,
  testTelegramAlert,
} from "./api";

// Standalone price alerts - independent of the Live Chart's browser-only
// drawing-line alerts (see docs/architecture.md § "Price alerts +
// Telegram"). market-data's scheduler polls the LTP for every active row
// here once a minute and pushes a Telegram message on a crossing, so an
// alert fires even with every tab closed.

const EXCHANGES = ["NSE", "MCX", "CRYPTO"];
const DIRECTIONS: { value: PriceAlert["direction"]; label: string }[] = [
  { value: "above", label: "crosses above" },
  { value: "below", label: "crosses below" },
  { value: "cross", label: "crosses (either way)" },
];

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function PriceAlertsPage() {
  const [alerts, setAlerts] = useState<PriceAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [telegramOk, setTelegramOk] = useState<boolean | null>(null);

  const [exchange, setExchange] = useState("NSE");
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState("");
  const [direction, setDirection] = useState<PriceAlert["direction"]>("cross");
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function refresh() {
    try {
      const [rows, status] = await Promise.all([fetchPriceAlerts(), fetchTelegramStatus()]);
      setAlerts(rows);
      setTelegramOk(status.configured);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(t);
  }, []);

  async function addAlert() {
    const target = Number(price);
    if (!symbol.trim() || !Number.isFinite(target) || target <= 0) {
      setError("Enter a symbol and a positive price.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createPriceAlert({
        exchange,
        symbol: symbol.trim().toUpperCase(),
        target_price: target,
        direction,
        note: note.trim() || undefined,
        repeat,
      });
      setSymbol("");
      setPrice("");
      setNote("");
      setRepeat(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to add alert");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await deletePriceAlert(id);
      setAlerts((prev) => prev?.filter((a) => a.id !== id) ?? prev);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to delete alert");
    }
  }

  async function sendTest() {
    setTesting(true);
    setError(null);
    try {
      await testTelegramAlert();
    } catch (e) {
      setError(e instanceof Error ? e.message : "test send failed");
    } finally {
      setTesting(false);
    }
  }

  const active = alerts?.filter((a) => a.active) ?? [];
  const past = alerts?.filter((a) => !a.active) ?? [];

  return (
    <div className="manual-wide-page">
      <div className="manual-page-header">
        <h3>Price Alerts</h3>
      </div>

      {telegramOk === false && (
        <p className="muted">
          Telegram isn't configured on market-data (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — alerts still fire and
          appear here, but nothing is pushed to your phone.
        </p>
      )}
      {telegramOk === true && (
        <p className="muted">
          Telegram is configured.{" "}
          <button type="button" className="ctp-link" onClick={() => void sendTest()} disabled={testing}>
            {testing ? "Sending…" : "Send a test message"}
          </button>
        </p>
      )}

      <section className="manual-settings-section">
        <h4>New alert</h4>
        <div className="pa-form">
          <select value={exchange} onChange={(e) => setExchange(e.target.value)}>
            {EXCHANGES.map((ex) => (
              <option key={ex} value={ex}>
                {ex}
              </option>
            ))}
          </select>
          <input
            className="pa-symbol"
            placeholder="Symbol e.g. NIFTY, BTCUSD"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
          <select value={direction} onChange={(e) => setDirection(e.target.value as PriceAlert["direction"])}>
            {DIRECTIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          <input
            className="pa-price"
            inputMode="decimal"
            placeholder="Price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <input className="pa-note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <label className="pa-repeat">
            <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
            Repeat
          </label>
          <button type="button" className="pa-add" disabled={saving} onClick={() => void addAlert()}>
            {saving ? "Adding…" : "Add alert"}
          </button>
        </div>
        {error && <p className="ctp-error">{error}</p>}
      </section>

      <section className="manual-settings-section">
        <h4>Active ({active.length})</h4>
        {alerts == null ? (
          <p className="muted">Loading…</p>
        ) : active.length === 0 ? (
          <p className="muted">No active alerts.</p>
        ) : (
          <div className="pa-list">
            {active.map((a) => (
              <div key={a.id} className="pa-row">
                <span className="pa-symbol-badge">
                  {a.exchange}:{a.symbol}
                </span>
                <span>
                  {DIRECTIONS.find((d) => d.value === a.direction)?.label} <b>{a.target_price}</b>
                </span>
                {a.repeat && <span className="pa-tag">repeat</span>}
                {a.note && <span className="muted pa-note-text">{a.note}</span>}
                {a.trigger_count > 0 && (
                  <span className="muted">
                    fired {a.trigger_count}× · last {fmtTime(a.last_triggered_at)}
                  </span>
                )}
                <button type="button" className="pa-del" title="Delete" onClick={() => void remove(a.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section className="manual-settings-section">
          <h4>Fired / removed ({past.length})</h4>
          <div className="pa-list">
            {past.slice(0, 20).map((a) => (
              <div key={a.id} className="pa-row is-past">
                <span className="pa-symbol-badge">
                  {a.exchange}:{a.symbol}
                </span>
                <span>
                  {DIRECTIONS.find((d) => d.value === a.direction)?.label} <b>{a.target_price}</b>
                </span>
                <span className="muted">
                  {a.trigger_count > 0 ? `fired ${fmtTime(a.last_triggered_at)}` : "never fired"}
                </span>
                <button type="button" className="pa-del" title="Delete" onClick={() => void remove(a.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
