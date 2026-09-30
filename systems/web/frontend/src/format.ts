// Number and date formatting for an Indian retail audience. Money uses en-IN grouping
// (12,34,567), a real minus sign (U+2212, not a hyphen) so a loss reads as a loss at a
// glance, and profit/loss is ALWAYS signed: colour alone never carries the meaning.

const MINUS = "−";
const IST = "Asia/Kolkata";

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

export function formatInr(value: number | null | undefined, decimals: 0 | 2 = 0): string {
  if (value == null || Number.isNaN(value)) return "–";
  const body = (decimals === 2 ? inr2 : inr).format(Math.abs(value));
  return `${value < 0 ? MINUS : ""}₹${body}`;
}

/** Signed profit/loss: +₹1,710 / −₹1,200. Zero is unsigned. */
export function formatPnl(value: number | null | undefined, decimals: 0 | 2 = 0): string {
  if (value == null || Number.isNaN(value)) return "–";
  const body = (decimals === 2 ? inr2 : inr).format(Math.abs(value));
  if (value === 0) return `₹${body}`;
  return `${value > 0 ? "+" : MINUS}₹${body}`;
}

/** Compact rupee amounts the way Indians read them: ₹10.42L, ₹1.2Cr. */
export function formatInrCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "–";
  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  return `${sign}₹${inr.format(abs)}`;
}

export function formatPct(value: number | null | undefined, decimals = 1, signed = false): string {
  if (value == null || Number.isNaN(value)) return "–";
  const body = Math.abs(value).toFixed(decimals);
  if (!signed || value === 0) return `${value < 0 ? MINUS : ""}${body}%`;
  return `${value > 0 ? "+" : MINUS}${body}%`;
}

export function formatPrice(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "–";
  return plain2.format(value);
}

/** 'up' | 'dn' | 'flat' for styling a signed number. */
export function tone(value: number | null | undefined): "up" | "dn" | "flat" {
  if (value == null || value === 0 || Number.isNaN(value)) return "flat";
  return value > 0 ? "up" : "dn";
}

/** The IST calendar day (YYYY-MM-DD) of an instant. "Today" means the IST trading day. */
export function istDayKey(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function isToday(iso: string | null | undefined, now: Date = new Date()): boolean {
  return iso != null && istDayKey(iso) === istDayKey(now);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** R-multiples (profit in units of the risk taken): +0.42R / −0.4R. */
export function formatR(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "–";
  const body = Math.abs(value).toFixed(2);
  if (value === 0) return `${body}R`;
  return `${value > 0 ? "+" : MINUS}${body}R`;
}

/** 'Sep 25' style date for a YYYY-MM-DD or ISO instant, on the IST calendar. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00+05:30`) : new Date(iso);
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" }).format(d);
}
