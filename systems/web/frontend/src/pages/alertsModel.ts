import type { AlertDirection, NewAlert, PriceAlert } from "../api/priceAlerts";
import { formatDay, formatPrice, formatTime } from "../format";

export const DIRECTION_LABEL: Record<AlertDirection, string> = {
  above: "Goes above",
  below: "Goes below",
  cross: "Crosses either way",
};

/** "NIFTY goes above 23,100", "GOLDM crosses 71,000 either way". */
export function describeAlert(a: Pick<PriceAlert, "symbol" | "direction" | "target_price">): string {
  const level = formatPrice(a.target_price);
  if (a.direction === "cross") return `${a.symbol} crosses ${level} either way`;
  return `${a.symbol} goes ${a.direction} ${level}`;
}

export type StatusTone = "up" | "dn" | "warn" | "";
export type AlertStatus = { label: string; tone: StatusTone; detail: string | null };

/** Where an alert stands, in words. A crossing that could not be sent is not "fired": it is shown as a problem, with why. */
export function alertStatus(a: PriceAlert): AlertStatus {
  if (a.active && a.delivery_failures > 0) {
    const times = a.delivery_failures === 1 ? "once" : `${a.delivery_failures} times`;
    return { label: "Could not send", tone: "dn", detail: `The price crossed, but the message failed ${times}${a.last_error ? `: ${a.last_error}` : ""}. It will try again.` };
  }
  if (!a.active && a.last_error) return { label: "Switched off", tone: "dn", detail: a.last_error };
  if (!a.active) {
    const when = a.last_triggered_at ? `${formatDay(a.last_triggered_at)} at ${formatTime(a.last_triggered_at)}` : null;
    return { label: "Fired", tone: "up", detail: when ? `Sent ${when}.` : null };
  }
  const times = a.trigger_count > 0 ? `Has fired ${a.trigger_count} time${a.trigger_count === 1 ? "" : "s"}.` : null;
  return { label: a.repeat ? "Watching, repeats" : "Watching", tone: "", detail: times };
}

export type FormErrors = { symbol?: string; price?: string };

/** The number typed in a price box, with commas and spaces tolerated. NaN when it is not a positive number. */
export function parsePrice(raw: string): number {
  const n = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

export function validateForm(symbol: string, price: string): FormErrors {
  const errors: FormErrors = {};
  if (!symbol.trim()) errors.symbol = "Enter the symbol, for example NIFTY.";
  if (Number.isNaN(parsePrice(price))) errors.price = "Enter a price above zero.";
  return errors;
}

export function toNewAlert(form: { exchange: string; symbol: string; price: string; direction: AlertDirection; note: string; repeat: boolean }): NewAlert {
  const note = form.note.trim();
  return { exchange: form.exchange, symbol: form.symbol.trim().toUpperCase(), target_price: parsePrice(form.price), direction: form.direction, repeat: form.repeat, ...(note ? { note } : {}) };
}

/** A Telegram chat id is a number (a group's starts with a minus sign). */
export const looksLikeChatId = (raw: string): boolean => /^-?\d{3,20}$/.test(raw.trim());

/** Active alerts first, then the ones that are done, newest first within each. */
export function sortAlerts(alerts: PriceAlert[]): PriceAlert[] {
  return [...alerts].sort((a, b) => Number(b.active) - Number(a.active) || b.created_at.localeCompare(a.created_at));
}
