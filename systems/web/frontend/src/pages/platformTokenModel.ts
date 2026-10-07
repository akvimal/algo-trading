/** How to describe the platform Dhan token's expiry in words, and how worried to look. Pure, so it can be tested without a screen. */
export type ExpiryLook = { text: string; tone: "up" | "warn" | "dn" };

const WARN_HOURS = 3;

export function expiryLook(iso: string | null | undefined, now: number = Date.now()): ExpiryLook {
  if (!iso) return { text: "No token is set", tone: "dn" };
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return { text: "Expiry unknown", tone: "warn" };
  const ms = at - now;
  const when = new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (ms <= 0) {
    const days = Math.floor(-ms / 86_400_000);
    return { text: days >= 1 ? `Expired ${days} day${days === 1 ? "" : "s"} ago (${when})` : `Expired at ${when}`, tone: "dn" };
  }
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const left = h >= 1 ? `${h}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
  return { text: `Valid for ${left} (until ${when})`, tone: h < WARN_HOURS ? "warn" : "up" };
}

/** What "use my saved token now" did, in a sentence a person can act on. */
export function refreshMessage(r: { adopted?: boolean; reason?: string }): { text: string; ok: boolean } {
  if (r.adopted) return { text: "Now using the token saved above.", ok: true };
  return { text: r.reason ? r.reason.charAt(0).toUpperCase() + r.reason.slice(1) + "." : "Nothing changed.", ok: !/expired|no Dhan token|could not/i.test(r.reason ?? "") };
}
