import { useEffect, useState } from "react";
import { deleteNote, fetchSnapshotUrl } from "../api/notes";
import { ApiError } from "../api/http";
import type { StudyNote } from "../api/types";
import { ImageIcon } from "../chart/icons";
import { ImageLightbox } from "./ImageLightbox";
import { contextChips } from "./notesModel";

const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");

/** One note: when, its tag and interval, the words, the market as it was when written, and (on request) the chart
 * snapshot kept with it. Deleting takes a second click. Used under the chart and on the notes history page, where
 * `showInstrument` names which instrument the note is about. */
export function NoteRow({ note, onDeleted, showInstrument = false }: { note: StudyNote; onDeleted: () => void; showInstrument?: boolean }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [large, setLarge] = useState(false);
  const chips = contextChips(note.context);

  useEffect(() => () => (image ? URL.revokeObjectURL?.(image) : undefined), [image]);

  async function toggleImage() {
    if (image) {
      setImage(null);
      return;
    }
    setError(null);
    try {
      setImage(await fetchSnapshotUrl(note.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load the snapshot.");
    }
  }

  async function remove() {
    if (!confirm) {
      setConfirm(true);
      window.setTimeout(() => setConfirm(false), 4000);
      return;
    }
    try {
      await deleteNote(note.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete the note.");
      setConfirm(false);
    }
  }

  return (
    <div className="note" data-testid="note">
      <div className="note-head">
        <span className="faint">{hhmm(note.created_at)}</span>
        {showInstrument && <strong className="note-instrument">{note.symbol}</strong>}
        {note.tag && <span className="pill pill-small">{note.tag}</span>}
        {note.interval && <span className="faint">{note.interval.replace("min", "m")}</span>}
        <span className="notes-spacer" />
        {note.has_snapshot && (
          <button className="icon-btn" aria-label={image ? "Hide snapshot" : "View snapshot"} aria-expanded={image != null} title={image ? "Hide the snapshot" : "View the chart snapshot"} onClick={() => void toggleImage()}>
            <ImageIcon />
          </button>
        )}
        <button className="icon-btn" aria-label={confirm ? "Confirm delete note" : "Delete note"} title="Delete this note" onClick={() => void remove()}>
          {confirm ? "Delete?" : "✕"}
        </button>
      </div>
      <p className="note-text">{note.text}</p>
      {chips.length > 0 && (
        <div className="note-chips" aria-label="Market when written">
          {chips.map((c, i) => (
            <span key={i} className="faint note-chip">
              {c}
            </span>
          ))}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {image && (
        <button className="note-image-button" onClick={() => setLarge(true)} aria-label="View the snapshot larger" title="Click to view larger">
          <img className="note-image" src={image} alt={`Chart snapshot with the note from ${hhmm(note.created_at)}`} />
        </button>
      )}
      {image && large && (
        <ImageLightbox
          src={image}
          alt={`Chart snapshot with the note from ${hhmm(note.created_at)}`}
          fileName={`${note.symbol}-${note.interval ?? "chart"}-note.png`}
          onClose={() => setLarge(false)}
        />
      )}
    </div>
  );
}
