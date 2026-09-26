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

Also noted by the audit: `WorkspacePage.tsx` (3,531 lines) and the trade-checklist page are unrouted dead code, though they hold the only UI for a few features (SL-limit orders, option trailing SL, partial exits, review flow). `CI` (`.github/workflows/ci.yml`) still targets the removed `signal-generation` and `signal-processing` systems. Migrations are hand-run SQL (`infra/postgres/migrations/001-017`, two files numbered 010); **a tracking runner (`scripts/migrate.sh`) was added 2026-09-25**, dev is baselined, test and the VPS are not yet (see `docs/architecture.md`, "Migration tracking").

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
- signal-engine: require login, add per-user ownership to strategies, rules and watchlists, add a secret to the Chartink webhooks (already listed under "Open questions": webhook auth). **Login and ownership built 2026-09-25, flag `REQUIRE_AUTH` off by default, not yet enabled anywhere** (see `docs/architecture.md`, "signal-engine: login + per-user ownership"). Migration 014 is applied on the dev DB only, and the routes were live-verified there (51/51). **Weekly Advisor per-user data built the same day** (migration 017, dev only, 28/28 live). The Chartink webhook secret is **deliberately deferred** (2026-09-25). Still to do here: applying 014 and 017 and flipping the flag on the test and real environments.
- Owner checks on `/accounts/strategy/*` (currently reachable by any logged-in user). **Live-settings part done 2026-09-25** as part of the live-trading gate: only the person named as the live user can turn live on for a strategy account, and only they or an admin can change its live settings afterwards. **Ownership of strategy accounts built 2026-09-25** (migration 018, dev only; see `docs/architecture.md`, "Strategy-account ownership"): every `/accounts/strategy*` route needs a login, other users' accounts are a 404, and creating one is verified with signal-engine.
- Tighten CORS (wildcard in all four backends), fail startup when secrets are the defaults (`JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `INTERNAL_SERVICE_SECRET`), rate-limit auth. **Built 2026-09-25** (see `docs/architecture.md`, "Security hygiene"); the VPS `.env` must hold real secrets before the next deploy.
- Enforce required stop-loss, minimum reward-to-risk and daily loss on the server for paper trading. **Required stop-loss built 2026-09-25** as a per-account switch (on for new accounts, off for existing; spot/future manual orders only, option groups take their stop after entry). **Deliberately not done, by decision:** server-side minimum reward-to-risk and the paper daily-loss halt.
- Fix CI, add a migration tracking table, record a risk acknowledgement at signup. **All three done 2026-09-25:** CI fixed; tracking runner `scripts/migrate.sh` (dev baselined, test and VPS not yet); risk acknowledgement recorded at signup (migration 019, dev only; existing users are not asked, see `docs/architecture.md`, "Risk acknowledgement at signup").

**Phase 1: the paper-account spine (about 5 weeks).**
- Balance and equity history table. **Built 2026-09-25** (migration 020, dev only; see `docs/architecture.md`, "Balance and equity history"): one row per account per day, reset markers, `GET /equity-history/{segment}` with return and close-of-day drawdown. **NSE/MCX charges model built 2026-09-25** (migration 021, dev only; per-account `apply_charges`, off for existing accounts; rates verified against broker-published schedules 2026-09-25 (STT was raised on 1 April 2026), see `docs/architecture.md`, "Indian charges on paper P&L"). **Slippage built 2026-09-25** (migration 022, dev only; per-account `slippage_bps`, 0 for existing accounts and 5 for new ones as a stated assumption; see `docs/architecture.md`, "Slippage on paper fills").
- Server-side pending orders (limit, stop) so they work with the tab closed and on a phone. **Limit orders built 2026-09-25** (`POST /pending-orders`, migration 023, dev only; paper accounts only, at-most-once, expires; see `docs/architecture.md`, "Server-side pending orders"). A separate stop-order type, and the frontend using the API, are still to do.
- Move discipline and performance calculation to the server (the graduation gate cannot trust browser-computed numbers). **Built 2026-09-25** (`GET /performance/{segment}`, no migration; the discipline score is a port of `discipline.ts` guarded by golden fixtures generated from the real TypeScript; see `docs/architecture.md`, "Server-side performance and discipline"). The frontends still compute their own copies until Phase 2.
- Server-enforced graduation gate: reject the live toggle unless the track record is met, broker credentials are present, consent is recorded, and daily-loss and order-size caps are set. **The base of this gate is built (2026-09-25, Phase 0): consent, caps, saved broker credentials and kill switch are enforced server-side (see `docs/architecture.md`, "Live-trading gate").** The paper track record and discipline requirement was **built 2026-09-25 behind `REQUIRE_PAPER_TRACK_RECORD` (off by default)**: see `docs/architecture.md`, "Paper track-record gate". Applied to automated strategy accounts too (2026-09-25, on the live user's record; the strategy's own record is still unmeasured). Still open: a cooling-off period.
- Keep one account per segment. Named multiple accounts need a schema change and can wait for Phase 4.
- **Own-keys data model (decision 1):** live-data routes in market-data (quotes, option chains, candles, the live feed) resolve the caller's own Dhan credential and stop falling back to the platform credential. The platform credential is kept only for the scheduled end-of-day jobs. Ship it behind a flag, default off, and flip it when the new onboarding can collect keys; a user with no keys gets a clear "add your Dhan keys" response, not a shared-budget quote. The BYO credential path already exists (accounts `/credentials`, market-data BYO throttle keys); the work is removing the fallback and covering the routes that never took a credential (the quote WebSocket, the notification poll). **Built 2026-09-25 behind `REQUIRE_OWN_DHAN_KEYS` (off by default), no migration:** see `docs/architecture.md`, "Own-keys data model". Every browser is now covered; the browser P&L views now use the caller's own token, and the **automated jobs can fetch per owner on each owner's keys** behind `JOB_QUOTES_USE_OWNER_KEYS` (off by default, with a platform fallback so stop-losses stay enforced); signal-engine's engine and the indicator-stop candles are still on the platform credential, and the empty state and onboarding for a brand-new user are still undesigned.

**Phase 2: one responsive app (about 8 weeks).** New web app in `systems/web/frontend` (see "Where the new frontend lives") with a router, shared design tokens and components, one login (no postMessage broker). Port in this order, keeping legacy tabs working until replaced: shell, Today and Scan; Portfolio and Review; Trade (wrap `LiveChartPanel` first, refactor later); Settings. Build mobile-first with a PWA manifest. **Foundation built 2026-09-26** on `revamp-p2-foundation` (shell, PWA, tokens, one login, Today; see `docs/architecture.md`, "The web app"). **Portfolio and Review built 2026-09-26** (`revamp-p2-portfolio`), including tag editing, notes and review submission (`revamp-p2-review`). **Settings built 2026-09-26** (`revamp-p2-settings`: risk limits, Dhan connection, live-trading gate UI); **Scan and Trade built 2026-09-26** (`revamp-p2-scan`, `revamp-p2-trade`; Trade is a guided paper ticket with a lightweight chart, not yet the SMC chart or live orders). **First-run onboarding built 2026-09-26** (`revamp-p2-onboarding`, migrations 024 and 025 on dev only). **WebSocket prices on Trade built 2026-09-26** (`revamp-p2-ws-prices`; polling stays as the fallback). **Trading workstation built 2026-09-26** (`revamp-p2-workstation`: klinecharts, wide layout, left tool strip, indicators and structure menus, two linked charts with NIFTY + BANKNIFTY confluence). **Draggable stop and target lines built 2026-09-26** (`revamp-p2-drag-levels`: drag a plan line on the chart and the ticket follows; "Add line" puts a starting line). **Your trades on the chart built 2026-09-26** (`revamp-p2-chart-trades`). Remaining in Phase 2: live P&L over the socket, retiring the classic frontends; email verification and password reset stay in Phase 3. Extract what is needed from `WorkspacePage.tsx`, then delete it.

**Phase 3: onboarding, plans and messaging (about 4 weeks).** Plan claim in the JWT (stateless, like `is_admin`, stale until re-login) plus backend entitlement checks. Razorpay or Stripe. Email sending (verification, reset, receipts). Onboarding flow. Per-user Telegram, a server-side notification inbox, web push.

**Closed beta milestone:** after Phases 0, 1 and part of 2, invite about 20 users on their own Dhan keys.

**Phase 4: depth (about 6 weeks).** Options view with an approximate margin model and credit spreads (blocked on the margin/max-loss model, see "Open questions: credit spreads"), Automate with tenancy and a plain-English rule summary, mobile Positional and Options views, named multiple paper accounts, Educator plan.

**Phase 5: scale and launch hardening (about 4 weeks).** Dhan capacity, multi-worker market-data, load test at 100+ users, monitoring and backups, privacy policy and legal review.

## Where the new frontend lives (decided 2026-09-25)

**In this repo, as a new frontend-only system: `systems/web/frontend`.** Not a separate project. It follows the precedent of `systems/manual-trading` (a frontend with no backend of its own, talking to the backends over HTTP only), so the "no imports between `systems/*`" rule is unaffected. Deploy it as a new docker-compose service behind Caddy, next to the existing shell.

Why in-repo:
- Phase 0 and 1 change API shapes and the screens that use them (server-side risk enforcement, graduation gate, equity history, pending orders). One repo means one commit and one review per change, instead of coordinating two releases.
- API types are hand-mirrored today, with no codegen, and `contract-guardian` only watches this repo. A split would raise drift risk for a solo developer.
- The gradual migration needs the new app beside the old iframe shell, behind the same Caddy setup and sharing the same login, until every screen is ported. One compose file and one deploy make that simple.
- `CLAUDE.md`, `docs/architecture.md`, this plan, the mockup source and the main/dev/prod workflow already live here.

Two things to do from day one so the in-repo choice pays off:
1. Generate TypeScript types from each FastAPI service's OpenAPI schema (for example `openapi-typescript`) so the frontend cannot silently drift from the backends.
2. Keep design tokens and shared components inside the new app (`docs/redesign-mockup/README.md` lists the tokens), not copied per screen as the four current frontends do.

When a separate project would make sense instead:
- A marketing site (landing, pricing, legal pages): small, static, its own release cadence. Fine as a separate project.
- If a frontend contractor joins or the app is open-sourced: split the new app out then. Starting in-repo does not prevent that.

## Branching and delivery (decided 2026-09-25)

**Use a long-lived `revamp` integration branch, but keep it small.** Only the new frontend and visible behaviour changes go on it. Additive backend work lands on `dev` as it is ready. Otherwise `revamp` drifts from a codebase that is still being shipped to.

Why not put everything on one branch:
- The new app is a brand-new folder (`systems/web`), so it barely conflicts with `dev`. Branch isolation is cheap for it.
- Backend changes are the risk. Migrations are hand-run SQL in a single numbered sequence, so two branches each adding "014" would collide. Behaviour changes on a branch that is never deployed also cannot be tested against real usage.
- Phase 0 closes real security holes and must not wait for the revamp.

| Phase | Branch |
|---|---|
| 0: auth, tenancy, real live-trading gate, server-side limits | `dev` then `prod` directly |
| 1 backend: equity history, charges, pending orders, graduation gate | `dev`, additive and default-off (a flag, or "everyone allowed" until the UI uses it) |
| 2: `systems/web` and all screens | `revamp` |
| 3: entitlement checks in the backend | `dev`, default "all allowed" |
| 3: billing UI, onboarding, notifications inbox | `revamp` |
| 4 and 5 | same split |

Branch model:
- `revamp` is created from `dev`. Each phase is a short branch such as `revamp-p2-shell-today` (**a dash, not a slash**: git cannot hold a branch named `revamp` and one named `revamp/...` at the same time, which the first version of this plan overlooked), merged into `revamp` with `--no-ff` so phase boundaries stay visible.
- Merge `dev` into `revamp` weekly (merges, not rebases, matching the existing direct-merge workflow).
- Migrations only ever land on `dev`, so there is one numbering sequence.

```bash
git checkout dev && git checkout -b revamp
git checkout -b revamp-p2-shell-today        # work, commit
git checkout revamp && git merge --no-ff revamp-p2-shell-today
git merge dev                                # weekly sync
```

Running it without touching dev:
- `git worktree add ../algo-trading-revamp revamp` keeps both branches checked out at once.
- Run the revamp checkout on the **test stack** (ports +1000, own volumes) so the dev stack stays on `dev`. Test's schema can drift from dev's, and rebuilding, migrating or deploying test needs explicit approval each time.
- The VPS never tracks `revamp`.

Reaching users without a big-bang merge:
1. The new app is served beside the old shell (its own route or port). Nothing legacy changes.
2. A per-user "try the new UI" switch, plus a link from the old shell.
3. Milestone merges: once Phase 0, Phase 1 and the first Phase 2 screens work, merge `revamp` into `dev`, then `prod`, **dark** (deployed but hidden). Then open it to the closed-beta users.
4. Keep merging milestones into `dev` from there. Never wait for the end.
5. Cutover means flipping the default entry point, which is reversible. Only after several stable weeks are the legacy tabs and the dead `WorkspacePage.tsx` deleted.

Merge gate for every phase:
- Pytest passes in each touched backend, and the new frontend builds.
- Any migration is numbered, idempotent, and applied on test first.
- Docs are updated and a short manual checklist has been run on the test stack.
- Each milestone is tagged (`revamp-m1`, ...) so rollback is one command.

**Prerequisite: fix CI first. Done 2026-09-25.** `.github/workflows/ci.yml` had targeted the removed `signal-generation` and `signal-processing` systems and skipped `signal-engine`, `accounts` and three of the frontends. It now runs pytest for accounts, execution, market-data and signal-engine, and builds the execution, manual-trading, market-data and signal-engine frontends (every command was run locally first and passes). Still to do: add `systems/web` to the frontend matrix when it exists.

## What breaks first at 100+ users

1. The shared platform Dhan credential. Users without their own keys share one rate-limit budget per data family, and a 429 blocks the shared feed too. Recommendation: live data requires the user's own keys, and the platform serves only shared end-of-day data.
2. Single-worker market-data (deliberate, because of the feed) with request threads that sleep in throttles (up to 4 s) and in live-fill waits (up to 8 s).
3. An unauthenticated notification poll (`GET /signals` every 5 s per open shell tab) and an open quote WebSocket.

## Decisions (made 2026-09-25)

1. **Data model: users bring their own Dhan keys for live data.** The platform's shared credential serves only shared end-of-day data (the EOD screeners) and never live quotes, option chains or charts for a user. This sets the free tier's cost to near zero and removes the shared rate-limit budget as the first thing to break at 100+ users. Consequences: a Phase 1 backend item (below) makes the live-data routes require the caller's own keys, and onboarding has to walk a beginner through getting Dhan keys, so the empty state before keys are added needs a design (paper trading on delayed or end-of-day data is the obvious fallback to design, not yet decided).
2. **Frontends: merge into one app, gradually** (Phase 2, `systems/web`, legacy tabs keep working until replaced).
3. **Legal review: yes.** It must happen before anything is charged for and before trade setups and Weekly Advisor picks are presented to paying users (SEBI investment-advice and research rules). It is a professional's job, not something this repo can do; treat it as a hard gate on the start of Phase 3 billing. The signup risk text is a placeholder until then.
4. **Payments: Razorpay** (India-first). Phase 3 builds against Razorpay subscriptions and webhooks.

## How to resume

1. Open the prototype link and re-read the "Sign in and first run" and "Automate, alerts and settings" rows.
2. Re-run a quick check of the "code today" table above, since the audit is dated 2026-09-25.
3. Start with Phase 0. It is worth doing even if the redesign never happens, because it closes real holes (unauthenticated strategy edits, self-service live trading).
