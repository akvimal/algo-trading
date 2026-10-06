import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { listZoneWatches, removeZoneWatch, type ZoneEvent, type ZoneWatch } from "../api/zoneWatches";
import { createPriceAlert, deletePriceAlert, getAlertChannel, listPriceAlerts, sendTestAlert, setAlertChannel, type AlertChannel, type AlertDirection, type PriceAlert } from "../api/priceAlerts";
import { ErrorNotice, Skeleton } from "../components/bits";
import { formatPrice } from "../format";
import { DailyMessages } from "../components/DailyMessages";
import { TextField } from "../components/Field";
import { SEGMENTS } from "../config";
import { useResource } from "../hooks/useResource";
import { DIRECTION_LABEL, alertStatus, describeAlert, looksLikeChatId, placementMessage, sortAlerts, toNewAlert, validateForm, type FormErrors } from "./alertsModel";

const MARKET_LABEL = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" } as const;
const POLL_MS = 30_000;

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Price alerts that reach the person on Telegram even with the app closed. They are watched by the server every minute, unlike a
 * line drawn on a chart, which only alerts while that chart is open. Each person sets their own Telegram chat, and an alert only
 * counts as fired once its message was actually delivered. */
export function AlertsPage() {
  const channel = useResource(getAlertChannel, []);
  const alerts = useResource(listPriceAlerts, [], { pollMs: POLL_MS });

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <Link to="/more">← More</Link>
      </p>
      <h1>Price alerts</h1>
      <p className="dim" style={{ margin: 0 }}>
        Get a Telegram message when a price crosses a level, even with the app closed. The server checks every minute, so a very brief spike can be
        missed. Lines you draw on a chart alert only while that chart is open; zones and horizontal levels are watched by the server too (below).
      </p>

      {channel.loading && <Skeleton lines={3} />}
      {channel.error && <ErrorNotice error={channel.error} onRetry={channel.reload} />}
      {channel.data && <TelegramCard channel={channel.data} onChanged={channel.reload} />}
      {channel.data && <NewAlertCard ready={channel.data.chat_set} onCreated={alerts.reload} />}
      {channel.data && <DailyMessages />}
      {channel.data && <ZonesCard />}

      <h2 className="section-title">Your alerts</h2>
      {alerts.loading && <Skeleton lines={3} />}
      {alerts.error && <ErrorNotice error={alerts.error} onRetry={alerts.reload} />}
      {alerts.data && alerts.data.length === 0 && (
        <div className="card">
          <p className="dim" style={{ margin: 0 }}>
            No alerts yet. Add one above.
          </p>
        </div>
      )}
      {alerts.data && sortAlerts(alerts.data).map((a) => <AlertRow key={a.id} alert={a} onDeleted={alerts.reload} />)}
    </div>
  );
}

const num = (v: number) => formatPrice(v);
const band = (lo: number, hi: number) => (lo === hi ? num(lo) : `${num(lo)}–${num(hi)}`);
const ROLE_WORD: Record<string, string> = { support: "support", resistance: "resistance", zone: "zone" };
const EVENT_WORD: Record<ZoneEvent["event"], string> = { touch: "reached it", held: "tested and held", broke: "closed through it", inside: "closed inside it" };

/** The zones and levels drawn on a chart and armed, as the server holds them: each is watched all day, with every tab closed, and a touch (and then
 * how the candle closed: held or broke) comes to Telegram. Drawing a zone arms it; this list is where to check the server really has it. */
