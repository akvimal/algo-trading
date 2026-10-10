import { SERVICE_URLS } from "../config";
import { getToken } from "../auth/token";
import { ApiError, api } from "./http";

/** Chart pictures kept with a trade: the plan at entry, later updates, and pictures added by hand (execution's /positions/{id}/images and
 * /option-groups/{id}/images). Each says what it is and what the trade looked like when it was taken. An option spread's levels are levels of the
 * underlying. */
export type SnapshotKind = "entry" | "update" | "upload";

export type TradeSnapshot = {
  id: string;
  content_type: string;
  uploaded_at: string | null;
  kind: SnapshotKind;
  caption: string | null;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
};

export type TradeRef = { kind: "position" | "group"; id: string };

const base = (t: TradeRef) => (t.kind === "position" ? `/positions/${t.id}/images` : `/option-groups/${t.id}/images`);

export const listTradeSnapshots = (t: TradeRef) => api<TradeSnapshot[]>("execution", base(t));

export type SnapshotMeta = { kind: SnapshotKind; caption?: string; entry?: number | null; stop?: number | null; target?: number | null };

const dataUrlToBlob = (dataUrl: string): Blob => {
  const [head, body] = dataUrl.split(",");
  const type = /data:([^;]+)/.exec(head)?.[1] ?? "image/png";
  const bytes = atob(body);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return new Blob([out], { type });
};

/** Keeps a picture (a PNG data URL) with a trade, with the levels in force now. */
export async function uploadTradeSnapshot(t: TradeRef, picture: string, meta: SnapshotMeta): Promise<TradeSnapshot> {
  const form = new FormData();
  form.append("file", dataUrlToBlob(picture), "snapshot.png");
  form.append("kind", meta.kind);
  if (meta.caption?.trim()) form.append("caption", meta.caption.trim());
  if (meta.entry != null) form.append("entry_price", String(meta.entry));
  if (meta.stop != null) form.append("stop_price", String(meta.stop));
  if (meta.target != null) form.append("target_price", String(meta.target));
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(`${SERVICE_URLS.execution}${base(t)}`, { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.", "network");
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = ((await response.json()) as { detail?: string }).detail ?? "";
    } catch {
      /* not JSON */
    }
    throw new ApiError(response.status, typeof detail === "string" && detail ? detail : "Could not save the snapshot.");
  }
  return (await response.json()) as TradeSnapshot;
}

/** A saved picture as an object URL the page can show (the route needs the login token, so an <img src> cannot fetch it); the caller revokes it. */
export async function fetchTradeImageUrl(id: string): Promise<string> {
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(`${SERVICE_URLS.execution}/images/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.", "network");
  }
  if (!response.ok) throw new ApiError(response.status, "Could not load the snapshot.");
  return URL.createObjectURL(await response.blob());
}

export const deleteTradeSnapshot = (id: string) => api<{ deleted: boolean }>("execution", `/images/${id}`, { method: "DELETE" });
