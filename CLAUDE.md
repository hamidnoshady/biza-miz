# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Persian-first (RTL, Jalali calendar, business-selected money display) multi-industry business platform with four standalone apps: Accounting, Growth & Marketing, CRM and Website Management. Sales/POS, operations, inventory and reporting are work areas inside Accounting; AI, settings and connections are shared platform surfaces. Website Management has two distinct managers: Eshobe CMS and WordPress/WooCommerce. See [docs/app-boundaries.md](docs/app-boundaries.md). Next.js 15 App Router (TypeScript) + PostgreSQL 16. Development is phased — see
[docs/phases/README.md](docs/phases/README.md) for the phase index and status, and each
phase's file for its scope, the decisions made on its open questions, and where its exit
criteria are satisfied. Don't start a phase until the previous one's exit criteria are met.
See [README.md](README.md) for setup, scripts, and the storage conventions (money in
integer Rial, dates in ISO/Gregorian, Persian digits are display-only, etc.) — those
conventions are load-bearing; don't casually deviate from them.

## Canonical route migration rule

A moved route has one live address: **application code, navigation, tests, and
documentation use only the new canonical URL**. Delete/move the old route's
`page.tsx` in the same change so it cannot keep rendering a duplicate app page.
Keep old bookmarks working only as a permanent redirect in the central
`LEGACY_PREFIX_MAP` in `src/lib/app-routes.ts`; a redirect is compatibility, not
a second route. Do not add links, nav entries, route producers, or new pages at
a retired URL. Operational Accounting workspaces are canonical at
`/accounting/{section}`, not `/dashboard/{section}`. Use
`ACCOUNTING_WORKSPACE_HREFS` and `accountingProductsHref()` for those URLs, and
update `docs/accounting-workspace-ia.md` and the route tests whenever an entry
moves.

## Prompt vocabulary — how the user names things

These words have a specific meaning in prompts from the user. Interpret a request
this way first; do not assume the everyday English sense, or the sense a code
comment happens to use, until you have checked this list.

- **Product identity:** this is a multi-app business platform, never “just a café/restaurant POS.” Hospitality is one supported industry and POS is an Accounting work area. Product copy, metadata, demo data, and new documentation must lead with the whole suite; mention café/restaurant behavior only where the specific feature or historical phase requires it.
- **Platform** means this whole product — the entire repo / system (POS, accounting,
  CRM, growth, both website managers, the AI assistant, tenancy, the super-admin
  console, desktop, the lot). A prompt about "the platform" is **not** a prompt about
  `src/app/platform/**` unless they also say super-admin / platform console. In
  *code* those paths, `requirePlatformAdmin`, platform credits, and a CMS "platform
  key" keep their existing technical meaning; do not rename them, and do not treat a
  platform-wide request as a super-admin-console task.
- **App** means exactly one of the four `src/lib/apps.ts` keys — accounting, growth, CRM,
  website — with its own business workspace. It does **not** mean the Next.js application, the Electron desktop
  installer, or the WordPress plugin. The AI assistant is not an app (see below).
  When they name one ("the accounting app", "growth", "CRM"), stay inside that app's
  ownership boundary; don't add a peer page in another app's shell.