function ZonesCard() {
  const zones = useResource(listZoneWatches, [], { pollMs: POLL_MS });
  const [error, setError] = useState<string | null>(null);
  async function remove(w: ZoneWatch) {
    setError(null);
    try {
      await removeZoneWatch(w.id);
      zones.reload();
    } catch (e) {
      setError(message(e, "Could not remove it. Try again."));
    }
  }
  return (
    <>
      <h2 className="section-title">Zones the server is watching</h2>
      <p className="dim" style={{ margin: 0 }} data-testid="zones-help">
        Zones you draw on a chart are armed and watched here with every tab closed. You get a Telegram message when price reaches one, and another when the candle closes to say
        whether it held or broke. It also catches a wick that touched between two checks. A zone follows the browser you drew it in; delete or move it on the chart and it changes here.
      </p>
      {zones.loading && <Skeleton lines={2} />}
      {zones.error && <ErrorNotice error={zones.error} onRetry={zones.reload} />}
      {error && <div className="notice error" role="alert">{error}</div>}
      {zones.data && zones.data.watches.length === 0 && (
        <div className="card">
          <p className="dim" style={{ margin: 0 }}>
            None armed yet. Draw a zone on a chart (the rectangle tool) and it is armed straight away.
          </p>
        </div>
      )}
      {zones.data?.watches.map((w) => (
        <div className="card row" key={w.id} data-testid="zone-watch">
          <span>
            <strong>{w.symbol}</strong> <span className="pill pill-small">{w.exchange}</span>{" "}
            <span className={`pill pill-small ${w.role === "support" ? "up" : w.role === "resistance" ? "dn" : ""}`}>{w.kind === "line" ? "level" : ROLE_WORD[w.role ?? "zone"]}</span>{" "}
            <span className="num">{band(w.lo, w.hi)}</span>
          </span>
          <button className="btn btn-small" onClick={() => void remove(w)} aria-label={`Stop watching ${w.symbol} ${band(w.lo, w.hi)}`}>
            Stop watching
          </button>
        </div>
      ))}
      {zones.data && zones.data.events.length > 0 && (
        <div className="card" data-testid="zone-events">
          <strong>Latest</strong>
          {zones.data.events.slice(0, 8).map((e, i) => (
            <div key={i} className="dim" style={{ fontSize: 13 }}>
              {new Date(e.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {e.symbol} {band(e.lo, e.hi)} {EVENT_WORD[e.event]}
              {e.event !== "touch" && e.close != null ? ` at ${num(e.close)}` : ""}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TelegramCard({ channel, onChanged }: { channel: AlertChannel; onChanged: () => void }) {
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function run(action: () => Promise<unknown>, done: string | null) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await action();
      setNote(done);
      return true;
    } catch (e) {
      setError(message(e, "That did not work. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!looksLikeChatId(chatId)) return setError("A Telegram chat id is a number, for example 123456789 (a group's starts with a minus sign).");
    if (await run(() => setAlertChannel(chatId.trim()), "Saved. Send a test message to check it works.")) {
      setChatId("");
      setEditing(false);
      onChanged();
    }
  }

  async function remove() {
    if (await run(() => setAlertChannel(""), "Removed. Your alerts will not be sent until you add a chat again.")) onChanged();
  }

  return (
    <div className="card stack" data-testid="telegram-card">
      <div className="row">
        <strong>Telegram</strong>
        <span className={channel.chat_set ? "pill up" : "pill warn"}>{channel.chat_set ? `Connected ${channel.chat_id_hint ?? ""}` : "Not set up"}</span>
      </div>
      {!channel.bot_configured && (
        <div className="notice" role="status">
          This server has no Telegram bot set up yet, so alerts cannot be sent. Whoever runs the app needs to add the bot&apos;s token first.
        </div>
      )}
      {(!channel.chat_set || editing) && (
        <>
          <ol className="dim" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            <li>Open this app&apos;s alerts bot in Telegram and press Start. The bot cannot message you until you do.</li>
            <li>Find your chat id (a number), for example by asking a bot such as @userinfobot.</li>
            <li>Enter it below.</li>
          </ol>
          <TextField id="chat-id" label="Your Telegram chat id" value={chatId} onChange={(v) => { setChatId(v); setError(null); }} inputMode="numeric" placeholder="123456789" />
          <div className="row" style={{ justifyContent: "flex-start" }}>
            <button className="btn btn-primary btn-small" onClick={() => void save()} disabled={busy || !chatId.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
            {editing && (
              <button className="btn btn-small" onClick={() => { setEditing(false); setChatId(""); setError(null); }}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {channel.chat_set && !editing && (
        <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <button className="btn btn-small" onClick={() => void run(() => sendTestAlert(), "Test message sent. Check Telegram.")} disabled={busy}>
            {busy ? "Sending…" : "Send a test message"}
          </button>
          <button className="btn btn-small" onClick={() => setEditing(true)} disabled={busy}>
            Change chat
          </button>
          <button className="btn btn-small" onClick={() => void remove()} disabled={busy}>
            Remove
          </button>
        </div>
      )}
      {note && !error && <span className="up" role="status">{note}</span>}
      {error && <div className="notice error" role="alert">{error}</div>}
    </div>
  );
}

function NewAlertCard({ ready, onCreated }: { ready: boolean; onCreated: () => void }) {
  const [exchange, setExchange] = useState<string>("NSE");
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState("");
  const [direction, setDirection] = useState<AlertDirection>("above");
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<{ title: string; where: string } | null>(null);

  async function add() {
    const found = validateForm(symbol, price);
    setErrors(found);
    setServerError(null);
    setAdded(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const made = await createPriceAlert(toNewAlert({ exchange, symbol, price, direction, note, repeat }));
      setAdded({ title: describeAlert(made), where: placementMessage(made, made.current_price) });
      setSymbol("");
      setPrice("");
      setNote("");
      onCreated();
    } catch (e) {
      setServerError(message(e, "Could not add the alert. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="new-alert">
      <strong>New alert</strong>
      {!ready && <div className="dim" style={{ fontSize: 13 }}>Connect Telegram above first, so there is somewhere to send it.</div>}
      <div className="chips" role="group" aria-label="Market">
        {SEGMENTS.map((s) => (
          <button key={s} aria-pressed={exchange === s} onClick={() => setExchange(s)}>
            {MARKET_LABEL[s]}
          </button>
        ))}
      </div>
      <TextField id="alert-symbol" label="Symbol" value={symbol} onChange={(v) => { setSymbol(v); setErrors((e) => ({ ...e, symbol: undefined })); }} inputMode="text" placeholder="NIFTY" error={errors.symbol} />
      <div className="chips" role="group" aria-label="When">
        {(Object.keys(DIRECTION_LABEL) as AlertDirection[]).map((d) => (
          <button key={d} aria-pressed={direction === d} onClick={() => setDirection(d)}>
            {DIRECTION_LABEL[d]}
          </button>
        ))}
      </div>
      <TextField id="alert-price" label="Price" value={price} onChange={(v) => { setPrice(v); setErrors((e) => ({ ...e, price: undefined })); }} placeholder="23100" error={errors.price} />
      <TextField id="alert-note" label="Note (optional)" value={note} onChange={setNote} inputMode="text" placeholder="Why this level matters" />
      <label className="check" htmlFor="alert-repeat">
        <input id="alert-repeat" type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
        <span>Keep watching after it fires</span>
      </label>
      <span className="faint" style={{ fontSize: 12 }}>
        It fires when the price moves across the level, not because it is already past it when you add the alert.
      </span>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn btn-primary" onClick={() => void add()} disabled={busy || !ready}>
          {busy ? "Adding…" : "Add alert"}
        </button>
      </div>
      {added && !serverError && (
        <div className="stack" role="status" data-testid="added-alert">
          <div className="up">Added: {added.title}</div>
          <div className="dim" style={{ fontSize: 13 }}>{added.where}</div>
        </div>
      )}
      {serverError && <div className="notice error" role="alert">{serverError}</div>}
    </div>
  );
}

function AlertRow({ alert, onDeleted }: { alert: PriceAlert; onDeleted: () => void }) {
  const status = alertStatus(alert);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deletePriceAlert(alert.id);
      onDeleted();
    } catch (e) {
      setError(message(e, "Could not remove it. Try again."));
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="alert-row">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span>
          <strong>{describeAlert(alert)}</strong>
          <span className="faint" style={{ display: "block", fontSize: 12 }}>
            {MARKET_LABEL[alert.exchange as keyof typeof MARKET_LABEL] ?? alert.exchange}
            {alert.note ? ` · ${alert.note}` : ""}
          </span>
        </span>
        <span className={`pill ${status.tone}`}>{status.label}</span>
      </div>
      {status.detail && <span className={status.tone === "dn" ? "dn" : "dim"} style={{ fontSize: 13 }}>{status.detail}</span>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="btn btn-small" onClick={() => void remove()} disabled={busy} aria-label={`Remove alert: ${describeAlert(alert)}`}>
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </div>
  );
}
