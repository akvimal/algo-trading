# Product redesign and SaaS rollout plan

**Status: DEFERRED (2026-09-25). Nothing here is built.** Written up so it can be picked up later without redoing the analysis. Pointer added under "Open questions" in `docs/architecture.md`.

## What this is

A redesign of the platform as a multi-user SaaS with paper trading, a graduation gate before live trading, subscription plans, and a responsive (phone-friendly) UI. It came out of a design review on 2026-09-25 that produced a clickable prototype and a codebase audit.

- **Prototype (Design canvas, 25+ boards, private to the owner):** https://claude.ai/artifact/X6ej69Dt2QsZaRmYHPSuzy. This is currently the only copy of the mockup source. It is not in the repo. Press Play on the "Sign in" board to walk the whole flow. Illustrative data throughout, plan prices are placeholders.
- **Audit:** an exploration pass over the repo on 2026-09-25. Two findings were re-verified by hand (see "Verified"). The rest is the audit's own reading of the code and should be spot-checked before acting on it.

## Design decisions (from the prototype)

- Navigation by the trader's job, not by internal system: **Today, Scan, Trade, Portfolio** (primary), **Review, Automate** (improve), **Alerts, Settings** (tools). Replaces the 10 flat tabs that follow the service split.
- **Today** has one dashboard per horizon: Intraday, Positional, Options.
- **Guided and Pro** are one product with a toggle, not two products. Guided adds plain-English hints, a plan-first ticket, overlays off by default.
- **Paper account is the spine:** realistic fills (slippage, NSE/MCX charges, margin), equity curve against NIFTY, and a **graduation gate** that unlocks live trading only after a track record. Discipline and risk tools are never paywalled.
- **Plans (placeholders):** Free (paper, EOD screeners, journal, discipline), Trader (live chart and OI, alerts, Weekly Advisor), Pro (automation, backtests, multiple paper accounts, webhooks, AI news, live execution after graduation), Educator (mentor view). Gate on what costs money: live data budget, AI calls, compute.
- **Mobile is "monitor and act":** tables become cards, bottom-sheet ticket, 44 px targets, 5-item tab bar, installable PWA with web push. Not a native app.
- **Onboarding:** sign in or create account (risk acknowledgement required), choose experience, create paper account (starting rules update with capital), guided first trade (stop-loss first, then target, then size from risk, then place, then one line of why).

## What the code does today versus what the design promises

| The design promises | The code today |
|---|---|
| Live trading unlocks after graduation | `PUT /accounts/{segment}` sets `live_trading_enabled` with no checks (`execution/backend/app/api/routes/accounts.py:118`). The only guard is a browser `window.confirm` (`execution/frontend/src/AccountsPage.tsx:454`). |
| Required stop-loss, minimum reward-to-risk, daily loss limit | Stored, but `min_reward_risk_ratio` is checked only in the browser. `max_daily_loss` gates only live-enabled NSE/MCX manual orders. No max open positions, required stop-loss or max margin rule exists. |
| Realistic costs and slippage | No brokerage, STT or slippage model for NSE/MCX (only crypto fees in `delta_fees.py`). |
| Equity curve, server-side discipline and performance | Discipline (`discipline.ts`) and performance are computed in the browser. No balance-history table or account-level equity endpoint. |
| Limit orders that fire when the tab is closed | Limit and trigger orders are browser-side (localStorage). `order_type` on the server is only a label. |
| Plans, billing, email | Nothing exists: no plan field, no payment code, no email sending, no password reset, no email verification, no 2FA, no Google login. |
| Multiple named paper accounts | `execution.accounts` is `UNIQUE (user_id, segment)`: one account per user per segment. |
| Per-user alerts | One global Telegram bot and chat. `price_alerts.user_id` is nullable. Notification history is per-browser localStorage. |
| Automate for many users | signal-engine has no login requirement and no tenant isolation. Strategies, rules, watchlists, weekly-advisor data and signals are global. Chartink webhooks have no secret. |
| Phone-friendly | One layout `@media` in the whole frontend. No PWA manifest, service worker or push. Four frontends in iframes on four ports, four separate CSS files, no shared UI package, about 45k lines of frontend source. |

Also noted by the audit: `WorkspacePage.tsx` (3,531 lines) and the trade-checklist page are unrouted dead code, though they hold the only UI for a few features (SL-limit orders, option trailing SL, partial exits, review flow). `CI` (`.github/workflows/ci.yml`) still targets the removed `signal-generation` and `signal-processing` systems. Migrations are hand-run SQL (`infra/postgres/migrations/001-013`, two files numbered 010) with no tracking table.

### Verified by hand on 2026-09-25

1. Live trading is a single self-service toggle: `accounts.py:118-119` assigns the flag directly, and the UI guard is `window.confirm` at `AccountsPage.tsx:454`.
2. signal-engine has no login requirement: only `routes/strategies.py` and `routes/weekly_advisor.py` even reference an optional user-id helper, and none rejects an anonymous caller.

## Screen by screen

