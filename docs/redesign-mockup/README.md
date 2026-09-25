# Redesign mockup source

Source files of the clickable prototype described in `../redesign-rollout-plan.md` (deferred 2026-09-25, nothing built). Exported from the live Design canvas so the mockup does not exist only inside an artifact.

- Live copy (private to the owner): https://claude.ai/artifact/X6ej69Dt2QsZaRmYHPSuzy
- `canvas.json` is the board index: positions on the canvas, titles, the board order, and the sticky notes and row titles.
- Each `*.dc.html` is one artboard (one screen). `Sidebar.dc.html` and `MobileNav.dc.html` are shared components that the other boards import with `<dc-import>`.
- All numbers, symbols and prices are made up. Plan prices are placeholders (`[X]`, `[Y]`, `[Z]`).

## These files do not open on their own

They are written for the Claude "Design" canvas artifact type (custom `<x-dc>`, `<sc-for>`, `<sc-if>`, `<dc-import>` tags plus a `support.js` runtime that is not stored here). Opening one in a browser shows nothing useful. To view or continue editing, publish `canvas.json` and the `.dc.html` files under `project/` into a new Design artifact.

## What is reusable without the runtime

The visual language is plain CSS variables at the top of each file's `<helmet><style>` block:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0e1319` | page background |
| `--s1` / `--s2` | `#151b23` / `#1c2430` | card / raised surface |
| `--line` | `#2a3442` | borders |
| `--tx` / `--mu` | `#e9eef5` / `#95a3b5` | text / muted text |
| `--ac` | `#6aa9ff` | primary action, selected state |
| `--up` / `--dn` | `#4fd3a8` / `#ff8b6e` | profit / loss (always paired with a sign or arrow) |
| `--warn` | `#f4c15a` | caution, "watch" states |

Fonts: IBM Plex Sans (text) and IBM Plex Mono (all numbers, tabular). Sizes: desktop boards 1440 px wide, phone boards 390 x 844, touch targets 44 px.

## Screens

Today (Intraday, Positional, Options), Scan (OI Buildup, Screener), Trade, Portfolio (paper account), Review, Automate, Alerts, Settings (risk limits, graduation to live), Plans, Sign in, first run (experience, paper account, first planned trade), a "still to design" page, and 5 phone screens plus phone sign-in. See `canvas.json` for the full list and the row titles.
