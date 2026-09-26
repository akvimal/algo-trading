import { api } from "./http";
import type { Profile, Segment } from "./types";

export const getProfile = () => api<Profile>("accounts", "/auth/me");

/** A partial update: only what is present changes. `onboarded: true` records that the first-run
 * flow is finished (or skipped). */
export const updatePreferences = (prefs: { experience?: "guided" | "pro"; onboarded?: boolean; markets?: Segment[] }) =>
  api<Profile>("accounts", "/auth/me/preferences", { method: "PUT", json: prefs });
