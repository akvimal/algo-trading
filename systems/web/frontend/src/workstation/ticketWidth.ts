/** How wide the order-ticket panel is on a wide screen: the person's own drag, remembered between visits, kept within what the page can hold. */
export const TICKET_WIDTH = { min: 320, max: 760, default: 440, key: "web.workstation.ticketWidth" } as const;

/** A width within the allowed range and never more than `room` pixels (the page's width less what the charts need), whole pixels. */
export function clampTicketWidth(px: number, room: number = Infinity): number {
  if (!Number.isFinite(px)) return TICKET_WIDTH.default;
  const ceiling = Math.max(TICKET_WIDTH.min, Math.min(TICKET_WIDTH.max, room));
  return Math.round(Math.min(ceiling, Math.max(TICKET_WIDTH.min, px)));
}

export function loadTicketWidth(): number {
  try {
    const raw = Number(localStorage.getItem(TICKET_WIDTH.key));
    return raw > 0 ? clampTicketWidth(raw) : TICKET_WIDTH.default;
  } catch {
    return TICKET_WIDTH.default;
  }
}

export function saveTicketWidth(px: number): void {
  try {
    localStorage.setItem(TICKET_WIDTH.key, String(px));
  } catch {
    /* a private window: the width just is not remembered */
  }
}