| Screen | Exists | Gap | Effort |
|---|---|---|---|
| Sign in / create account | Signup, login, JWT | Password reset, email verification, Google login, rate limits, risk-acknowledgement record | M |
| First run (3 steps) | Per-segment accounts, editable capital, risk per trade | Everything else, including the Guided/Pro preference | M |
| Today: Intraday | Regime, sentiment, positions with live P&L, order-block setups | Server-side alerts-fired log, loss budget as a server value | M |
| Today: Positional | Screener, OI buildup, MTF holdings | Aggregation endpoints | S-M |
| Today: Options | Chain, OI, Weekly Advisor, option groups | Credit spreads and a margin model, per-user advisor data | L |
| Scan | OI Buildup, Screener, live OI | Mostly a reskin | S |
| Trade | Chart, ticket, confluence panel | Server-side pending orders, enforced stop-loss and reward-to-risk, LIVE indicator | L |
| Portfolio / Paper account | Reset, live P&L | Equity history, NSE/MCX costs and slippage, graduation gate, multiple accounts | L |
| Review | Journal fields, review flow | Discipline and performance on the server | M |
| Automate | Strategies, rules, backtests, text rule editor | Tenancy, plain-English summary (only terse one-liners exist: `ruleSummary()` in `signal-engine/frontend/src/App.tsx`) | L |
| Alerts | Price alerts, Telegram | Per-user routing, fired history, web push | M |
| Settings | Credentials, some limits | Enforced limits, broker "test connection", billing | M-L |
| Plans / billing | Nothing | Plan field, entitlements, payments, email | L |
| Mobile + PWA | Nothing | All of it | L |
| One app (merge frontends) | Four iframe apps and a postMessage token broker in `shell/index.html` | The whole migration | XL |

## Phases

Estimates assume a single developer and are rough. Phases 1 and 2 can overlap.

**Phase 0: make it safe to open the door (about 2 weeks).** Independent of the redesign. Do these before any other user touches the system.
- signal-engine: require login, add per-user ownership to strategies, rules and watchlists, add a secret to the Chartink webhooks (already listed under "Open questions": webhook auth).
- Owner checks on `/accounts/strategy/*` (currently reachable by any logged-in user).
- Tighten CORS (wildcard in all four backends), fail startup when secrets are the defaults (`JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `INTERNAL_SERVICE_SECRET`), rate-limit auth.
- Enforce required stop-loss, minimum reward-to-risk and daily loss on the server for paper trading.
- Fix CI, add a migration tracking table, record a risk acknowledgement at signup.

**Phase 1: the paper-account spine (about 5 weeks).**
- Balance and equity history table. NSE/MCX charges model and slippage.
- Server-side pending orders (limit, stop) so they work with the tab closed and on a phone.
- Move discipline and performance calculation to the server (the graduation gate cannot trust browser-computed numbers).
- Server-enforced graduation gate: reject the live toggle unless the track record is met, broker credentials are present, consent is recorded, and daily-loss and order-size caps are set.
- Keep one account per segment. Named multiple accounts need a schema change and can wait for Phase 4.

**Phase 2: one responsive app (about 8 weeks).** New web app with a router, shared design tokens and components, one login (no postMessage broker). Port in this order, keeping legacy tabs working until replaced: shell, Today and Scan; Portfolio and Review; Trade (wrap `LiveChartPanel` first, refactor later); Settings. Build mobile-first with a PWA manifest. Extract what is needed from `WorkspacePage.tsx`, then delete it.

**Phase 3: onboarding, plans and messaging (about 4 weeks).** Plan claim in the JWT (stateless, like `is_admin`, stale until re-login) plus backend entitlement checks. Razorpay or Stripe. Email sending (verification, reset, receipts). Onboarding flow. Per-user Telegram, a server-side notification inbox, web push.

**Closed beta milestone:** after Phases 0, 1 and part of 2, invite about 20 users on their own Dhan keys.

**Phase 4: depth (about 6 weeks).** Options view with an approximate margin model and credit spreads (blocked on the margin/max-loss model, see "Open questions: credit spreads"), Automate with tenancy and a plain-English rule summary, mobile Positional and Options views, named multiple paper accounts, Educator plan.

**Phase 5: scale and launch hardening (about 4 weeks).** Dhan capacity, multi-worker market-data, load test at 100+ users, monitoring and backups, privacy policy and legal review.

## What breaks first at 100+ users

1. The shared platform Dhan credential. Users without their own keys share one rate-limit budget per data family, and a 429 blocks the shared feed too. Recommendation: live data requires the user's own keys, and the platform serves only shared end-of-day data.
2. Single-worker market-data (deliberate, because of the feed) with request threads that sleep in throttles (up to 4 s) and in live-fill waits (up to 8 s).
3. An unauthenticated notification poll (`GET /signals` every 5 s per open shell tab) and an open quote WebSocket.

## Decisions still needed before resuming

1. **Data model:** own Dhan keys required for live data (recommended) versus platform-shared data with heavier limits. Sets the free tier's cost.
2. **Merge the frontends** with a gradual migration (recommended) versus keeping four apps and paying roughly double for mobile.
3. **Legal review** of "trade setups" and Weekly Advisor picks before charging (SEBI investment-advice and research rules). Not legal advice; needs a professional.
4. **Payments:** Razorpay (India-first) or Stripe.

## How to resume

1. Open the prototype link and re-read the "Sign in and first run" and "Automate, alerts and settings" rows.
2. Re-run a quick check of the "code today" table above, since the audit is dated 2026-09-25.
3. Start with Phase 0. It is worth doing even if the redesign never happens, because it closes real holes (unauthenticated strategy edits, self-service live trading).
