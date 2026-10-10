import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/http";
import { deleteTradeSnapshot, fetchTradeImageUrl, listTradeSnapshots, uploadTradeSnapshot, type SnapshotKind, type TradeRef, type TradeSnapshot } from "../api/tradeSnapshots";
import { levelsLine, type PictureLevels } from "../chart/tradePicture";
import { formatDay, formatTime } from "../format";
import { useResource } from "../hooks/useResource";
import { ImageLightbox } from "./ImageLightbox";

export const KIND_LABEL: Record<SnapshotKind, string> = { entry: "Plan at entry", update: "Update", upload: "Added by you" };

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** One saved picture, loaded when it scrolls into the list (the route needs the login token, so the page fetches it and shows it from memory). */
function Picture({ snap, symbol, onOpen }: { snap: TradeSnapshot; symbol: string; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    fetchTradeImageUrl(snap.id)
      .then((u) => {
        made = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL?.(u);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL?.(made);
    };
  }, [snap.id]);
  if (failed) return <span className="error-text">Could not load the picture.</span>;
  if (!url) return <span className="faint">Loading the picture…</span>;
  return (
    <button className="note-image-button" onClick={() => onOpen(url)} aria-label={`View the ${KIND_LABEL[snap.kind].toLowerCase()} picture larger`} title="Click to view larger">
      <img className="note-image" src={url} alt={`${symbol} chart: ${KIND_LABEL[snap.kind].toLowerCase()}`} />
    </button>
  );
}

/** The pictures kept with one trade, oldest first: the plan at entry, then each update, with the levels in force when it was taken and the person's
 * own words. On the Trade page (where the chart is on screen) a new one can be taken at any time, after the chart, the stop or the target has
 * been changed; elsewhere it says where to do that. */
export function TradeSnapshots({
  trade,
  symbol,
  segment,
  levels,
  capture,
}: {
  trade: TradeRef;
  symbol: string;
  segment: string;
  /** The levels in force right now, read when a picture is saved. */
  levels: () => PictureLevels;
  /** Takes a picture of the chart as it is now, labelled with these levels and this caption, as a finished PNG data URL (or null when it cannot). */
  capture?: (label: string, levels: PictureLevels, caption: string) => Promise<string | null>;
}) {
  const list = useResource(() => listTradeSnapshots(trade), [trade.kind, trade.id]);
  const [large, setLarge] = useState<{ url: string; name: string } | null>(null);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function save() {
    if (!capture) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const now = levels();
      const picture = await capture("Update", now, caption);
      if (!picture) {
        setError("The chart could not be photographed right now (it may still be loading). Try again in a moment.");
        return;
      }
      await uploadTradeSnapshot(trade, picture, { kind: "update", caption, entry: now.entry, stop: now.stop, target: now.target });
      setCaption("");
      setSaved(true);
      list.reload();
    } catch (e) {
      setError(message(e, "Could not save the snapshot. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (confirm !== id) {
      setConfirm(id);
      window.setTimeout(() => setConfirm((c) => (c === id ? null : c)), 4000);
      return;
    }
    try {
      await deleteTradeSnapshot(id);
      list.reload();
    } catch (e) {
      setError(message(e, "Could not delete the snapshot."));
    } finally {
      setConfirm(null);
    }
  }

  const rows = list.data ?? [];
  return (
    <div className="stack" data-testid="trade-snapshots">
      {list.loading && <span className="faint">Loading…</span>}
      {list.error && !list.data && <span className="error-text" role="alert">Could not load the snapshots. {list.error.message}</span>}
      {list.data && rows.length === 0 && <span className="faint">No snapshots yet: the chart is saved with the trade when it is placed from the Trade page or from a plan note.</span>}
      {rows.map((s) => (
        <div key={s.id} className="card stack" data-testid="trade-snapshot" style={{ padding: 8 }}>
          <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 8 }}>
            <span className={`pill ${s.kind === "entry" ? "up" : ""}`}>{KIND_LABEL[s.kind]}</span>
            {s.uploaded_at && (
              <span className="faint" style={{ fontSize: 12 }}>
                {formatDay(s.uploaded_at)} {formatTime(s.uploaded_at)}
              </span>
            )}
            <span className="notes-spacer" />
            <button className="icon-btn" aria-label={confirm === s.id ? "Confirm delete snapshot" : "Delete snapshot"} title="Delete this snapshot" onClick={() => void remove(s.id)}>
              {confirm === s.id ? "Delete?" : "✕"}
            </button>
          </div>
          {levelsLine({ entry: s.entry_price, stop: s.stop_price, target: s.target_price }) && (
            <span className="dim" style={{ fontSize: 13 }}>{levelsLine({ entry: s.entry_price, stop: s.stop_price, target: s.target_price })}</span>
          )}
          {s.caption && <span style={{ fontSize: 13 }}>{s.caption}</span>}
          <Picture snap={s} symbol={symbol} onOpen={(url) => setLarge({ url, name: `${symbol}-${s.kind}-${(s.uploaded_at ?? "").slice(0, 10)}.png` })} />
        </div>
      ))}

      {capture ? (
        <div className="stack" data-testid="snapshot-capture">
          <label className="field" style={{ margin: 0 }}>
            <span className="dim">What changed? (optional)</span>
            <input aria-label="Snapshot note" maxLength={500} value={caption} disabled={busy} placeholder="Moved the stop to breakeven, redrew the zone…" onChange={(e) => setCaption(e.target.value)} />
          </label>
          <div className="row" style={{ justifyContent: "flex-start" }}>
            <button className="btn btn-small" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save a snapshot of the chart now"}
            </button>
            {saved && <span className="faint" role="status">Saved.</span>}
          </div>
          <span className="faint" style={{ fontSize: 12 }}>It keeps the chart as it is on screen (your drawings and indicators), with the entry, stop and target as they stand now.</span>
        </div>
      ) : (
        <span className="faint" style={{ fontSize: 12 }}>
          To save a new snapshot after changing the chart, stop or target, open it on the <Link to={`/trade?symbol=${encodeURIComponent(symbol)}&segment=${segment}`}>Trade page</Link>.
        </span>
      )}
      {error && <div className="notice error" role="alert">{error}</div>}
      {large && <ImageLightbox src={large.url} alt={`${symbol} trade snapshot`} fileName={large.name} onClose={() => setLarge(null)} />}
    </div>
  );
}