- **Section** (also «بخش») means a **menu item / page *inside* an app**, never the app
  itself. A section is one of the entries in an app's own menu or in the dashboard
  sidebar within that app (e.g. loyalty, campaigns & gift cards and commission inside
  the Growth app; products, orders, customers and media inside the WP manager; deals,
  segments and cases inside CRM). **When the user says "section", they mean those
  items inside an app.** This matters for gating: the super-admin console's
  enable/disable (app availability, migration 0128) is set **per app** — an app is
  enabled/disabled as a whole, and every section of it follows its owning app's state.
  There is **no per-section enable/disable** in the super-admin console, and no
  per-section «به‌زودی»/«در حال تعمیر». If a prompt asks to enable/disable a "section"
  or to mark one coming-soon, treat `section` as the app's menu item, don't add a new
  per-section table, and ask which app owns it before writing any per-section gate.
  Note the deliberate contrast with **industry modules** (`ModuleKey`,
  `industry-profile.ts`): a module is a trade-level capability ("does this trade have
  inventory?"); a section is a *presentational* menu item inside an app.
- **AI assistant** (also «دستیار هوشمند», "the assistant") means the platform's
  **main page**: the full-page chat home at `/dashboard` — the assistant IS the
  dashboard for every tenant, unconditionally (the old `workspace` flag and the
  quick-report dashboard are retired; `/overview`, `/ai`, `/dashboard/overview` and
  `/dashboard/ai` are compat redirects). Its management sections (agents, coworkers,
  automations, activity, knowledge, usage) open in the chat home's «مدیریت دستیار»
  panel, addressed by `/dashboard?aiPanel=<key>` (`src/lib/ai-panel.ts`). It is the
  workspace home, not a rail app — `apps.ts` leaves `ai` unassigned on purpose. A
  prompt about the AI assistant is about that home surface (chat, tools, replies),
  not about MCP, coworker jobs, or autopilot unless those are named.
- **Website management** means **both** website systems, not one of them. Since
  migration 0138 they are two **managers inside one app**, `website`
  («مدیریت وب‌سایت», `/websites`):
  1. **Eshobe CMS** — «سایت‌ساز اشوبه», `/websites/cms/*` (`src/lib/cms/*`,
     `src/lib/website/*`, [docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md)).
  2. **WP / Woo management** — «وردپرس و ووکامرس», `/websites/wp/*`
     (Phase 40; plugin in `wordpress-plugin/`). `/dashboard/wp/*` redirects here.
  One app is not one product: they are peers inside one door, with separate
  connections, separate sections and separate headers. Never fold one into the
  other, never treat either as a Connections tab or a Growth section, and if a
  prompt says "website management" without naming which, consider both (or ask
  which) rather than defaulting to the CMS.

## Test and build, locally — before every commit

Run these from the repo root before considering any change done. CI (see below) only runs
when someone starts it by hand, so it is never a substitute for running the checklist
yourself first:

```bash
npm install               # first time, or after a dependency change
docker compose up -d      # start local Postgres (or point DATABASE_URL elsewhere)
cp .env.example .env      # first time
npm run db:migrate

# No Docker (and what CI does on Windows): start the bundled PostgreSQL from
# the `embedded-postgres` devDependency instead of `docker compose up -d`.
#   npm run db:dev         # foreground, Ctrl-C to stop
#   npm run db:dev:start   # background; npm run db:dev:stop to stop it

npx tsc --noEmit          # type check
npm test                  # vitest — unit tests for src/lib/*
npm run test:db           # vitest — integration tests in integration/, needs Postgres
npm run build             # production build (JWT_SECRET only needs to be set to *something*)
```

If you added or changed anything under `src/lib/`, add or update its `*.test.ts` alongside
it (see `src/lib/orders.test.ts` for the pattern: pure functions, integer-Rial fixtures, no
DB). If you changed the schema, add a new forward-only `migrations/NNNN_name.sql` file —
never edit an already-applied migration.

## CI — `.github/workflows/test.yml`

Every workflow in `.github/workflows/` is **manual only** (`workflow_dispatch`) — nothing
runs automatically on a push or a pull request. Start a run from the Actions tab, choosing
the ref to run it on.

`test.yml` runs the checklist above — type check, unit tests, integration tests, and
production build — as four independent jobs in parallel (each GitHub-hosted job gets its
own VM), then fans them into one `required` status check. A newer manual run on the same
ref cancels one still in flight.

### Every workflow runs on **GitHub-hosted** runners

`test.yml`, `verify-shippables.yml`, `build-desktop-installer.yml` and
`build-plugin-zip.yml` run on `windows-latest`, and every `run:` block in them is Windows
PowerShell (`defaults.run.shell: powershell`). `publish.yml` runs on `ubuntu-latest` with
PowerShell Core (`defaults.run.shell: pwsh`), because hosted Windows runners cannot build
a Linux container image. Four things follow, and each one is load-bearing:

- **No `services:` containers in `test.yml`.** GitHub only supports them on Linux runners
  and that workflow is on Windows. The integration job starts a real PostgreSQL from the
  `embedded-postgres` devDependency instead
  (`npm run db:dev:start`, `scripts/dev-postgres.mjs`) on port 55432, and stops it in an
  `if: always()` step. Don't reintroduce a `services:` block.
- **`embedded-postgres`, not `@embedded-postgres/<platform>`.** The per-platform packages are
  `os`-locked, so depending on one directly makes `npm ci` fail outright on every other
  platform (`EBADPLATFORM`). The meta-package lists all eight as *optional* dependencies, so
  one `package-lock.json` installs the right binary on Windows and on the Linux image.
- **`.gitattributes` pins LF.** With Windows' default `core.autocrlf=true`, a CRLF checkout
  breaks migration checksums (`scripts/migrate.ts` hashes raw bytes → `migration_checksum_mismatch`
  on files nobody edited) and any `.mjs` whose first line is a shebang (`SyntaxError: Invalid or
  unexpected token`, reported against the *importing* test). Don't remove it.
- **`publish.yml` builds a Linux image, so it runs on Ubuntu.** The image is
  `FROM node:24-alpine`; hosted `ubuntu-latest` runners provide Docker with the Linux
  backend and buildx out of the box, which `docker/build-push-action` needs. Don't move it
  back to a Windows runner — hosted Windows runners cannot run a Linux-containers daemon.

What follows from that:

- **Run the local checklist above yourself, every time, in full — don't wait on CI.** CI is
  a required independent check, not a substitute for validating work before pushing it.
- Don't report a change as done on the strength of a partial run. `npm test` passing while
  `npm run test:db` was never started is not a green checklist; say which steps you actually ran.
- Keep `.github/workflows/test.yml` in sync with the checklist above — if a step is added, removed
  or renamed here, update the workflow (and vice versa) in the same change.
- Keep every workflow manual-only (`workflow_dispatch`); do not add `push` or
  `pull_request` triggers back.

### Production publishing and deployment: `publish.yml` (GHCR + Coolify)

`.github/workflows/publish.yml` is the only image-publishing workflow. It is manual like
every other workflow: dispatch it from the `main` branch to publish `sha-<short>` +
`latest` and trigger the Coolify redeploy, or from a `v*` tag to publish the immutable
release tag without restarting production. A merge to `main` produces no image — and
production keeps running the previous one — until someone starts this workflow.

It is not ungated: its `gates` job re-runs type checking, unit tests, and the production
build on the exact commit before publishing, so a manual run from any ref is gated the
same way. Keep these gates.

Three details are load-bearing:

- **The tag shape is `sha-<short>` plus `latest`**, matching `imageRefFor()` in
  `src/lib/app-update-status.ts`. A `v*` ref additionally publishes its release tag.
  `GIT_SHA` is passed as a build arg because the `Dockerfile` bakes it into
  `APP_IMAGE_SHA` — how a running container knows which build it is.
- **The 3 GB Node heap limit is workflow-wide and passed into the Docker build.** Keep
  `NODE_OPTIONS=--max-old-space-size=3072` so both the runner jobs and the Dockerfile's
  Next.js build share one ceiling.
- **GHCR is the production registry.** `docker-compose.local.yml` pulls
  `ghcr.io/hamidnoshady/cafe-restaurant-pos`, and `src/lib/app-update.ts` defaults
  `GHCR_IMAGE` to it. Hosts that cannot reach `ghcr.io` directly can pull that same image
  through the `ghcr-mirror.liara.ir` cache as documented in `docker-compose.srv1.yml`.

Coolify's restart request uses `latest=true` so it pulls the newly published image rather
than recreating the previous local image. When `PRODUCTION_HEALTH_URL` is set, the workflow
also verifies the live image SHA and canonical routes; without it, the rollout is explicitly
reported as unverified.

### The release workflows

All `workflow_dispatch`-only, like everything else in `.github/workflows/` — producing a
release is a decision rather than a check on a commit. None of them gate a PR.

- **`build-desktop-installer.yml`** — packages the standalone Windows `.exe`
  (electron-builder → NSIS) and uploads it as a run artifact. Order matters: it runs
  `npm ci` + `npm run build` in the repo root *first*, because `electron/package.json`
  pulls `../.next`, `../src` and `../node_modules` in through `extraResources`. Optional
  `version` input rewrites `electron/package.json`. See
  [docs/standalone-desktop-app.md](docs/standalone-desktop-app.md) for the packaging
  constraints that silently re-break this.
- **`build-plugin-zip.yml`** — bumps the WordPress plugin version in the three places the
  repo rule names, writes the changelog, builds the clean zip, commits and tags `vX.Y.Z`.
  On Windows it writes every file as **UTF-8 without a BOM** (a BOM in the plugin PHP means
  "headers already sent"; in `readme.txt` it breaks the `Stable tag` parse) and builds the
  zip through `ZipArchive` so entry paths use forward slashes — `Compress-Archive` writes
  backslashes, which WordPress's unzipper treats as part of the filename.
- **`verify-shippables.yml`** — the cheap correctness checks for everything that ships to a
  customer machine but never goes through `tsc`/vitest/`next build`: the Electron sources
  parse and `electron/`'s lockfile installs; the documented packaging constraints still hold;
  the plugin's three version fields agree and its changelog documents that version; no
  UTF-8 BOM anywhere in the plugin; the release zip would be well-formed; and the two
  customer-facing `.ps1` files parse. Run it **before** either release build — those two
  commit and tag a version bump, so a failure discovered mid-release is expensive.

## Tenancy — read before touching the database

Since Phase 12 this is a multi-business platform, and isolation between businesses is
enforced by Postgres row-level security rather than by query authors (see the "Multi-business
tenancy" section of [README.md](README.md) and
[docs/phases/Phase-12-Multi-Business-Tenancy.md](docs/phases/Phase-12-Multi-Business-Tenancy.md)).

Since Phase 23 there is a **second boundary in the browser**: each business is served from its
own origin (`{subdomain}.$ROOT_DOMAIN`), the session cookie is host-scoped, and middleware
compares the host's label against the session's `businessSubdomain` claim and fails closed
(see [docs/phases/Phase-23-Subdomain-Tenancy.md](docs/phases/Phase-23-Subdomain-Tenancy.md)).
RLS protects the rows; the origin protects the cookie jar, `localStorage`, service worker, and
CSP/CORS boundary that RLS says nothing about. Never add a `domain` attribute to the session
cookie — that one change would collapse the second boundary while everything appeared to work.

The origin is the **only** thing that names a tenant in a URL: the `/{slug}/dashboard` prefix was
deleted in Wave 5, so don't reintroduce a business identifier into a path. `ROOT_DOMAIN` is what
switches host tenancy on (it may itself be a subdomain — `biz1.ac.eshobe.com` under
`ROOT_DOMAIN=ac.eshobe.com`), and a subdomain is **typed in English by a super-admin**, never
derived from the Persian business name. Anything that resolves a tenant before a session exists
(the login family, WebAuthn's expected origin) must ask the host, not a field in the body.

Three rules follow for the database side:

- **A new tenant-scoped table needs an RLS policy** in the same migration that creates it.
  `integration/tenant-isolation.integration.test.ts` fails if one is missing — that failure
  is a real bug, not a test to update.
- **Don't add `withoutTenantScope()` calls casually.** Each one is a hole in the isolation
  boundary. Seven reasons are justified today (see `src/lib/db.ts`'s doc comment on
  `withoutTenantScope` for the authoritative list): resolving a login email to its memberships
  before a business is chosen; platform administration; resolving a server-sync bearer token to
  its business before any tenant is chosen (the same shape as login); resolving a public API bearer
  key to its business/location before a tenant has been selected; resolving an MCP bearer credential
  — a connector token or an OAuth access token — to its connection, and therefore its business and
  branch (the same shape again; the MCP OAuth flow itself needs no hole, because it names the tenant
  from the host first); a narrow write to the global
  `platform_users` table on behalf of an already-verified in-business membership (e.g.
  a password reset); re-checking a PIN login's `employee_sessions` row before a tenant scope
  has been entered for the request (the same shape as the impersonation-grant re-check it sits
  next to in `getSession()`); and resolving an inbound WooCommerce connection — by the delivery's
  connection id (webhook) or by the WordPress plugin's link-token hash — to the business its store
  belongs to. Anything else is a new hole — think hard before adding one.
- **Background work must scope itself.** Anything running outside a request — the ticks in
  `server.ts`, scripts — has no session to derive a tenant from, so it enumerates businesses
  bypassed and then wraps each one's work in `withTenant(businessId, …)`.

## The business day — read before writing a day-bucketed query

Since migration 0076, "which day did this happen on" is
`app_business_date(ts, tz, start_minutes)`, not `(ts AT TIME ZONE l.timezone)::date`. A branch may
start its trading day at any time (`locations.business_day_start_minutes`, NULL = the calendar day,
which is what the function returns for it), so a café working 18:00→03:00 keeps one service on one
date instead of splitting it at midnight. See the "The business day" section of
[README.md](README.md).

- **A new day-bucketed view or query uses the function.** Writing the timezone cast by hand
  reintroduces the split for every branch that configured a business day, and puts that screen out of
  step with every other one.
- **Don't derive a "today" window in a route.** `getBusinessDayStatus` (`src/lib/business-day-service.ts`)
  already answers it, including a manual close; the pure half is `src/lib/business-day.ts`.
- **There is no "record a past sale" till action.** «ثبت سفارش گذشته» and `/api/orders/backdated`
  were removed: typing a sale in after the fact writes revenue, VAT, COGS and stock into a day that
  has already been reported and reconciled. Correct a wrongly-rung sale with an amendment
  (`/api/orders/[id]/amend`), which posts a dated correction. Don't reintroduce a second model for
  "a sale we typed in late". *Importing* history from another system is a different act and keeps
  the pattern: `src/lib/integrations/holoo/imported-sale-service.ts` writes an *ordinary* `orders`
  row whose `opened_at`, `closed_at`, `payments.received_at`, `stock_movements.occurred_at` and
  `journal_entries.entry_date` are all the instant the sale happened — which is why reports, COGS,
  costing and the fiscal-period lock need no special case. `businessDateOf`
  (`src/lib/business-day.ts`) is the only TypeScript twin of `app_business_date`; write no second
  one.
- **The night ends at the cash-up.** The live window starts at the branch's last
  `employee_shifts.ended_at` once nobody is clocked in (a handover doesn't count); «بستن روز کاری» is
  the override for branches that don't clock in. A start time alone can only say when a day begins.
- **A bill belongs to the shift/day it was *opened* in, not the one that settled it.** Every
  shift-scoped order read shares one predicate — `ORDER_OPENED_IN_WINDOW`
  (`src/lib/order-read-service.ts`) — so the orders screen's settled list and the «سفارش‌های شیفت»
  report can't disagree. A table opened at 23:30 and paid at 08:00 stays the *night* shift's sale: it
  keeps showing in that shift's list however late it closes, and the shift that took the last payment
  is not credited with it. Don't reach for `closed_at` to bucket a shift — that is the bug this
  replaced, and it got both halves wrong at once. Shift *cash* figures are a separate question and stay
  on `closed_by`/`closed_at` on purpose: `shiftCashSummary` answers "what is in this employee's till",
  so the drawer count reconciles against money they actually held.
- **Ending a day is display-only, by decision.** A cash-up or a manual close moves the live window,
  never a report's bucket — don't "fix" reports to honour them.

## Shamsi-only dates — read before showing a date anywhere

This is a hard rule, not a preference. **Every date a user sees must be Shamsi (Jalali).** Gregorian
is an internal implementation detail only.

- **Storage stays Gregorian/ISO.** Dates are stored as `timestamptz`/`date` — do NOT change that.
  Shamsi is a *presentation* rule; it is not a storage migration.
- **Every screen shows Shamsi.** This covers the user/dashboard section and the super-admin/platform
  console, and every module — accounting/ledger, loyalty & marketing, inventory, reports, exports
  (CSV/Excel/PDF), receipts, kitchen tickets, labels, notifications and the AI assistant. There is no
  "user section" exemption and no "superadmin section" exemption.
- **Never render a raw ISO/Gregorian date to a user.** A string like `2026-08-29`, `new Date(x)
  .toISOString().slice(0, 10)`, `.toString()`, `.toDateString()`, or a Gregorian-looking column is a
  bug. Format it through `src/lib/jalali.ts` — `formatJalali`, `formatShiftWindow`, `jalaliToIsoDate`
  — or `Intl.DateTimeFormat` with the `fa-IR` locale (which resolves to the Persian/Shamsi calendar).
- **Never use the native `<input type="date">`.** It opens a Gregorian calendar. Use
  `JalaliDatePicker` (`src/app/dashboard/jalali-date-picker.tsx`), whose `value`/`onChange` contract
  is still an ISO date string so callers keep storing ISO while the user only ever sees a Jalali
  calendar. It is theme-agnostic and importable from the platform console too.
- **The AI speaks Shamsi.** The assistant's system prompt already says dates are Shamsi
  (`src/lib/ai.ts`). Keep tool descriptions as ISO parameters (that is the storage contract), but the
  *answer* the model gives must phrase dates in Shamsi — never hand the model a raw Gregorian date to
  repeat back.
- **"Today" is the business's today.** Use `businessToday` / `getBusinessDayStatus`
  (`src/lib/business-day-service.ts`) or `todayJalali` for "today", never a bare `new Date()` UTC
  slice, so a branch working 18:00→03:00 keeps the right day.
- **When you add or touch any date display, add Shamsi coverage.** Prefer `formatJalali` over
  re-implementing conversion; keep `src/lib/jalali.test.ts` green.

## Pull requests — check in until merged, not just at open

Every PR from work in this repo gets watched through to a terminal state, not just opened
and left:

1. Right after pushing and opening the PR, subscribe to its activity (PR comments, review
   feedback, status checks) so you keep receiving updates on it.
2. When an event comes in — a failing check, a review comment — investigate and, if you're
   confident in the fix and it's in scope, push it and keep the PR's status current. If a
   fix is ambiguous or architecturally significant, ask before acting instead of guessing.
3. New pushes, check results and merge-conflict transitions aren't always delivered as
   events. Schedule a periodic check-in (roughly hourly is reasonable) on any PR still open,
   to catch state that webhooks missed — re-check status, mergeability and checks, act on
   anything actionable, and re-arm silently if nothing changed.
4. A PR isn't done at "opened", and there is no CI to be green (see above) — the local
   checklist is what stands in for it, and review may still be pending. Keep checking in
   until it's actually merged or closed. Stop immediately if asked to.

The only check that still reports here is an external security review app, which is not a
workflow in this repo and does not run the tests.

## Payment ways — read before touching how money is taken

Since migration 0091 a business's ways of taking money are **rows in `payment_methods`**, named and
ordered by the business, and one bill can be split across several of them (`payments` gets one row
per slice). The `payment_method` enum did not go away — it is now the *settlement* a way declares,
and the only thing the ledger sees. See the "Payment ways" section of [README.md](README.md).

- **Don't hard-code a payment list in a screen.** `GET /api/payment-methods` is the source, and
  `<PaymentWays>` (`src/app/dashboard/payment-ways.tsx`) is the picker; the arithmetic of a split
  lives in `src/lib/payment-draft.ts`, not in a component.
- **Don't add the tip into the `payments` rows.** They record the bill; `tendersWithTip` folds the
  tip into the posting only. The closed-order amendment and refund ceilings depend on that.
- **A split posts one entry, not one per slice** — `postExactOrderPaymentEntry` takes `tenders` and
  builds a debit line per settlement against a single revenue credit.

## Dashboard UI — read before adding a page or a panel

Every page and panel under `src/app/dashboard/**` is **built from the primitives in
`src/app/dashboard/page-chrome.tsx`** — `PageShell`, `PageHeader`, `SectionCard`/`cardClass`,
`TabBar`/`TabPanel`, `EmptyState`, `StatusBadge`, `CardEyebrow`, `KpiCard`/`KpiRow` — plus
`DataTable`/`Th`/`Td` (`data-table.tsx`), `FilterChip`/`FilterChipRow`/`SearchField`
(`filters.tsx`), `<Button>` and `ui.tsx`'s `inputClass`/`Field`/`ErrorBox`/`InfoBox`. See
[docs/ui-conventions.md](docs/ui-conventions.md) for what each one replaces and why, and the
**Decision guide** in [docs/design-system.md](docs/design-system.md) for which one to reach
for.

**The visual canon is [docs/design-system.md](docs/design-system.md)** — the exact colours,
borders/shadow weights, radius scale, control/table/chip recipes, hover/focus/active states
and motion vocabulary, backed by the approved reference screenshots (the pre-2026-09 set is
archived under `docs/design/reference/archive-2026-09/` and is historical, not normative).
Read it before building or restyling any page or panel; the approved screenshots are ground
truth, and its "old look" list is a set of regressions, not style choices.

Enforcement is five tests — `npm run test:design` — and a pixel diff, `npm run test:visual`,
both required on every pull request (`.github/workflows/test.yml`). **Never re-record a
visual baseline to make a red run green** (see `docs/design/visual-regression.md`). The
per-page audit and the ordered remaining work are in `docs/design/coverage-matrix.md`.

Two rules carry the history:

- **Compose, don't re-derive.** The dashboard already went through a phase where every screen
  hand-rolled its own header spacing, tab pills and card border, and moving between two screens
  of the same product looked like moving between two products. A new page that spells out
  `mx-auto w-full max-w-[1600px]` or `rounded-2xl … shadow-sm` instead of using the shared
  component is how that comes back.
- **Teal is the brand accent, amber is selection, neutrals are warm stone.** Filled `<Button>`s
  stay teal (`--primary`); active tabs and pressed chips are `bg-amber-100 text-amber-950`;
  hairlines are `border-stone-200/80` and the card shadow is
  `shadow-[0_1px_2px_rgb(41_37_36/0.035)]`. A cool `gray-*`/`slate-*` class or a `shadow-sm` on
  a card is drift, not a choice. Dark mode is deliberately unsupported here — don't add `dark:`
  variants piecemeal.

Full-screen operational surfaces (POS, orders, floor plan, KDS, reservations) keep their own
compact icon-led chrome on purpose, and `src/app/platform/**` is a separate realm with its own
`ui.tsx`. Both are documented exceptions — don't extend them to a new dashboard page.

The canon is **executable and app-wide**: `src/app/dashboard/design-lint.test.ts` bans the
drift patterns in every dashboard file and requires every route to carry the `PageShell`
frame; `src/app/design-lint.test.ts` holds the same bans on the entry surfaces every
business type walks (login, welcome, setup, invite, consent, business directory) and on
`src/components` minus the shadcn layer; `src/app/loading-coverage.test.ts` requires a
skeleton boundary above every layout realm and a `*Skeleton` in every client component
that fetches on mount. Loading is skeletons for regions and busy-label words («در حال ثبت…»)
for actions — never `animate-spin`. Neither lint keeps a baseline, so any new violation
fails `npm test`.

## One party record — read before adding a customer, supplier or staff screen

Every counterparty the business owes or is owed by is **one row in `parties`** (migration
0137 renamed `customers` to `parties` and added `role`, the person type, the identity
columns and the tab documents). Customer, supplier and employee are a `role` on that row,
not three tables: a supplier who also buys coffee is one party, and the ledger's
receivable, the store's purchase order and the payroll advance all point at the same `id`.

- **A person holds a *set* of roles.** Migration 0148 added `parties.roles text[]`.
  `parties.role` stays the **primary** role — it decides the accounting-code prefix and is
  what every pre-0148 query reads — and the invariant every layer keeps (the form, the
  API, the service, a DB trigger) is `role ∈ roles`. Listings filter with `roles && …`,
  not `role = ANY(…)`, so the shop that both buys from and sells to one person sees one
  file with one balance in both lists. In code: `partyRoles()`, `primaryPartyRole()`,
  `withPartyRoles()`, `togglePartyRole()` in `src/lib/parties.ts`. Never assume one role,
  and never write `role` without letting the service derive the set.
- **One directory, several views.** `/accounting/directory` is the canonical people
  screen; «همه اشخاص»، «مشتریان»، «تأمین‌کنندگان»، «فروشندگان»، «کارکنان» are `?view=`
  filters of it (`src/lib/party-directory.ts`, `partyDirectoryHref()`). The old
  `/accounting/{customers,suppliers,vendors}` routes redirect onto it carrying the view.
  Deep-link into it — do not add a per-role screen.

- **One endpoint and one screen.** `/api/parties` (+ `/[id]`, `/categories`) and
  `src/app/dashboard/parties/{parties-section,party-form}.tsx` are the only party write
  path in the product; `src/lib/parties.ts` holds the contract both the form and the route
  validate against (`PARTY_SCHEMA`, `buildPartyPayload`, `parsePartyRequestBody`), and
  `src/lib/parties-service.ts` is the only place the party's own fields are read and
  written. What stays outside it is deliberately narrow: the CRM's own columns on the row
  (tags, consent, lifecycle stage, the merge pointer) and the two importers that fill a
  party from another system — they maintain fields the directory does not own, and neither
  may invent a party row of its own.
- **A per-app view is a scope, not a copy.** What an app lists, which columns it draws and
  whether it may edit at all come from `PARTY_SCOPES` in `src/lib/parties-scopes.ts`
  (CRM=customers, the store=suppliers, the team=personnel, Accounting=all three and the
  only one that edits the ledger fields, Growth/sales read-only). **One scope per app** —
  Accounting used to have four, one per role, and they are gone. A new app that needs
  parties mounts `PartiesSection` with its scope. It does not grow a second table of "the
  suppliers I care about", its own add form, or its own archived flag — that is how one
  person ends up with three names.
- **Money-shaped fields are the ledger's.** `accountingCode`, `accountingCodeMode`,
  `general_info.taxPercentage`, `financial_info` and the national/economic codes need
  `ledger.view` on top of `parties.manage`; the gate reads the request body, because a form
  sends the whole record. Codes are allocated per business by role prefix (۱ customers,
  ۲ suppliers, ۳ staff) unless the mode is `Manual`.
- **A tab is a document.** The four jsonb tabs store the wire keys verbatim; a tab the
  request does not name is left exactly as stored, and `{}` means cleared. Never rebuild a
  full body from a partial one — that is how an archive toggle wipes an address.
- **`suppliers` is a branch alias, not a second supplier.** It keeps `location_id`, its own
  note and `party_id`; a purchase order still references `suppliers.id`, and a row with a
  party reads its name and phone from that party (`getInventoryOverview` resolves it with one
  COALESCE and `PATCH /api/inventory/suppliers/:id` refuses identity edits on a linked row).
- **Deleting is a decision, not a DELETE.** `removeParty` hard-deletes a party with no
  history and archives one with orders, receivables, points or a branch alias — the route
  returns which happened, and the section says so in Persian.
- **Permissions are `parties.view` / `parties.manage`.** Nothing named `customers.*`
  survives; stored overrides in `users.permissions` and `invitations.permissions` were
  rewritten by 0137. In user-facing Persian the subject is «طرف‌حساب», so the assistant,
  the knowledge articles and every label say «طرف‌حساب‌ها» for the record and keep
  «مشتری»/«تأمین‌کننده»/«کارمند» for the role a row has.

## Hybrid sync — read before touching an order, a master table or the outbox

A paired desktop and the central server converge through two channels (Phase 44, migrations
0189/0190; see [docs/server-sync.md](docs/server-sync.md) and
[docs/phases/Phase-44-Hybrid-Sync-Completeness.md](docs/phases/Phase-44-Hybrid-Sync-Completeness.md)):
versioned **events** (`sync_events` outbox/inbox) for operations, and the **master feed**
(per-field clocks in `sync_row_clocks`) for customers, the menu, tables and payment ways.

- **A new mutation of an open order emits its state.** Call `recordOrderState` inside the
  mutation's own transaction (or `recordOrderStateStandalone` when there is none). A route that
  changes a bill without it is how "the cloud refused the payment" comes back.
- **A new money- or stock-moving action is a registered event.** Append it with
  `appendSyncOutboxEvent` in the same transaction and give it a handler in
  `sync-domain-handlers.ts`; `appendSyncOutboxEvent` decides who records (a site always, the
  central server only for a branch with a paired desktop, nobody during a replay).
- **Never write a master table around the trigger, and never merge a derived column.** A new
  synchronised table goes into `MASTER_SYNC_TABLES` *and* the trigger list in the same
  migration (a unit test compares them); stock cost, occupancy, scores and ciphertext stay in
  `excluded`.
- **Applying a peer's change sets `app.sync_replay`.** Keep it that way — it is the only thing
  that stops an event or an edit bouncing back to where it came from.
- **A replay keeps the peer's instant, a device's flush does not.** Only `origin = 'remote'`
  may date `opened_at`/`closed_at`/the journal; a phone's clock must never place a sale in a
  closed day.
- **Cursors are `(txid, …)` under `pg_snapshot_xmin`, never a bare id.** An id is allocated at
  INSERT, not COMMIT, and a cursor over it skips late commits.
- **The desktop is the till; the cloud is the system of record (Phase 45).** On a Hybrid desktop
  only the routes in `src/lib/site-routes.ts` render locally; everything else hands off to the
  «نسخهٔ ابری» window. A new screen is cloud-by-default — add it to that list only if it must
  work offline at the till, and then give its writes a sync event. Never give the cloud window
  a preload. Branch settings and switches reach the desktop through
  `/api/server-sync/site-profile` (fetched before push/pull each tick), not through a copy at
  pairing.

## Counting stock — read before touching barcodes or a physical count

Both item models can now be counted with a scanner, and they stay **two separate
implementations on purpose** — the same boundary Phase 21 Wave 1 drew and every phase since
has kept.

- **Barcodes are per model.** `item_barcodes` → `items` (retail, Phase 27 Wave 4, gated on the
  `barcode` capability) and `inventory_item_barcodes` → `inventory_items` (F&B). What they
  *share* is the pure code format in `src/lib/barcode.ts` — EAN-13/UPC-A check digits and the
  GS1 in-store prefix `2` for minted internal codes — so one scanner reads both without
  configuration. Don't unify the tables; do reuse `barcode.ts`.
- **A scanner is a keyboard.** Any scan input must stay enabled while its lookup is in flight
  and refocus afterwards, or fast consecutive reads are silently dropped. A repeat scan *adds*
  to the tally (in `Decimal`, not float — a kg-counted store room drifts otherwise).
- **Counts are per model too**, and the retail one is deliberately the small one:
  `item_stock` is a moving weighted average with no lots and no negative layers, so
  `item-stock-count-service.ts` needs none of `stock-count-service.ts`'s settlement machinery.
  A count **sets** the quantity to the counted figure rather than applying a delta (which is
  what keeps it inside `item_stock`'s `quantity >= 0` check), and **never moves the unit cost** —
  only the quantity was ever wrong.
- **Shortage and surplus never net.** They hit different accounts, so a count that is short on
  one item and over on another must post both, not nothing.
- **The retail shortage account is `5190`, not F&B's `5160`.** Cosmetics already spends 5160 on
  «کالای منقضی و تستر» — an *identified* loss — and unexplained shrinkage must not be folded into
  it. The surplus side shares `4910` with F&B, which means the same thing in every trade.
- **A posted count is corrected by reversal, never edited**, like a production run. A reversal
  applies the inverse delta (so sales made after the count survive it) and is refused once a
  counted surplus has been sold.

## The AI coworker — read before touching a recurring AI job

Since Phase 32 an owner can hand the assistant a *standing* instruction — «هر شب که شیفت بسته
می‌شود، ماندهٔ نان را ضایعات بزن» — as a **job** (`ai_coworker_jobs`) that fires on a business event
or a schedule and lands in the assistant's approval inbox — «مدیریت دستیار ← همکاران» on the
dashboard chat home (`/dashboard?aiPanel=coworkers`; the retired `/dashboard/ai` address forwards
there). See the "AI
coworker" section of [README.md](README.md) and
[docs/phases/Phase-32-AI-Coworker.md](docs/phases/Phase-32-AI-Coworker.md).

- **A job is deterministic — never call a provider from one.** Its actions are built by a pure
  builder in `src/lib/ai-coworker-templates.ts` from params plus facts the service read. That is why
  a job costs no credits, needs no credit opt-in, and can be asserted to the Rial in an integration
  test. Adding a model call to a job path removes the only basis on which an owner could
  pre-approve it.
- **Params hold intent; the database holds numbers.** A job stores *which item and why*, never a
  quantity. `loadFacts` reads the current figure at fire time and the builder clamps to it.
- **A new template adds a builder, not a branch elsewhere.** Declare its module, scope, triggers and
  emitted actions in `COWORKER_TEMPLATES`; the API narrows by module and the form renders from
  `template.params`.
- **`approvalMode: 'auto'` never bypasses Phase 31.** `planCoworkerActions` still runs every action
  through `evaluateAutopilotProposal` against the same per-category settings. Don't add a path that
  applies an action without it, and don't let over-cap mean dropped — it means held, and the held
  action must apply unchanged when a human approves.
- **Idempotency is the UNIQUE index**, not a read-then-write. Every firing claims
  `ai_coworker_runs (job_id, dedupe_key)` first.
- **Event producers only enqueue.** `shift-service` and `business-day-service` call
  `recordCoworkerEvent` (its own tiny module, to keep the import graph acyclic), which swallows its
  own errors: a cashier clocking out must never fail because of a background job.
- **Waste is `coworkerOnly`.** `inventory.waste.log` may run unattended, but `actionTypesForCategory`
  excludes it so an *autopilot* run — the model deciding for itself — still cannot log waste. Phase
  31's reasoning is intact; a job just supplies the "why" in advance. Don't remove that flag.
- **`accounting-review.ts` is a rule engine, and must stay one.** Never route a finding through a
  model: a plausible finding about money is worse than none. It reports and never writes; a rule
  whose query fails is named in `unavailableChecks` rather than returning "found nothing", and the
  integration test asserts that list is empty.

## Apps — read before adding a feature area or touching retrieval

Phase 36 turned the assistant from a bubble in the corner into a workspace, and made
"what the app knows" a retrievable thing. Four rules carry that work; see
[docs/phases/Phase-36-App-Ecosystem.md](docs/phases/Phase-36-App-Ecosystem.md).

- **An app is not a folder of pages.** An app is a contribution to four shared registries:
  a read tool (`toolDefinitions`/`runReadTool`), an `ACTION_CATALOG` entry with a Phase 31
  executor, a domain event (`recordCoworkerEvent`), and a posting rule in the posting engine.
  Do that and chat, MCP, the coworker and autopilot pick the new app up for free. A second
  write path, a parallel tool list, or a hand-rolled ledger call is exactly what this rule
  forbids.
- **`ModuleKey` is the gating vocabulary; `AppKey` is only grouping.** `industry-profile.ts`
  says what a trade has and `moduleForApiPath` enforces it at the API. `apps.ts` says only
  what is seen next to what. If a grouping is the *only* thing hiding a route, the hiding is
  decoration and the route is open.
- **Prompt text is built from fragments, and a database row overrides the code default** —
  not merely its version. A bad edit or an unmigrated deploy must fall back to the code
  fragment, never silence the assistant.
- **No number is ever copied into a vector.** `ai_embeddings` holds slow-moving text only —
  help, policy, procedures, item and menu descriptions, project notes, names for approximate
  lookup. Orders, stock, payments and ledger rows are read through tools at the moment of
  asking, because a vector copy of a figure on a POS is stale within minutes and makes the
  model *confidently* wrong about money. `EMBEDDABLE_KINDS` in `src/lib/ai-rag.ts` is where
  that is enforced; `NEVER_EMBEDDED_KINDS` records the exclusion so it reads as a decision.

Two more, because both of these are load-bearing and easy to undo by accident:

- **pgvector is optional, and its absence is not a failure.** Migrations `0113` and `0114`
  create the extension inside a `DO … EXCEPTION WHEN OTHERS` block and create nothing
  downstream unless `pg_extension` really has the row; `isRetrievalAvailable()` and
  `isAnswerCacheAvailable()` probe once and answer *false* if the probe itself throws. The
  desktop installer runs `embedded-postgres` with no `vector` library — it loses RAG, not
  the assistant. Don't make either migration hard-fail.
- **The answer cache key is the *business day*, not the calendar date, plus a tool
  signature.** A café trading 18:00–03:00 runs one service; a key built from the calendar
  date carries the pre-midnight answer into the next service. The signature is what makes a
  late-arriving sale — an amendment, an imported invoice — invalidate the range it landed in. And only
  read-only turns are ever cached — `isCacheableTurn()` fails closed and is checked inside
  `storeCachedAnswer()`, not just at the call site.
- **The Growth & Marketing app (`/dashboard/growth`) is the container for every
  customer-growing surface** (Phase 36b): loyalty, campaigns/gift cards and commission are
  its sections today; messaging (#372) becomes a section of it, not a new sidebar peer.
  CRM (#367) and the website manager (#378) were seated here as forward references and
  were both later pulled out into their own apps once built — CRM because the customer
  record is read by every app, not owned by the one that markets to it; the website
  manager because it is an integration with an external system of record (eshobe-cms,
  see [docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md)), not a marketing
  engine over this app's own tables. Its dashboard never keeps a number of its own —
  every balance on it is reconstructed from `journal_lines` the way the trial balance does
  (`growth-overview.ts`), and marketing moves money only through the posting rules its
  services already own (`GROWTH_BRIDGE_CODES` is exactly ۲۳۰۰/۲۴۱۰/۲۴۲۰/۵۲۱۰). The old flat
  routes (`/dashboard/{loyalty,promotions,commission}`) redirect into the app — keep them
  that way; bookmarks and saved bottom-nav slots depend on them. **It owns its sidebar**
  (`src/lib/app-shells.ts` + `app-shell-nav.ts`): inside `/dashboard/growth*` the dashboard's
  nav slot is the app's own menu (`growth/growth-nav.ts`), with nothing from accounting listed
  beside it. A new section means an entry in that list — never a new flat page, and never a
  second menu drawn inside the page.

## The Website app — read before touching `/dashboard/website` or `/api/cms/*`

**One app, two managers.** «مدیریت وب‌سایت» (`/dashboard/website`) is the single
door to both website systems: the Eshobe CMS site builder (`cms/`) and the
WordPress/WooCommerce manager (`wp/`, which moved here from `/dashboard/wp`).
They are peers and never merge — separate connections, separate sections,
separate headers, and in prompts "website management" means both (see Prompt
vocabulary above). What they share is one rail entry and one sidebar.

- **The menu is built from real connections, not a flag.** `GET /api/website/managers`
  answers which of the two systems this business actually has, and
  `visibleCmsSections`/`visibleWpSections` (`website-routes.ts`, unit-tested) turn
  that into the menu: a manager with no connection lists its front page and the
  screen that connects it, and nothing else. A «سفارش‌ها» entry over a site that
  does not exist is a dead end with a number on it.
- **`integrations` gates the WordPress half only.** `/dashboard/website/wp` is in
  `PAGE_FEATURE_PREFIXES`; `/dashboard/website` is not. A business without the
  add-on still runs the platform site it pays for.
- **`apps.ts` is grouping; `industry-profile.ts` still gates.** The app carries
  both modules (`website`, `integrations`) and `/dashboard/website/wp` maps to
  `integrations` *before* `/dashboard/website` maps to `website` — first match
  wins, so the longer prefix is listed first.

This app (POS/accounting/CRM) and [`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms)
(the Payload 3 multi-tenant website platform) are **separate deployments**, connected
server-to-server over REST — never embedded, never sharing a database. The contract between
them, both sides' setup steps and the credential model live in
[docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md); read it before touching
either side.

- **The browser never sees the CMS key.** `connectCmsWebsite`/`provisionCmsWebsite`
  (`src/lib/cms/website-service.ts`) store it encrypted (`eshobe_cms_connections`, AES-256-GCM
  via `src/lib/integrations/secrets.ts`) and every later call decrypts it server-side inside
  `src/lib/cms/client.ts`, the only HTTP client for the CMS.
- **A read from the CMS is best-effort; a write is never reported as applied unless the CMS
  answered 2xx.** A down CMS must never take the POS down — see `client.ts`'s
  `CmsApiError`/`CmsNetworkError` split.
- **The revalidation webhook (`POST /api/cms/revalidate`) is not tenant-scoped by session** —
  it verifies an HMAC signature over the raw body instead (`src/lib/cms/webhook.ts`), because
  the CMS calls it with no user in the room. It must stay outside `withTenantScope` and outside
  the `website` module gate in `API_MODULE_PREFIXES` (`src/lib/industry-profile.ts`) — gating
  it would 403 the CMS's own publish notifications.
- **Never put a platform key where a site key belongs.** A platform key can provision a site
  and issue/revoke its keys; it cannot read or write that site's content. Reversing the two —
  handing a site key provisioning power, or a platform key content access — is the CMS-side
  patch's whole security property (see the integration doc §5/§6). The one widened read is
  the registrar **quote**, which places no order and writes no row, so the wizard can price a
  domain before the site exists.

### The operator's side: «سایت‌ساز» in the super-admin console (migration 0139)

> **کارِ مشتری در «مدیریت وب‌سایت» است؛ کارِ سکو در کنسول.** The section above is the
> business's own manager — one owner, one site. Every **superadmin** function of
> eshobe-cms and every fleet-wide report about it lives in the super-admin console
> instead, at `/platform/cms`, driven by one CMS address and one `role: "platform"`
> key. That follows the repository-layout rule: functionality that supervises
> clients *across* businesses belongs in `src/app/platform/**`.

Five pages (`میز فرمان / سایت‌ها / همگام‌سازی / پایش / اتصال`), the routes under
`/api/platform/cms/*`, `src/lib/cms/platform-{control,control-service,client,sync}.ts`,
and the CMS-side surface `/api/platform/*` (its own
`docs/platform-control-api.md`). Full contract:
[docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md) §7.

- **The credential is never returned, and an empty submission means *unchanged*.**
  `platform_cms_config` is a singleton in the shape of `platform_update_config`; the
  platform key is AES-256-GCM at rest and read back only as its last four
  characters. The form renders empty and therefore posts empty on every save, so
  treating that as deletion would wipe the platform's root credential for its own
  website platform — `clearApiKey: true` is the explicit door. The
  `ESHOBE_CMS_URL`/`ESHOBE_CMS_PLATFORM_API_KEY` pair stays as the fallback, so
  rotation is a form submission rather than a redeploy.
- **`cms.manage` is the write capability** (engineer + owner, the same reasoning as
  `backup.manage`); reading the report rides `system.read`, because "four domains
  are unverified" is not privileged information.
- **A platform key now reaches every site's content** through the snapshot export.
  Say this plainly rather than pretending otherwise: it is not new authority,
  because a platform key could already issue itself a site key for any site. The
  boundary that matters — a *site* key reaches exactly one site — is unchanged.
- **`platform_cms_sites` is a cache of somebody else's model**, never a second
  source of truth. It exists so a fleet question is one local query and so the
  console keeps showing real figures (stamped with when they were read) while the
  CMS restarts. Its delete pass is why the client pages the *whole* list: a site
  removed from the CMS is the one state an upsert cannot express.
- **A push is a dry run first, and the counts reported are the CMS's own.** A count
  that arrives after the write is not a decision, and a write is applied only to the
  extent the other side says it was. An import of another site's snapshot is refused
  unless forced (its relationships are that site's document ids), and media is never
  in a snapshot — the files are in object storage.
- **Every sync writes a `platform_cms_sync_runs` row, success or failure.** A content
  restore nobody can point at afterwards is an incident, not an operation.
- **The CMS's logs land in OpenObserve without a collector credential on the CMS.**
  Two producers fill a dedicated stream (`OPENOBSERVE_CMS_STREAM`, default
  `cms_events`, read back through `?source=cms` on the existing proxy): every control
  call this console makes, and the CMS's own event feed polled on a cursor. The
  cursor advances to the newest record *received*, never to `now`. Both halves are
  opt-in and default off — a migration must not turn a POS into an HTTP client for a
  service it has never heard of.
- **`domain` is not editable from the console.** On the CMS its one write path resets
  `domainVerified` and re-checks uniqueness across primaries *and* aliases; a second
  door would be a second place to forget that. Moving a connected site's domain
  stays the business's own «تنظیمات و همگام‌سازی» flow.

### Building a site, and paying for it (migration 0138)

> **سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.** The CMS renders and
> serves; it has no wallet, no plan and no invoice.

- **The wizard's order is the owner's order: domain → CDN → نوع سایت → ساخت.**
  The rules are pure and unit-tested (`src/lib/website/setup.ts`); the row is
  `website_setup`. Which step is current is *derived* from the answers, never
  stored twice, so the wizard resumes identically on another device. A step is
  done when the decision it asks for has been made — a domain still registering
  and a CDN zone still queued both count, because waiting on somebody else must
  not block the next question. Only a *failed* domain order blocks: there is no
  address to build on.
- **Build order is provision → connect → subscribe.** A business is never billed
  for a site whose provisioning failed; a site with nothing billing for it is
  recoverable by the operator, so that is the direction the failure falls.
- **A domain is priced, wallet-checked, ordered, then billed** — in that order
  (`src/lib/website/domain-service.ts`). Charging first would need a refund path
  that only ever runs on failure. If the wallet drains in between, the charge is
  recorded *unsettled* rather than dropped: an invoice is recoverable, silently
  not billing is not.
- **Idempotency is the UNIQUE index** `(business_id, kind, reference)`, never a
  read-then-write. A subscription charge's reference is the *period* it covers,
  never the moment the tick ran.
- **A wallet that cannot cover a renewal marks the subscription `past_due` and
  leaves the site serving.** `runWebsiteBillingTick()` never cuts a shopfront off
  from a cron; the owner sees the state and a «پرداخت دورهٔ جاری» button.
- **A quote in a currency this app cannot express in Rial is refused, not
  converted** at a guessed rate (`quoteToRial`). Charging a business a number
  nobody can reconcile is worse than saying the platform cannot sell that TLD.
- **Money is integer Rial in storage and calculations, while the UI uses the business-selected unit (Toman or Rial) on screen and for inputs.** Use `useMoney()`/`formatMoney`/`formatMoneyText`; never hard-code «تومان» or «ریال», never divide by 10 in a component, and convert inputs to Rial before API writes. When the user selects Rial, all labels, inputs, totals, exports, and display text must use Rial; when Toman is selected they must use Toman. Every date on
  these screens goes through `formatJalali` — the site's billing is not exempt
  from either rule.

## The assistant's replies — read before adding an AI tool or touching the chat

Phase 33 fixed a chat that did not behave like one and answers that were not
grounded enough to trust. Four rules carry that work; see
[docs/phases/Phase-33-Assistant-Usability.md](docs/phases/Phase-33-Assistant-Usability.md).

- **A tool returns the label, not just the code.** Every enum a tool surfaces comes back with its
  Persian label from `src/lib/ai-labels.ts`, and every money field as `{ rial, toman, text }`. A
  label the tool returns is a fact; one the model translates on the fly is a guess, and a confident
  guess about what a status means is what makes an owner stop trusting the feature. Never hand the
  model a bare `spoilage` or a bare Rial integer and expect it to cope.
- **Never make the user carry an id.** `find_items` resolves a partial Persian name to the ids the
  action catalogue needs, and the prompt forbids asking for or printing one. A new tool that takes
  an id must have a companion path that finds it from a name.
- **A disabled row is an answer.** `find_items` returns `isActive` plus a Persian `statusLabel`;
  «غیرفعال است» is a correct reply and "پیدا نشد" for a disabled item is a bug.
- **The reply is read on a 360px phone.** Assistant replies render through
  `src/components/ai/ai-markdown.tsx`: anything intrinsically wide (a table, a code block, a long
  token) gets its own scroll box or is forced to break, so the *page* never scrolls sideways. Don't
  reintroduce `whitespace-pre-wrap` for assistant content — that is what made Markdown arrive as
  literal `**` and `|---|`.

Also: **don't put a gate in front of the answer.** The pre-send cost estimate was removed because
`/api/ai/chat` already reserves credit and refuses without it; the actual charge is shown under the
reply instead. `/api/ai/estimate` still exists, but nothing in the send path may block on it.

## The MCP connector — read before touching `/api/mcp` or its OAuth server

Since Phase 34 an owner can connect their *own* Claude, ChatGPT or Codex to their business through
an MCP server at `/api/mcp`, set up from «اتصال‌ها ← دستیارهای هوش مصنوعی». See the "Connecting
Claude, ChatGPT and other assistants" section of [README.md](README.md) and
[docs/phases/Phase-34-MCP-Connector.md](docs/phases/Phase-34-MCP-Connector.md).

- **The read tools are the assistant's own, not a copy.** `mcpReadTools()` reshapes
  `toolDefinitions("dashboard")` and dispatches through `runReadTool`. Adding a read tool to `ai.ts`
  adds it to MCP for free — which is the point: a question asked in Claude and the same question
  asked in «دستیار» must not be able to disagree about last week's revenue, since only one of them is
  in the room to be corrected. Do not write a parallel catalogue.
- **The write tools are exactly the `ACTION_CATALOG` entries with an `executor` and no
  `coworkerOnly` flag** — `assertWriteToolsMatchCatalogue()` fails the unit test if that drifts. Each
  runs the same Phase 31 executor a coworker job runs, so **MCP opens no new mutation path**. Waste
  stays absent: Phase 32 let a *job* log it on the strength of a fact the owner wrote down in
  advance, and a model in a chat window has written down nothing.
- **`pos.read` and `pos.write` are independent grants, and write *trust* is a third axis.**
  `write_mode` is `'approve'` (the write waits in the owner's list and changes nothing) or `'apply'`.
  Never default a connection to `apply`, and never let a scope widen anywhere except through the
  consent screen or the owner's own PATCH.
- **The 401's `WWW-Authenticate` header is the whole discovery chain.** A client that has never seen
  the business reads it, follows it to `/.well-known/oauth-protected-resource`, finds the
  authorization server and registers itself. Removing or narrowing it breaks no test — it breaks
  "paste a URL and press connect", silently, in a client that shows no error.
- **In `/authorize`, `client_id` and `redirect_uri` are validated before anything else.** Only once
  both are known-registered does another failure become a redirect. The other order makes the
  endpoint an open redirect. For the same reason the consent hand-off emits a **relative**
  `Location`: `request.url` in a route handler is the container's origin, and rebuilding it from
  `x-forwarded-host` would let a client-supplied header choose the destination.
- **PKCE is S256 only, codes are claimed with a conditional `UPDATE`, and refresh rotates** and
  re-reads the connection's current scopes — so narrowing a connection cannot be undone by a refresh.
- **Everything is tenant-scoped from the host.** The OAuth endpoints resolve the business with
  `resolveMcpTenant` (Phase 23's "ask the host" rule) and then work inside `withTenant`; only the
  bearer lookup bypasses, under the documented `mcp-token-auth` reason. Do not add a second hole.

## Notifications — read before adding an alert or touching push

Since Phase 35 the app can reach a person who is not looking at a screen, over **Web Push**
(RFC 8030/8291/8292 — one implementation covering iOS, Android and Windows). See the
"Notifications" section of [README.md](README.md) and
[docs/phases/Phase-35-Notifications.md](docs/phases/Phase-35-Notifications.md).

- **A producer only enqueues.** `recordNotification` (`src/lib/notification-events.ts`) is one
  INSERT that swallows its own errors — the same tiny-module shape and the same contract as
  `recordCoworkerEvent`, for the same reason: a cashier closing their till must never wait on, or
  fail because of, an HTTPS round trip to a push service. Only `runNotificationTick` sends.
- **A new event key needs a producer in the same change.** `NOTIFICATION_EVENTS` is the catalogue
  the settings screen renders from, so a key nothing emits is a switch that does nothing — worse
  than an absent one. `inventory.low_stock` is the one *scanned* producer
  (`notification-scans.ts`), because stock leaves an item through six different paths and a
  crossing is a property of the level, not of any one of them.
- **A missing rule is a default, not a silence**, and no event defaults a `cashier` or `kitchen`
  member into anything. An app that buzzes every till phone gets its permission revoked in a week,
  and then none of it works.
- **Quiet hours suppress the push, never the bell row.** «بیدارم نکن» is not «به من نگو». Only a
  `critical` event overrides the window; `backup.failed` is the only one, and the exception is its
  whole justification.
- **Dedupe on the fact, never on the moment.** `notification_events` has UNIQUE
  `(business_id, dedupe_key)`; build the key from the shift/run/order id through
  `notificationDedupeKey`.
- **A notification is not an `ACTION_CATALOG` action.** It writes nothing to the books and needs no
  approval, so it never goes through Phase 31's autopilot machinery — an «ask me first» job would
  otherwise have to ask permission before telling anyone anything. AI features emit them directly
  from `fireCoworkerJob`'s outcome points, and MCP's write catalogue is unchanged.
- **Never rotate the VAPID pair.** The public half is inside every subscription a browser has ever
  minted; changing it invalidates every device on the deployment with no error to notice. The row
  in `platform_push_config` is written once (`ON CONFLICT DO NOTHING` plus a re-read), and that
  table is in `EXEMPT_TABLES`.

## Repository layout

- `src/app/api/**/route.ts` — route handlers. Every handler starts with a guard
  (`requireRole(...)`/`requirePermission(...)` from `src/lib/auth.ts`) and resolves the
  caller's active branch via `resolveActiveLocation(session)` (`src/lib/setup-state.ts`) —
  since Phase 14 a business may have several branches; this always returns the one the
  caller is currently scoped to, validated against their branch assignment.
- `src/app/dashboard/**` — authenticated UI (role-gated per page/route in the sidebar nav),
  built from `page-chrome.tsx` — see "Dashboard UI" above.
- `src/app/platform/**` (Phase 15) — the super-admin console, a separate auth realm from the
  tenant dashboard, and since Phase 23 served from its **own host** (`admin.$ROOT_DOMAIN`)
  rather than from a tenant's origin — middleware redirects `/platform` reached anywhere else. **Any functionality that supervises or administers clients across
  businesses — not just one business's own data — belongs here, not in a per-business
  dashboard.** Update management (which businesses are on the latest app version, the S3
  config that distributes desktop-installer updates — `/platform/updates`) is the concrete
  example so far; the same rule applies to anything shaped like it in the future. Route
  handlers guard with `requirePlatformAdmin()`/`requirePlatformCapability(...)` from
  `src/lib/platform-auth.ts`, not `requireRole`/`requirePermission` — see
  `src/lib/platform-admin.ts` for the role→capability mapping.
- **Industry modules (Phase 21, Phase 25)** — a business has an `industry`
  (`src/lib/industries.ts`), set by a super-admin when provisioning it from the platform console and
  changeable there afterwards (additively and audited — see Phase 25's doc for why that is safe).
  That choice selects its chart of accounts (`coaTemplateForIndustry`), its setup-wizard steps
  (`wizardStepsForIndustry`), and — since Phase 25 — **which modules it has at all, what they are
  called, and how it sells**, all from one place: `src/lib/industry-profile.ts`. Since Phase 27 the
  profile also carries a per-trade `capabilities` field for finer-grained switches (`barcode`,
  `batch_expiry`, `repairs`). Prefer adding to
  that profile over adding an `if (industry === …)` anywhere else. A module the trade does not have
  is refused at the API guard (`moduleForApiPath` in `withTenantScope`), not merely hidden from the
  nav — the same discipline `features.ts` follows. The retail industries sell through a multi-line
  invoice (`retail-invoice-service.ts`) that is an `orders` row settled by Phase 21's own sell
  services, so no posting rule is duplicated. There are **five** trades: `food_service` is the original F&B app;
  `jewelry`/`watch`/`accessories`/`cosmetics` build on a
  parallel `items`/`item_serials`/`item_weight_attributes`/`item_stock` model and post through the
  domain-event engine (`src/lib/posting-engine.ts` + each industry's `*-posting-rules.ts`) rather
  than hand-written ledger functions. Cosmetics adds `item_batches` on top (batch/lot number, expiry,
  sold first-expired-first-out via `src/lib/fefo.ts`); every trade shares one promotion engine
  (`src/lib/promotions.ts`) and one loyalty engine (`src/lib/loyalty-service.ts`). **F&B's
  `menu_items`/`inventory_items`/recipes are never
  migrated onto that model, by decision** — see the phase doc's "Revised" scope note before assuming
  otherwise. Industry-gated pages and routes use `src/lib/industry-guard.ts`, the industry-keyed
  counterpart of `features.ts`.
- **App availability (migration 0128)** — the *third* gating axis, and the only one that is
  temporary and announced rather than hidden. A feature flag answers "did this business buy
  it?", a module "does this trade have it at all?"; this answers **"is the app released and
  working right now?"** — `available` / `beta` / `coming_soon` / `maintenance` / `disabled`,
  per app in `src/lib/apps.ts`. Set platform-wide at `/platform/apps`, overridable for one
  tenant on its «قابلیت‌ها و اتصال» tab; both behind `features.write`. Rules live in
  `src/lib/app-availability.ts` (framework-free, unit-tested), the DB half in
  `src/lib/app-availability-service.ts` (`app_availability` = a global catalogue with no RLS,
  like `feature_flags`; `business_app_availability` = tenant data, RLS'd, like
  `business_features`). Enforcement mirrors the other two axes: `withTenantScope` refuses a
  blocked app's routes with **503 `app_unavailable`**, and the dashboard layout wraps its
  children in `AppAvailabilityGate`. The deliberate difference: a blocked app **stays in the
  nav** wearing its state badge and its pages render the explanation screen — «به‌زودی» and
  «در حال تعمیر» are facts a business should be told, not absences to guess at. An override
  replaces the platform row wholesale (never field-by-field), `beta` is usable and only
  labels, and `available_from` is stored Gregorian and always rendered Shamsi.
  **This axis is per app, never per section.** A «section» is a menu item/page *inside* an
  app (see Prompt vocabulary); enabling or disabling happens on the app, and every section
  of that app follows its owning app's state. Do not build a per-section availability table
  or a per-section «به‌زودی»/«در حال تعمیر» — the console already enables/disables apps, and
  the app's sections inherit that.
- **In-house production (Phase 29)** — some F&B items are *made*, not assembled: a cake is built
  from raw materials once, yields 8 slices, and each slice is sold through its own serving recipe.
  A formula (`production_formulas`) and a run (`production_runs`) sit between the two, under the
  «تولید» tab of `/accounting/inventory` and `/api/inventory/production/*` — so they inherit the
  `inventory` flag and F&B module with **no new gating**. The load-bearing rule: **the produced good
  is an ordinary `inventory_items` row** flagged `is_produced`, which is why recipes, costing,
  sale-time deduction, stock counts, pricing and cost drift all needed no change. Don't build a
  second model for "a thing we make". A run's cost is spread over the *actual* yield, its optional
  conversion cost is capitalised through a WIP wash account (`1310`) crediting a **contra**-expense
  (`5180`, so the wage in `5200` isn't counted twice), and it is corrected by reversal, never edited.
- `src/lib/*.ts` — framework-free logic (money, dates, digits, order totals, …); these are
  what `*.test.ts` files cover. `src/lib/db.ts` and files that call `query()`/`getPool()`
  are the DB-touching exception and aren't unit-tested directly.
- `migrations/NNNN_*.sql` — forward-only, applied in filename order by `scripts/migrate.ts`.
- `scripts/*.ts` — standalone CLI tasks run with `npx tsx` (migrate, seed, backup/restore,
  role provisioning, perf benchmarks, …) rather than through a route handler. The Windows
  package bundles only the explicitly required migration/runtime-role entrypoints; it does not
  ship the source scripts or a TypeScript runtime.
- **Warehouse counting** — barcode assignment and label printing for F&B live under the
  «بارکد و لیبل» tab of `/accounting/inventory` (`/api/inventory/barcodes*`), and the retail
  physical count under `/accounting/inventory` (`/api/stock/counts*`). Both inherit an existing
  module (`inventory` and `stock` respectively) with **no new gating**, the way Phase 29's
  production tab does — gate a new tab, never the hub.
- **Connections (Phase 28, Phase 34, Phase 38w)** — everything a business connects *to* lives behind one hub,
  `/dashboard/connections` (`src/lib/connection-kinds.ts`), with five kinds: the desktop
  install, a WooCommerce store (now the WordPress manager's, hidden from the hub), Holoo, the
  business's **website** (Phase 38w — now the CMS manager's «تنظیمات و همگام‌سازی» section,
  also hidden from the hub), developer API keys for `/api/v1`, and
  (Phase 34) the MCP connector an owner points their own Claude/ChatGPT/Codex at. The page is
  deliberately **not** feature-gated — its tabs have three different entitlements and one
  (desktop pairing) has none — so gate a new tab, never the hub. Two rules carry the
  history: a desktop install is claimed with a **pairing code** issued by the Owner from
  their own dashboard (`/api/connections/desktop`), *not* with the `POS1-…` server-sync
  token, and the address handed to the desktop is **this request's own origin**, never
  `PLATFORM_BASE_URL` — the same "ask the host" rule Phase 23 states for login. A
  WooCommerce store connects in one of two `link_mode`s: the original `rest_api`
  (consumer keys, app calls store) or `plugin`, where the WordPress plugin in
  `wordpress-plugin/` does all the calling and authenticates with a link token plus an
  HMAC envelope over timestamp, nonce and body (`src/lib/integrations/plugin-link.ts`).
  Both modes feed one ingest path (`applyIngestEvent`) and one outbox — in plugin mode
  the app fills that queue but must never drain it. Holoo is the second provider in this
  same gateway, not a parallel subsystem: SQL Server reads are profile-driven through
  `src/lib/integrations/holoo/schema-profile.ts`, web-service writes are preferred,
  direct-SQL writes require a tested known profile, a pinned profile key and the exact
  `holoo-direct-sql` arming phrase, and companion mode is bounded by
  `holoo_connection_settings.companion_activated_at`. Never add Holoo source columns to
  core tables; ownership is enforced from `integration_mappings` by `withTenantScope`,
  and the migration wizard lives at `/dashboard/integrations/holoo`, not in first-run setup.
- `wordpress-plugin/pos-accounting-connector/` — the WordPress/WooCommerce plugin (PHP,
  no build step, not part of the Next.js app). Its signing string must stay byte-identical
  to `plugin-link.ts`'s; `plugin-link.test.ts` pins the expected value on the TS side, so
  change both or neither. **Every change to the plugin bumps its version** — the `Version:`
  header and `POS_CONNECTOR_VERSION` in `pos-accounting-connector.php`, plus the `Stable
  tag` and a Changelog entry in `readme.txt` — so WordPress sites can tell an update apart.
  The plugin ships its own self-updater (`includes/class-pos-updater.php`, since 1.4.0):
  WordPress updates it from `POS_CONNECTOR_UPDATE_URL` (an `update.json` manifest the
  owner hosts — the intended mode where GitHub is unreachable) or, while that is empty,
  from this repository's GitHub releases/tags. Shipping a version means the **manual**
  `build-plugin-zip` workflow (`.github/workflows/build-plugin-zip.yml`, no push trigger):
  it bumps the version, writes the changelog, builds the clean zip and the manifest,
  and commits + tags `vX.Y.Z` — the runbook lives in
  [docs/wordpress-plugin-updates.md](docs/wordpress-plugin-updates.md).
- `electron/` — the standalone (no-Docker) desktop installer. `main.js` bundles a real
  PostgreSQL 16 (`embedded-postgres`) and runs `server.ts`/`scripts/migrate.ts` unmodified as
  child processes — see `docs/standalone-desktop-app.md`. Separate `package.json` from the
  root app (own dependencies: `electron`, `electron-builder`, `embedded-postgres`).
- `docs/phases/*.md` — one file per phase: scope, exit criteria, open questions, and (once
  built) the decisions made and where each exit criterion is satisfied in code.
- **The website is a shop window; the source of truth is here (Phase 38w).** «سایت ویترین است؛
  منبع حقیقت اینجاست.» Product, price and stock flow **one way**, from this app to the site,
  through `website_outbox` (`src/lib/website/sync-service.ts`) — the site never writes a price or
  a quantity back, and nothing in this repo reads one from it. Every call to the site goes through
  a `WebsiteAdapter` (`src/lib/website/adapter.ts`): money is integer Rial on both sides of that
  interface (the adapter converts to the site's unit from `site_currency`), content is Markdown,
  and only `WebsiteAdapterError` crosses back. Nothing goes to the site unless the owner marked the
  product (`website_product_map.sync_enabled`, default off) and switched on price and/or stock
  push separately. The outbox coalesces by UNIQUE (business, kind, product) and reads the value
  **from the database at send time**, never from the row's payload. The assistant may *draft* a
  post or product (`website.post.draft/update`, `website.product.upsert`, autopilot category
  `website`) but **`website.post.publish` is `alwaysConfirm`** — no executor, no category, no MCP
  write tool; a public text under the business's name is a person's click. Drafts use real item
  data from the read tools and never an invented price or figure.

## Phase 37 — SMS/email marketing (messaging)

> **پیام مشتری‌رو، اعتبار پلتفرمی دارد و در دفتر می‌نشیند.** Sending runs through the
> `message_outbox` and the `runMessagingTick()` on the custom server — nothing is
> sent inline and no user request ever waits on a provider. The cost is turned
> into **one journal document per campaign** by the posting engine's
> `message.campaign_cost` rule (Debit `5600 هزینهٔ تبلیغات و بازاریابی` / Credit
> `2455 پرداختنی به پلتفرم (اعتبار پیام)`), never a hand-written ledger call, dated
> on the branch's business day (`app_business_date`). The audience comes only from
> `resolveSegment(..., { purpose })` (consent + a reachable address enforced by
> the CRM bridge) — never a second member path. Provider credentials are
> platform-owned, encrypted at rest, and never returned to a business.
>
> **مدل نمی‌فرستد.** Phase 31 stands: the model may draft a template/campaign but
> pressing send is a human action. The only exception is a pre-authorised deterministic
> coworker event job, still bounded by the Phase 31 messaging caps and exact rendered
> message cost. It creates only campaign/recipient/outbox rows; the tick remains the
> sole path to reserve credit, contact a provider, settle and post cost.
