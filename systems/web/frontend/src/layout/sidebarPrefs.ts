// Whether the desktop sidebar is collapsed to an icon-only rail — a per-browser preference. Once the
// person has explicitly toggled it, that choice sticks; until then it follows their Guided/Pro setting
// (Guided keeps the labels visible to help learn the nav; Pro starts collapsed). Plain localStorage
// reads and writes, so it can be tested without a screen, same guarded-try/catch convention as every
// other small preference in this app.

const KEY = "web.nav.collapsed";

/** The person's own explicit choice, or null if they have never toggled it — in which case the caller
 * should fall back to a sensible default (see AppShell, which uses Guided/Pro). */
export function loadSidebarChoice(): boolean | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function saveSidebarChoice(collapsed: boolean): void {
  try {
    localStorage.setItem(KEY, String(collapsed));
  } catch {
    // storage blocked: the choice simply lasts this session
  }
}
