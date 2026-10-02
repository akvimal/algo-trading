import { getEmail } from "../auth/token";
import type { AiRead } from "../api/types";

/** A saved read is kept for a day: past that it describes a different session, so it is dropped on load. */
export const AI_READ_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After this the panel flags the read as old, since the OI/price picture it describes has moved on. */
export const AI_READ_STALE_MS = 30 * 60 * 1000;

// Per person (a shared browser must not show one user's read to another) and per instrument+expiry.
const storageKey = (key: string) => `aiRead:${getEmail() ?? ""}:${key}`;

/** Remember the last finished read so a page reload doesn't throw away a paid-for model call. Never throws:
 * storage can be blocked or full, and losing the saved copy must not break the read itself. */
export function saveAiRead(key: string, read: AiRead): void {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(read));
  } catch {
    /* storage unavailable - the read still shows for this page view */
  }
}

export function loadAiRead(key: string, now: number = Date.now()): AiRead | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const read = JSON.parse(raw) as AiRead;
    const at = Date.parse(read.generated_at);
    if (!read.bias || !Array.isArray(read.reasoning) || Number.isNaN(at) || now - at > AI_READ_MAX_AGE_MS) {
      localStorage.removeItem(storageKey(key));
      return null;
    }
    return read;
  } catch {
    return null;
  }
}

export const isStaleRead = (read: AiRead, now: number = Date.now()): boolean => now - Date.parse(read.generated_at) > AI_READ_STALE_MS;
