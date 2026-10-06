import { SERVICE_URLS } from "../config";
import { getToken } from "../auth/token";
import { ApiError, api } from "./http";

/** Publishing a note as an idea to a Telegram channel through a separate bot. Operator (admin) only; the server builds the post. */

export type IdeasConfig = { bot_configured: boolean; destination_set: boolean; destination_hint: string | null; disclaimer: string };

export type IdeaRequest = {
  note_id: string;
  segment: string;
  symbol: string;
  interval: string | null;
  tag: string;
  text: string;
  context: Record<string, unknown> | null;
  include_context: boolean;
  snapshot_png_base64?: string;
};

export type IdeaPreview = { text: string; messages: number; has_image: boolean; destination_hint: string | null };

export type PublishedIdea = {
  note_id: string;
  /** False once it has been unpublished. */
  published: boolean;
  published_at: string | null;
  unpublished_at: string | null;
  destination_hint: string | null;
  has_image: boolean;
};

export const getIdeasConfig = () => api<IdeasConfig>("marketData", "/ideas/config");
/** Set where ideas are posted (a channel's numeric id or @name); an empty value clears it. */
export const setIdeasDestination = (telegram_chat_id: string) => api<IdeasConfig>("marketData", "/ideas/destination", { method: "PUT", json: { telegram_chat_id } });
export const previewIdea = (idea: IdeaRequest) => api<IdeaPreview>("marketData", "/ideas/preview", { method: "POST", json: idea });
export const publishIdea = (idea: IdeaRequest) => api<PublishedIdea>("marketData", "/ideas/publish", { method: "POST", json: idea });
export const unpublishIdea = (noteId: string, force = false) => api<PublishedIdea>("marketData", `/ideas/${noteId}/unpublish${force ? "?force=true" : ""}`, { method: "POST" });
export const listPublished = (noteIds: string[]) => (noteIds.length ? api<PublishedIdea[]>("marketData", `/ideas/published?note_ids=${noteIds.join(",")}`) : Promise.resolve([] as PublishedIdea[]));
/** A real post to the destination, to check the bot can post there. */
export const sendTestIdea = () => api<{ sent: boolean }>("marketData", "/ideas/test", { method: "POST" });

/** A note's chart snapshot as a base64 data URL, ready to send with the idea. The route needs the login token. */
export async function snapshotDataUrl(noteId: string): Promise<string> {
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(`${SERVICE_URLS.execution}/study-notes/${noteId}/snapshot`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.", "network");
  }
  if (!response.ok) throw new ApiError(response.status, "Could not load the snapshot.");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    // Snapshots are always PNG. The label the browser puts on the data URL comes from the response's content type, which a proxy or
    // a mislabelled response can get wrong, and the server rejects anything that is not labelled as an image - so fix the label here.
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, "data:image/png;base64,"));
    reader.onerror = () => reject(new ApiError(0, "Could not read the snapshot."));
    reader.readAsDataURL(blob);
  });
}
