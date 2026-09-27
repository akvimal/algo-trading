import { useState } from "react";
import { createWatchlist, deleteWatchlist, updateWatchlist, type Watchlist } from "../../api/strategies";
import { ApiError } from "../../api/http";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { TextField } from "../../components/Field";
import type { Resource } from "../../hooks/useResource";

/** A named, reusable group of symbols a Rule can scan by name (underlying_type='watchlist'). Only its
 * symbols are editable after creation — a rename would silently orphan any rule already referencing the
 * old name, since nothing else here keeps that link in sync. */
export function WatchlistsTab({ watchlists }: { watchlists: Resource<Watchlist[]> }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [symbols, setSymbols] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSymbols, setEditSymbols] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    if (!name.trim() || !symbols.split(",").some((s) => s.trim())) {
      setError(!name.trim() ? "Give it a name." : "Enter at least one symbol.");
      return;
    }
    setBusy(true);
    try {
      await createWatchlist(name.trim(), symbols);
      setName("");
      setSymbols("");
      setCreating(false);
      watchlists.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function save(id: string) {
    setError(null);
    if (!editSymbols.split(",").some((s) => s.trim())) {
      setError("Enter at least one symbol.");
      return;
    }
    setBusy(true);
    try {
      await updateWatchlist(id, editSymbols);
      setEditingId(null);
      watchlists.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteWatchlist(id);
      setConfirmDelete(null);
      watchlists.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete. A rule may still reference it.");
    } finally {
      setBusy(false);
    }
  }

  if (watchlists.loading) return <Skeleton lines={3} />;
  if (watchlists.error && !watchlists.data) return <ErrorNotice error={watchlists.error} onRetry={watchlists.reload} />;

  return (
    <div className="stack">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!creating ? (
        <button className="btn btn-small" onClick={() => setCreating(true)}>
          New watchlist
        </button>
      ) : (
        <div className="card stack">
          <TextField id="wl-name" label="Name" value={name} onChange={setName} inputMode="text" />
          <TextField id="wl-symbols" label="Symbols" value={symbols} onChange={setSymbols} inputMode="text" hint="Comma-separated, e.g. GOLDM, SILVER, CRUDEOIL" />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-small" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void create()}>
              Save
            </button>
          </div>
        </div>
      )}
      {watchlists.data && watchlists.data.length === 0 && !creating && <Empty title="No watchlists yet">A watchlist is a named group of symbols a rule can scan.</Empty>}
      {watchlists.data?.map((w) => (
        <div className="card" key={w.id} data-testid="watchlist-row">
          <div className="row">
            <strong>{w.name}</strong>
            <span className="faint">{w.symbol_count} symbols</span>
          </div>
          {editingId === w.id ? (
            <div className="stack" style={{ marginTop: 8 }}>
              <TextField id={`wl-edit-${w.id}`} label="Symbols" value={editSymbols} onChange={setEditSymbols} inputMode="text" />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-small" disabled={busy} onClick={() => setEditingId(null)}>
                  Cancel
                </button>
                <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void save(w.id)}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="faint" style={{ margin: "6px 0" }}>
                {w.symbols}
              </p>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                {confirmDelete === w.id ? (
                  <>
                    <span className="faint">Delete this watchlist?</span>
                    <button className="btn btn-small" disabled={busy} onClick={() => setConfirmDelete(null)}>
                      No
                    </button>
                    <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove(w.id)}>
                      Yes, delete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setEditingId(w.id);
                        setEditSymbols(w.symbols);
                        setError(null);
                      }}
                    >
                      Edit symbols
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => setConfirmDelete(w.id)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
