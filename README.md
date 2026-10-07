# Business Suite — multi-app business platform

A Persian-first (RTL, Jalali calendar, business-selected money display) multi-industry platform with **four standalone apps**: Accounting, Growth & Marketing, CRM, and Website Management. Accounting includes sales/POS, operations, inventory and reporting. Website Management contains two separate SaaS managers, Eshobe CMS and WordPress/WooCommerce. AI, settings and connections are shared platform services. The industry profile adapts the work areas for hospitality, retail, jewelry, cosmetics, wholesale and other supported businesses. See [the app boundaries](docs/app-boundaries.md).

Development history and shipped capability are documented in [docs/phases/README.md](docs/phases/README.md). Early phases began with café/restaurant POS workflows; later phases evolved that foundation into the current multi-industry, multi-app business platform. Phase documents are historical implementation records, not the current product definition.

## Stack

- **Next.js 15** (App Router, TypeScript) — single app, role-based routes
- **PostgreSQL 16** — full schema for all phases migrated up front
- **Tailwind CSS 4** — logical properties for RTL-safe layout
- **Vazirmatn** variable font (bundled locally, works offline)
- Auth: **JWT session cookie** (Owner/Manager email+password) + **4–12-digit PIN quick-login** (Cashier/Waiter/Kitchen)

## Getting started

```bash
# 1. Start Postgres (Docker)
docker compose up -d

# 2. Configure environment
cp .env.example .env    # defaults match docker-compose

# 3. Install, migrate
npm install
npm run db:migrate

# 4. Run
npm run dev             # http://localhost:3000
```

### First run — the Setup Wizard (Phase 1)

On a **completely empty database**, opening the app sends you to `/welcome`, which
creates the business + first Owner account, then walks you through the guided
wizard (`/setup/*`) — no manual DB edits needed. The step sequence is
industry-shaped (`src/lib/wizard-steps.ts` is the one place that decides it):

- **Food service (کافه و رستوران)** — the full path:

  1. **Business info** — name, location, currency/language defaults
  2. **Chart of accounts** — editable pre-built F&B template
  3. **Inventory costing** — FIFO/LIFO/Weighted Average, perpetual vs periodic (locked after the first inventory transaction)
  4. **Tax** — default VAT rate + per-category rates
  5. **Roles & users** — Manager (email/password) and Cashier/Waiter/Kitchen (4–12-digit PIN) *(optional)*
  6. **Menu** — manual entry or CSV/Excel import (downloadable template). The step is only ready once at least one active item exists.
  7. **Hardware** — printer pairing + test print, the *same* panel as Settings → Printers. On the desktop app printing goes straight through Electron; in a browser/cloud till the panel installs the one-click Windows print connector. *(optional)*
  8. **Backup destination** — local-only installs, with a real OS folder dialog *(optional)*
  9. **Opening balances** — opening inventory count + balanced opening journal entry *(optional)*

- **Trade-goods retail (طلا و جواهر، ساعت، بدلیجات، آرایشی، عمده‌فروشی، ابزار، خرازی)** —
  the same path without costing and menu: the catalogue is managed in the products
  workspace (`/accounting/products`, or the trade's own items page), and the wizard's
  finish page points at it.
- **Services / SaaS** — business info, chart of accounts, tax, then the optional
  users/hardware/backup/opening steps.

A standalone desktop install also has `/welcome` ask whether to set up locally or pair
with an existing online business
([docs/standalone-desktop-app.md](docs/standalone-desktop-app.md#first-run--local-setup-or-pairing));
pairing imports an already-configured business and marks setup complete outright.

Until `POST /api/setup/complete` stamps the completion marker (the Finish step), Owner/
Manager logins are routed into the wizard; the dashboard shows a "resume setup" banner.
Reaching a required step does *not* end the wizard on its own — Hardware, Backup,
Opening and Finish stay reachable for every industry. Businesses created ready-to-use by
the platform console (and the demo seed) are stamped complete up front, so they never
enter onboarding.

### Optional: seed a demo business instead

To skip the wizard and get a ready-to-log-in demo:

```bash
npm run db:seed         # creates owner@example.com / owner1234 and a cashier with PIN 1234
```

Log in (the two doors are separate pages):

- **Owner/Manager:** `/admin` — `owner@example.com` / `owner1234` (override via `SEED_OWNER_*` env vars before seeding)
- **Staff quick login:** `/login` — PIN `1234` (sample cashier)

The seed also creates 3 sample dining tables and a small demo menu (2 categories, 3 items,
1 modifier group) so the cashier POS screen has something to sell right away.

### Menu management & the cashier POS (Phase 2)

- **`/dashboard/menu`** (Owner/Manager) — CRUD for categories, items, modifier groups and
  modifiers, plus attaching modifier groups to items. Independent of the wizard's initial
  import — ongoing management.
- **`/accounting/pos`** (Owner/Manager/Cashier) — the cashier screen: category tabs → item
  grid → cart with per-item modifiers, quantity, and an order-level discount (percent or
  fixed amount). Choose dine-in (pick a table from the stub list) or takeaway (gets a
  queue number, e.g. `T-42`), then submit.
- **`/dashboard/orders`** — open orders list and detail view; while an order is `open` you
  can add items, change quantity, void an item, edit the discount, or void the whole order.

### Waiter app & Kitchen Display (Phase 4)

Orders sync live over a WebSocket (`/ws`, see `server.ts` + `src/lib/realtime.ts`) — no
polling. Submitting an order (from the cashier POS or the waiter app) *is* "send to
kitchen": its items land on the KDS as `sent` immediately.

- **`/dashboard/waiter`** (Waiter, + Owner/Manager "all tables" overview) — only the
  sections assigned to the logged-in waiter (`floor_sections.assigned_waiter_id`, set on
  the floor plan). Tap a seated table to add items to its open order/round, see each
  item's live kitchen status, and mark a `ready` item `served` once it's delivered.
- **`/accounting/kitchen`** (Kitchen, + Owner/Manager) — the KDS: one ticket per table
  (grouping every round on that table's open session) or per takeaway order. Its deterministic
  next-ticket queue places overdue tickets first, then `sent`, `preparing`, and `ready`, with
  oldest-first ties—no AI call or credit charge. Tickets outstanding ≥ 10 minutes
  (`DEFAULT_TICKET_AGING_MINUTES`, `src/lib/order-item-status.ts`) flag red. "Bump" moves an
  item `sent → preparing → ready`.
- Every open dashboard screen (cashier orders list, floor plan, waiter board, KDS)
  refetches on the relevant WebSocket event, so no two screens ever show conflicting
  order/table state.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Custom dev server (`server.ts`, via `tsx watch`) — Next.js + the `/ws` WebSocket sync channel |
| `npm run build` | Production build (plain `next build`; no server needed to build) |
| `npm start` | Custom production server (`server.ts`) — same as `dev`, without hot reload |
| `npm test` | Unit tests (Jalali, digits, money, order totals, kitchen ticket status, …) |
| `npm run db:migrate` | Apply pending SQL migrations from `migrations/` |
| `npm run db:app-role` | Provision the unprivileged DB role the app should connect as (Phase 12 — see Multi-business below) |
| `npm run test:db` | Database integration tests (`integration/`), against a real Postgres |
| `npm run db:seed` | Seed business, location, owner, sample cashier (idempotent) |
| `npm run db:seed-knowledge` | Seed/refresh the in-product knowledge base («مرکز آموزش» at `/dashboard/knowledge`) — 11 categories, 14 tags and 45 starter guides, idempotent by slug (see [docs/knowledge-base.md](docs/knowledge-base.md)) |
| `npm run db:restore` | Restore a backup artifact — dry-runs into a scratch DB first (Phase 10, see [docs/backup-restore.md](docs/backup-restore.md)) |
| `npm run db:restore-tenant` | Restore a per-tenant export SQL file into a clean, migrated database — dry-runs by default (Phase 17, see [docs/backup-restore.md](docs/backup-restore.md)) |
| `npx tsx scripts/ws-load-test.ts` | WebSocket load test against a running, seeded server (Phase 9 — see the script header for env knobs) |
| `npx tsx scripts/order-perf-benchmark.ts` | Order-creation and payment/inventory-consumption latency against a running, seeded server (Phase 17 — see the script header for env knobs) |

### Backups (Phase 10)

`/dashboard/backup` (Owner sets schedule/retention/cloud; Owner+Manager can
«پشتیبان‌گیری هم‌اکنون» and see run history). Scheduled `pg_dump` of the whole
local DB to the Owner-chosen destination folder — falling back to `BACKUP_DIR`
when that's left empty, which is every install that predates the desktop app —
plus an optional `BACKUP_SECONDARY_DIR` (USB/NAS), and an AES-256-GCM-encrypted
copy uploaded to any S3-compatible storage. A local-only install has no cloud
half at all (see "Deployment mode" below). Failed/overdue backups raise a red
banner on the Owner dashboard. Restore
(always dry-run first): `npm run db:restore` — full runbook in
[docs/backup-restore.md](docs/backup-restore.md). The host needs
`postgresql-client` ≥ 16 (`pg_dump`/`pg_restore`).

**Per-tenant export & restore (Phase 17)** — the backup above is the whole
physical database; a single business's own data (Owner-only, same page) is a
separate download: `GET /api/backup/export?format=sql|xlsx`, restorable SQL
or a per-table Excel workbook, filtered by ordinary RLS
(`src/lib/tenant-export.ts`). Restore the SQL file into a clean, migrated
database with `npm run db:restore-tenant` — full runbook, including why it
doesn't need a scratch database, in [docs/backup-restore.md](docs/backup-restore.md).

**Moving an install to another server** — the same dump plus a
drain/verify/cutover procedure, with one recipe per hosting platform (Runflare,
plain VPS, Komodo, managed-Postgres PaaS, on-site machine):
[docs/server-migration.md](docs/server-migration.md).

### AI assistant (دستیار هوشمند)

The assistant **is** the dashboard: `/dashboard` is a full-page chat home for every
member who holds `ai.use`, with a floating launcher, and the management sections
(memory, coworkers, automations, activity, research, usage) open in its
«مدیریت دستیار» panel at `/dashboard?aiPanel=<key>`. There are three **runtime
modes**, and only three: `auto`, `instant` and `deep_research`.

- **Wizard mode** — mounted on every `/setup/*` step. You describe the
  cafe/restaurant in chat and the assistant gathers the missing details, then
  proposes a fully-filled payload for that step. Nothing is written until you
  press **«تأیید و اجرا»** (human-in-the-loop); on apply it POSTs to the existing
  `/api/setup/*` endpoint and jumps to the next incomplete step. The wizard pages
  themselves are unchanged — the assistant sits on top of them.
- **Chat on the dashboard home** — it runs the standard reports
  (`run_report`/`list_reports`), inspects setup state, answers questions, and can
  perform allowed "jobs" (e.g. add a menu category/item) — again only through the
  same confirmed-action gate. Which tools it may actually call is the intersection
  of the platform catalogue, the invoked agent's allowlist, the business's enabled
  apps and **the member's own effective permissions**, so a cashier and an owner
  ask the same question and get differently-scoped answers.

Every mutation is restricted to an allowlist (`ACTION_CATALOG` in
`src/lib/ai.ts`) that maps each proposed action to an already permission-guarded
endpoint, so it can never call an arbitrary URL, and an unknown action ID is
refused rather than ignored. Read tools run server-side and never mutate data.
Unattended writes — an `auto` automation, a scheduled job — re-check the acting
member's **current** authority immediately before executing, not the state
captured when the job was queued.

**Wave 5 interaction safeguards.** Before an assistant request reaches a provider,
the chat panel asks for confirmation against a conservative, visible credit-cost
estimate (including the existing maximum reservation). Provider text is relayed
incrementally to the panel; tool rounds and action confirmation remain server-side.
Suggested prompt chips appear on open, and **«توضیح این عدد»** on eligible report
previews/pinned widgets opens the assistant with the visible report context
pre-filled. Every proposed action is recorded in a tenant-scoped audit trail with
the prompting user, proposed payload summary, and applied/failed/dismissed outcome,
available to Owner/Manager in the dashboard assistant's Activity panel (`/dashboard?aiPanel=activity`). No real WhatsApp, Telegram, voice,
SMS, or automatic customer-message channel is introduced.

**Platform-owned provider and billing.** **LiteLLM** is the only supported AI connection;
there is no direct-provider or `AI_API_KEY` fallback. The platform singleton is stored in
`platform_ai_gateway`; app-side `LITELLM_*` connection variables are bootstrap defaults only
until a row is saved. Businesses never enter or receive provider credentials. Each assistant turn is
reserved, settled against provider usage and the Rial wallet/plan allowance, and blocked before
a provider request when the business cannot pay. Plan/Billing—not the AI connection page—owns
prices, allowances, wallet operations and revenue.

**The AI control plane has distinct pages.** `/platform/ai` is the technical gateway and
business/branch key lifecycle page. Runtime modes, published prompt layers, system agents,
research caps and widgets live under `/platform/ai/modes`, `/platform/ai/prompts`,
`/platform/ai/agents`, `/platform/ai/research` and `/platform/ai/widgets`. The fleet is
searchable, status-filtered (ready / missing key / key sync error / entitlement disabled /
branch override / gateway unavailable) and paginated. Selecting a specific `(business,
location)` shows entitlement, gateway readiness, effective credential source, business and
branch key status, inherited-vs-branch credential, effective model alias, last verification
and separate technical sync errors. The old `/platform/ai/gateway` **page URL** redirects to
`/platform/ai`; `/api/platform/ai/gateway` is the live API route. Prompt versioning at
`/platform/ai/prompts` is current and is not the retired prompt-fragment manager.

**Ownership boundaries.** LiteLLM owns upstream deployments, provider routing, retries,
fallbacks, provider-side limits and any proxy budgets. The application owns prompt versions,
runtime modes, permission-filtered OpenAI function tools, tenant isolation, conversation and
research orchestration, and settlement. The app no longer runs its own semantic answer cache
or pgvector RAG stack (migration 0204). It does not send LiteLLM prompt IDs or proxy MCP
declarations from its assistant runtime; the POS's external MCP connector at `/api/mcp` is a
separate surface, not a proxy MCP registry. Old app-side fallback/model/MCP mirror columns
were dropped in migration 0184. A system agent is built/versioned by Superadmin and reaches a
business through an assignment; tenants do not build platform agents.

Billing remains in integer Rial. LiteLLM's USD spend and optional gateway budgets are
reconciliation/technical safeguards, not a second product wallet. Gateway or database
resolution failures fail closed; the app has no second provider to silently fall back to.

The bundled `litellm` service is optional and off by default; when AI is enabled, either run
that profile or point the app at a separately managed LiteLLM instance. Start the bundled
proxy with `docker compose --profile ai up -d litellm` (template:
`docker/litellm/config.yaml`). It is not published to the host because it holds upstream
provider credentials and exposes key-management APIs. The provider secret `OPENAI_API_KEY`
in compose is consumed by LiteLLM only, never by the POS app. There is no tenant provider or
model-settings page; `/dashboard/ai` is a compatibility redirect to `/dashboard`, where assistant
panels use `?aiPanel=...`. `/dashboard/ai/settings` and `/ai/settings` also redirect to the
dashboard. See [Phase 37](docs/phases/Phase-37-LiteLLM-Gateway.md),
[Phase 39](docs/phases/Phase-39-LiteLLM-Only-AI-Platform.md) and
[docs/ai-subsystem-architecture.md](docs/ai-subsystem-architecture.md) for current ownership,
prompt composition, memory and Deep Research details.

**Secret-column rollout (operators).** Against every deployment database, run
`npm run db:encrypt-ai-secrets -- --dry-run`, then `npm run db:encrypt-ai-secrets`, then
`npm run db:encrypt-ai-secrets -- --verify-only` with the app's current
`INTEGRATIONS_ENCRYPTION_KEY` (or `JWT_SECRET`). Deploy the ciphertext-only runtime with
`AI_GATEWAY_SECRET_CUTOVER_DEFER=true`; the normal entrypoint then leaves migration 0209 pending
so production ciphertext-backed reads/probes can be verified on every instance first. Drain
pre-cutover instances, then run `AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true npm run db:migrate`.
Both the migration runner and SQL require that post-verification confirmation when credentials
exist. Remove the temporary flags afterward. See [Phase 39](docs/phases/Phase-39-LiteLLM-Only-AI-Platform.md)
for the full sequence. The local repository cannot establish that production backfill or
verification has occurred.

## On-site deployment (café laptop / mini PC)

A business can run the full Business Suite on its own LAN without an Internet
dependency for day-to-day operation. The supported Windows path is the
standalone installer:

### Standalone installer (no Docker)

The simplest possible install: one `.exe`, no Docker Desktop, no `docker
login`, no manual database setup at all. It bundles Electron (app window +
Node runtime) and a real PostgreSQL 16 (`embedded-postgres` — the actual
Postgres binary, run as a plain background process, not a container) around
the app's own unmodified `server.ts` and migrations. See
[docs/standalone-desktop-app.md](docs/standalone-desktop-app.md) for the
network, persistence, packaging, and currently measured acceptance status.

Either way the install is a **site**, not the central server: set
`DEPLOYMENT_ROLE=site` (Phase 23) so the Server Sync tab shows the central
server's address as derived read-only text — pairing already recorded it —
rather than asking the operator to type it. The VPS sets
`DEPLOYMENT_ROLE=central`, where the connection form is replaced by the paired
site's status and `PUT /api/server-sync/config` refuses outright. Unset, the
role is inferred (`central` if `REMOTE_SYNC_TOKEN`, `POS_DOMAIN` or `ROOT_DOMAIN` is set) and
logged at startup.

Desktop pairing and continuing synchronization use separate credentials. The
Owner chooses the exact location before issuing the short-lived, one-use
pairing code (`XXXX-XXXX-XXXX`). Redemption creates a distinct site-device
identity and a random site credential; only its hash is retained by the hosted
server. Sync requests are consequently scoped to one business and location,
and each site can be revoked independently. Legacy `POS1-…`, per-business and
global tokens remain migration-only compatibility paths.

### Windows standalone installation

The supported Windows 11 deployment is an Electron installer containing the
positively staged production runtime and one embedded PostgreSQL Windows
payload. It does not require Docker, Node.js, or a system PostgreSQL install.
The BrowserWindow, Next.js server, PostgreSQL and print connector remain on
loopback. Trusted phones/tablets connect through the dedicated desktop HTTPS
and WebSocket gateway after installing its local root certificate; the Owner's
Local Devices panel supplies adapter selection, QR onboarding, and optional
Private-profile firewall setup.

Persistent database files, secrets, local identity, certificates, logs and
configuration live under Electron `userData`, outside the installation tree.
Desktop updates are manual in this release; obsolete Docker image download and
execution are not part of the shipped app. See
[docs/server-sync.md](docs/server-sync.md) for the current site-to-cloud scope
and its explicit limitations.

### Holoo (هلو) side-by-side — companion mode

A business that runs Holoo (هلو) as its official books can install this app
*beside* it on the same LAN and use the POS, dashboard, reports and assistant
on Holoo's own data — without migrating. The app installs exactly as above
(the installer is **not** changed); reaching Holoo is one outbound TCP
connection from the same Node process to Holoo's SQL Server, configured from
**Dashboard → اتصال‌ها → نرم‌افزار هلو** (`/dashboard/connections?tab=holoo`).
Reads are always direct SQL; writes go through the official web service first,
with a guarded direct-SQL fallback (pinned profile + typed arming + dry-run +
per-statement audit). Companion mode is gated by the `holoo_companion` feature
flag (off by default), and rows the mirror pulled from Holoo are owned by Holoo
— the API refuses to mutate them with `409 holoo_owned`. Full scope and the
migration path live in
[docs/phases/Phase-26-Holoo-Interoperability.md](docs/phases/Phase-26-Holoo-Interoperability.md).

## Conventions (important)

- **Money** is stored as `BIGINT` **Rial** (smallest unit) everywhere — DB, API, calculations. Formatting as Toman with Persian digits happens only at display time (`src/lib/money.ts`).
- **Dates** are stored as ISO/Gregorian `timestamptz` everywhere. **Jalali (Shamsi) is the only date a user ever sees** — conversion happens only at display time (`src/lib/jalali.ts`), in every screen (dashboard/user and super-admin/platform), and in every module (accounting, loyalty & marketing, inventory, reports, exports, receipts, notifications, AI). Never render a raw Gregorian/ISO date string and never use the native `<input type="date">` (it opens a Gregorian calendar) — use `JalaliDatePicker`. The AI assistant and all reports/export templates already phrase dates in Shamsi.
- **Digits** are stored as Latin numerals; Persian digits are display-only (`src/lib/digits.ts`).
- **Multi-location:** every tenant-scoped table carries `location_id` (business-scoped tables like `users`, `accounts`, `customers` carry `business_id` and a nullable `location_id`). Since Phase 14 a business may have several active branches; `resolveActiveLocation` (`src/lib/setup-state.ts`) is what every route resolves the caller's current branch through, validated against their branch assignment (`src/lib/location-access.ts`).
- **Multi-business:** `businesses` is the tenant, and isolation between tenants is enforced by Postgres row-level security — see below.
- **Business day:** what "a day" means is `app_business_date(ts, tz, start_minutes)` (migration 0076), never a bare `(ts AT TIME ZONE tz)::date` — see below.
- **Payment ways:** how a business takes money is rows in `payment_methods`, not the `payment_method` enum — see below.
- Migrations are forward-only numbered SQL files in `migrations/`, applied by `scripts/migrate.ts` (tracked in `schema_migrations`).

## Payment ways, and splitting a bill (روش‌های پرداخت)

A business names its own ways of taking money and orders them the way its cashiers reach for them
(«روش‌های پرداخت» under تنظیمات → `payment_methods`, migration 0091). «کارت‌خوان» can become «پوز
بانک ملت», a second terminal can sit beside it, and a wallet the shop accepts can be added outright.
The same list, in the same order, is what the POS, the order dialog, the closed-order amendment and
the retail invoice screen offer — `GET /api/payment-methods` is the one source.

One bill can be settled across several of them: ۲۰۰٬۰۰۰ نقدی plus ۳۰۰٬۰۰۰ کارت‌خوان is one checkout
that writes one `payments` row per slice and one journal entry with a debit line per slice.

Four rules carry this, and each of them is load-bearing:

- **A way's `name` is the business's; its `settlement` is the ledger's.** Every way declares which
  of the `payment_method` enum values it behaves like, and that is what decides the account the
  money debits (cash box / bank clearing / receivable / platform receivable). Naming a new way
  therefore never reaches the ledger, and `settlement` is refused once the way has taken money —
  changing it would re-describe payments already posted. Deactivate and add instead.
- **A split settles the bill in full.** The slices must add up to the total, to the Rial
  (`validateTenders` in `src/lib/payment-methods.ts`). There is still no partial payment and no
  balance left open; a cash overshoot is change handed back, not a larger payment (`changeDue`).
  One slice may leave its amount open and take whatever is left — «۲۰۰٬۰۰۰ نقدی، بقیه با کارت» —
  which is also how an ordinary one-way sale is expressed, and what keeps a checkout from failing
  when the till's idea of the total is slightly behind the server's.
- **`payments` rows record the bill; the tip rides on top.** That was always true and stays true
  now that there can be several rows — `orders.tip_amount` holds the tip, and the posting folds it
  into the first slice that actually collected money (`tendersWithTip`; a `credit` slice is passed
  over, since a tip is not put on a tab). The closed-order amendment's re-plan and a refund's
  ceiling both read that sum, so don't "fix" it by adding the tip into the rows.
- **A retired way stays on its old payments.** Deleting is only ever allowed for a way the business
  added and never used; everything else deactivates, and `payments.payment_method_id` keeps naming
  it on every receipt and shift report that already went out.

Splitting is the **order** path (`POST /api/orders/[id]/pay`). The retail industries' invoice posts
through the domain-event engine per line, which settles a sale one way, so that screen picks a way
from the same list and narrows it with `ledgerSettlementFor`.

## In-house production (تولید داخلی, Phase 29)

Some menu items are **made**, not just assembled. A whole cake is built from raw materials once,
yields 8 slices, and each slice is then sold through its own serving recipe (one slice + chocolate
sauce). The recipe model on its own is one level deep and cannot express that: put the cake's
materials in the per-slice recipe and every sale deducts a whole cake; leave them out and the cake
has no cost.

`/accounting/inventory` ← «تولید» adds the missing middle step, for the minority of items that need
it. A **فرمول تولید** says what one batch consumes and how much it yields; a **سند تولید** records
an actual batch, taking the materials out of stock and putting the product in.

**The one thing to know before touching this.** The produced good is an **ordinary
`inventory_items` row**, flagged `is_produced`, with its own base unit («برش») and its own
`avg_cost` — not a parallel model. That is why nothing else needed changing: serving recipes,
sale-time deduction, FIFO/weighted-average costing, stock counts, waste, low-stock alerts,
suggested pricing and cost drift all already work per inventory item. Don't reintroduce a second
notion of "a thing we make".

- **Cost is spread over the *actual* yield.** A tray that came out as 15 slices instead of 16 cost
  the same to make, so each slice cost more. The run's `output_quantity` is what happened, not what
  the formula promised.
- **Conversion cost is optional and is a *contra*-expense.** Labour and overhead entered on a run
  are capitalised into the product (`1310` WIP → `1300`), crediting `5180`. The baker's wage is
  already booked to `5200`; crediting `5180` nets against it so it isn't counted twice, and the
  cost re-emerges as COGS when the cake sells. `5180` is deliberately not in `COST_OF_SALES_CODES`.
- **`1310` is a wash account.** A run issues and completes in one transaction, so WIP is always
  zero at rest — asserted by `integration/production-runs.integration.test.ts`.
- **A run is never edited, only reversed**, and reversal is refused once the batch has been sold
  (`production_output_consumed`) — the same posture stock counts take.
- **Nesting is supported** (sponge base → cake → slice); a cycle is refused.
- `is_produced` is **derived** from a formula naming the item as its output, not a checkbox.

See [docs/phases/Phase-29-In-House-Production.md](docs/phases/Phase-29-In-House-Production.md).

## The AI coworker (همکار هوشمند, Phase 32)

The assistant can answer questions and, within owner-set caps, act on its own judgement. What it
could not do was take an instruction and keep it. An owner who already knows the job — «هر شب که
شیفت بسته می‌شود، نانی که مانده را ضایعات بزن» — had nowhere to put that sentence.

A **job** is that sentence: a ready-made template, the owner's intent (which item, which reason,
which formula), a trigger, and an approval mode. It lives in the dashboard assistant's
Coworkers panel (`/dashboard?aiPanel=coworkers`), and each firing produces a **run** in the
approval inbox.

- **Triggers are business events, not just clock times.** `shift_open`, `shift_close` and
  `day_close` are facts `employee_shifts` and `business_day_closures` already know; a cron
  expression can only guess at them, and guesses wrong on the nights that ran long. The producers
  (`shift-service`, `business-day-service`) only enqueue into `ai_coworker_events`, because a
  cashier clocking out must never fail because of a background job.
- **A job is deterministic, and that is the point.** Its actions are built by a pure function in
  `ai-coworker-templates.ts` from parameters and database facts — no provider call, no credits, no
  `ai_proactive_settings.enabled` requirement (that switch is the *credit* opt-in). An owner cannot
  meaningfully pre-approve "whatever the model felt like at 02:00"; they can pre-approve "write off
  the bread that is left, as spoilage". The model is how you *talk about* the work, not what runs it.
- **Params hold intent; quantities are read at fire time.** The bread job stores «نان، هرچه مانده،
  فساد», never "12". A fixed quantity is clamped down to what actually exists — writing off more
  than there is would open a negative layer at a price nobody paid.
- **`approvalMode: 'auto'` is necessary, never sufficient.** Every action still passes Phase 31's
  per-category caps, measured against values read from the database, and needs a real user's
  authority behind it (`ai_coworker_jobs.authorized_by`). Only an Owner may set a job to `auto`.
  Over a cap means **held** — shown with the reason, and applied by the identical executor the
  moment a human taps approve. Never dropped, never forced.
- **One event, one run.** `UNIQUE (job_id, dedupe_key)` on `ai_coworker_runs` is the whole
  idempotency story: two ticks racing, or one retried, cannot write the same night off twice.
- **Waste can be logged now, but only from a job a human wrote.** `inventory.waste.log` is
  `coworkerOnly`, so `actionTypesForCategory` excludes it and the model still cannot decide on its
  own that stock should go. Phase 31's reasoning — *why* stock left is a fact only a person in the
  room has — holds; the owner just supplies it in advance.
- **Applying opens no new mutation path.** Auto or approved, it runs Phase 31's executors (the same
  service function the route handler calls) and writes the same `ai_action_audit` row, tagged
  `source = 'coworker'`.

**«بازبینی حساب‌ها»** is the other half: twelve deterministic checks over the ledger
(`accounting-review.ts`) — an unbalanced entry, an inventory event that never posted, a settled sale
with no entry, a chart missing an account its own industry template requires, a cheque past its due
date, a drawer variance, an unlocked past period, and so on — each with a severity, the money
involved, a suggested fix and the screen that makes it. It is a **rule engine, not a prompt**: a
language model asked to audit a trial balance produces plausible findings, and a plausible finding
about money is worse than none. It reports and never writes. A check whose query fails is *named*
in `unavailableChecks` rather than silently returning "found nothing", because that is
indistinguishable from clean books — and for the same reason a check whose rows hit the row cap is
named in `truncatedChecks`, so its finding reads as "at least this many" rather than presenting a
capped count as a total.

The whole feature is drivable from a sub app over `/api/v1/coworker/*` and `/api/v1/accounting/review`
under the `coworker.read`, `coworker.write` and `accounting.read` scopes. A public-API write is
attributed to the user who issued the key — an automated write is never anonymous.

See [docs/phases/Phase-32-AI-Coworker.md](docs/phases/Phase-32-AI-Coworker.md).

## Connecting Claude, ChatGPT and other assistants (MCP, Phase 34)

Everything above runs a model *this app* calls. This is the other direction: a **Model Context
Protocol** server at `POST /api/mcp` that lets an owner's own Claude, ChatGPT, Codex or any other
MCP client read — and, if they allow it, change — their business.

Set it up from «اتصال‌ها ← دستیارهای هوش مصنوعی» (`/dashboard/connections?tab=mcp`, Owner only,
gated on the `api_platform` entitlement). Two ways in:

- **Claude (mobile/desktop) and ChatGPT.** Copy the address the panel shows and paste it into the
  client's "add connector" box. That is the whole of it: the client discovers this server's OAuth
  endpoints from the `WWW-Authenticate` header on its first 401, registers itself, and sends the
  owner here to sign in and choose what to grant. No key is typed anywhere.
- **Codex, IDE extensions, scripts.** Mint a `posmcp_…` token from the same panel and put it in the
  client's config as an `Authorization: Bearer` header. Shown once, stored only as a SHA-256 hash.

### What a connection may do

Two independent grants, so read-only is a real choice and the default one:

| Scope | What it reaches |
| --- | --- |
| `pos.read` | Reports, sales, menu, stock, customers, ledger, setup state — the assistant's own read tools, executed by the same code |
| `pos.write` | Menu price/availability, order discount, draft purchase order, stock count, expense, journal **draft**, customer note, production run |

A connection with `pos.write` is additionally in one of two modes, chosen by the owner:

- **«منتظر تأیید بماند» (default)** — the write lands in the owner's approval list on that same
  page and changes nothing until they press تأیید, at which point the stored payload runs unchanged.
- **«بدون تأیید اجرا شود»** — it applies immediately.

Either can be narrowed, widened or revoked later from the connections screen without re-running the
OAuth flow, and a revoke takes effect on the connector's very next call.

### What it deliberately cannot do

- **Log waste.** `inventory.waste.log` is `coworkerOnly`: a coworker job may log it because the owner
  wrote down the item and the reason in advance; a model in a chat window has written down nothing.
- **Post a journal entry.** It can only ever create a *draft* into Phase 16's approval queue.
- **Create or settle an order.** That path is the POS's, and a second one is how a divergent sale
  path starts.
- **Send anything to a customer.** Nothing customer-facing exists in the write catalogue at all.

Every write is recorded in `ai_action_audit` with `source = 'mcp'` and the connection that asked for
it, alongside chat, autopilot and coworker writes, with the same prior state and the same undo. It
runs under the authority of the owner who authorized the connection — a connection whose authorizer
has been deleted can still read, but every write is refused.

### For a model reading this

The server publishes three MCP resources so a client knows what it is looking at before it starts
guessing: `pos://app/overview` (trade, branches, modules, vocabulary), `pos://app/conventions`
(integer Rial vs spoken Toman, Gregorian ISO on the wire vs Jalali on screen, a trading day that is
not a calendar day, decimal quantities as strings) and `pos://reports/catalog`.

See [docs/phases/Phase-34-MCP-Connector.md](docs/phases/Phase-34-MCP-Connector.md).

## Notifications (اعلان‌ها, Phase 35)

Everything the app knew about a shift that came up short, a backup that failed at 03:00 or a
coworker job waiting since last night, it knew **on a screen nobody was looking at**. This is how
those facts reach a phone.

Delivery is the **Web Push** standard (RFC 8030/8291/8292), implemented in `src/lib/web-push.ts`
against Node's own crypto rather than as a dependency. One implementation covers everything the
product runs on:

| Platform | Condition |
| --- | --- |
| iOS / iPadOS 16.4+ | **Only** for a PWA added to the home screen — Safari does not expose `PushManager` otherwise, silently |
| Android, Windows, macOS, Linux | Installed PWA or an ordinary tab (Chrome, Edge, Firefox, Safari) |

Set it up from **تنظیمات ← اعلان‌ها**: «فعال کردن روی این دستگاه» on each phone or till, then one
row per kind of event. The tab is open to every role, because it edits only *your own* devices and
rules.

### How an event gets to a phone

1. A producer calls `recordNotification` — one `INSERT` into `notification_events`, error-swallowing.
   A cashier closing their till never waits on a push service.
2. The 15s tick (`runNotificationTick`, `server.ts`) claims each row and fans it out.
3. `resolveRecipients` picks who hears it: their own rule if they wrote one, otherwise the
   catalogue's default for their role.
4. The bell row (`notification_recipients`) is written, and a push is sent to each of that
   person's devices.

### The rules

A rule is per person, per event, optionally per branch, and carries: which channels
(`push` / the in-app bell), a severity floor, an amount floor for the events that involve money
(«فقط ابطال‌های بالای ۵ میلیون تومان»), and a quiet window.

Three things worth knowing:

- **A missing rule is a default, not a silence.** Notifications work the day the feature ships;
  every deviation from that is something a person chose. Deleting a rule restores the default —
  switching an event off is a rule with `enabled: false`, which is a different thing.
- **Quiet hours suppress the push, never the record.** «بیدارم نکن» is not «به من نگو»: the bell
  row is written either way. `backup.failed` is `critical` and ignores the window outright, which
  is the whole point of it — a week of silently failed backups is discovered exactly when it is
  too late.
- **A rule can narrow what you see, never widen it.** Who may hear about a branch is
  `accessibleLocationIds`, the same Phase 14 function that decides who may act in it.

### What the AI half does

Phase 32's coworker jobs notify at their three outcome points — a run waiting for approval, a run
that produced a report, a run that failed — deterministically, with no model in the loop and no
credits spent. Notifications are deliberately **not** an `ACTION_CATALOG` entry: they write nothing
to the books and need no approval, so putting them through Phase 31's autopilot machinery would
have meant an «ask me first» job having to ask permission before telling anyone anything. MCP gains
no new tool.

An applied run notifies nobody — it did what the owner pre-approved. Nor does a skipped one: a job
that correctly finds no stale bread on 300 nights must not produce 300 notifications.

### Configuration

None required. The VAPID key pair is generated into `platform_push_config` on first use, because an
on-site install has no operator to run a key-generation step. `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
override it when a fleet should share one identity — and must not be *changed* afterwards, since
the public half is baked into every subscription a browser has already minted.

See [docs/phases/Phase-35-Notifications.md](docs/phases/Phase-35-Notifications.md).

## The Growth & Marketing app (رشد و بازاریابی, Phase 36b)

Loyalty, campaigns and gift cards, and seller commission are one app at `/dashboard/growth` —
with a management dashboard of its own («میز کار رشد») the way accounting has one, not three flat
sidebar pages. It is a separate app rather than a page inside one: its launcher sits next to
حسابداری in the workspace rail, and inside its routes the dashboard's sidebar *is* the app's own
menu — its six sections and nothing else, no accounting entries alongside a sub-menu of its own.
The old `/dashboard/loyalty`, `/dashboard/promotions` and `/dashboard/commission` routes redirect
into the app's sections.

- **میز کار رشد** — KPIs over all four engines (campaign discount spend, gift-card and
  store-credit liabilities, points in circulation with an estimated redemption value, commission
  accrued, customers due for a repurchase), top campaigns and top sellers, a merged activity
  feed, and a first-run checklist that jumps to each section.
- **پل حسابداری** — the app's connection to the books, *visible*: the four ledger accounts its
  engines write to (۲۴۱۰ اعتبار فروشگاهی، ۲۴۲۰ کارت هدیه، ۲۳۰۰ حقوق پرداختنی، ۵۲۱۰ پورسانت
  فروش) with balances reconstructed from `journal_lines` — the same reconstruction the trial
  balance does — and a link into `/dashboard/ledger`. Marketing moves money only through the
  posting rules it already had; the dashboard never keeps a number of its own.
- **Campaign management** — life-cycle states (در حال اجرا / زمان‌بندی‌شده / پایان‌یافته /
  متوقف، with the engine's inclusive date bounds), one-tap pause/resume, and the effectiveness
  report (how often each campaign fired and what it cost) beside the form.
- **Roles** — a cashier lands directly on «وفاداری و اعتبار», the one growth surface the sell
  side works with, and never sees commission (compensation data) or the KPI dashboard.
- **Customer projection** — Accounting's A/R customer actions open
  `/dashboard/growth/customers` (optionally selecting the customer). Growth reads the shared
  customer service for its workflow, while CRM remains the canonical record and edit path.

SMS/email marketing grows this app rather than adding a new sidebar peer. CRM (customer
segments, consent, the customer file) and the website manager were both seated here as
forward references and both later became their own apps instead — see "The Website app"
below and [docs/phases/Phase-36c-CRM-App.md](docs/phases/Phase-36c-CRM-App.md).

See [docs/phases/Phase-36b-Growth-Marketing-App.md](docs/phases/Phase-36b-Growth-Marketing-App.md).

### SMS/email marketing (messaging — Phase 37b)

An owner who has named a CRM segment can now send that segment a message, and the cost lands
in the business's own ledger — metered like Phase 18's AI credits and posted by the engine.
The messaging module is a Growth-app module (`src/lib/apps.ts`); see
[docs/phases/Phase-37-Messaging.md](docs/phases/Phase-37-Messaging.md).

- **Platform-owned credits** (`platform_message_config` + `message_credit_ledger`,
  migration `0133`): the platform holds the Kavenegar/SMTP credentials (encrypted at rest) and
  the per-segment/per-email rates; a business's balance is always the SUM of its signed ledger
  and it requests top-ups the super-admin approves.
- **Templates, campaigns, outbox** (migration `0134`): a body is a closed `{{…}}` variable set
  (an unknown variable is a save-time error); launching a campaign snapshots its recipients at
  send time; `runMessagingTick()` on the custom server drains the outbox with backoff and a
  per-business rate cap — nothing is sent inline.
- **Adapters behind one seam** (`src/lib/messaging/provider.ts`): Kavenegar (SMS) and SMTP
  (email, nodemailer), each provider error surfaced with a Persian label. The audience comes
  only from `resolveSegment(..., { purpose })`, so an unconsented member is never reached.
- **Posted cost** (Wave 4): when a campaign completes, the engine posts one document
  (Debit `5600 هزینهٔ تبلیغات و بازاریابی` / Credit `2455 پرداختنی به پلتفرم (اعتبار پیام)`)
  dated on the branch's business day — never a hand-written ledger call.
- **The model never sends.** Phase 31 stands; only a human presses send.
- **Triggered customer messages, project cost centre and attributable ROI** (Wave 5): deterministic
  birthday, three-month-inactivity and order-ready events become consent-safe single-recipient
  outbox campaigns only through an owner-configured coworker job and its approval/cap path.
  Campaigns can select a project and a dedicated promotion; project spend comes from posted
  campaign-cost documents, and ROI is shown only for sales that actually applied that dedicated
  promotion. A campaign without one explicitly says that its ROI is not calculable, never zero.

## Cross-app data ownership and the WP Manager (Phase 40)

Every app keeps ownership of its own system. A reader may receive or synchronise only the data
needed for its own workflow; it does not get a second canonical table or a second system owner.
`src/lib/app-data-rules.ts` is the executable contract and tests enforce one owner per data domain.

In particular, Accounting keeps receivables and ledger entries, CRM keeps canonical customer
records, Growth keeps growth programs, and WP Manager keeps the mapped WordPress/WooCommerce store
mirror and all store-management screens. Accounting's customer views link into Growth's read-only
customer projection; Growth links to CRM when a canonical edit is needed. Technical desktop/API/
MCP/Holoo connections live at `/dashboard/connections`, while the WordPress connection and store
workflows live at `/dashboard/website/wp` — one of the two managers inside «مدیریت وب‌سایت» (see
below). Legacy WooCommerce URLs, and `/dashboard/wp/*` itself, redirect there.

See [docs/phases/Phase-40-App-Ownership-And-WP-Manager.md](docs/phases/Phase-40-App-Ownership-And-WP-Manager.md).

## مدیریت وب‌سایت — one app, two managers

There are two ways for a business here to have a website, and one app for both
(`/dashboard/website`, `src/lib/apps.ts`):

- **سایت‌ساز اشوبه** (`/dashboard/website/cms/*`) — a site on
  [`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms), a separately deployed,
  multi-tenant Payload 3 website platform this app holds one encrypted credential for.
- **وردپرس و ووکامرس** (`/dashboard/website/wp/*`) — a WordPress site the business already
  runs, managed through the plugin or the WooCommerce REST API (Phase 40).

They are peers inside one door: separate connections, separate sections, separate headers,
never folded into each other. The sidebar is built from the business's **real connections**
(`GET /api/website/managers`), so a manager that is not set up shows only its front page and
the screen that connects it. The `integrations` entitlement gates the WordPress half alone —
a business without the add-on still runs the platform site it pays for.

The CMS half is connected over REST with a per-site API key, never embedded and never sharing
a database; the full contract (credentials, endpoints, webhook, DNS/preview setup on both
sides, the build wizard and the billing model) is
[docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md).

### Building a site: دامنه → CDN → نوع سایت → ساخت

«سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.» The CMS renders and serves; it has no
wallet, no plan and no invoice. `/dashboard/website/cms/setup` walks four steps, saving each
answer as it is given:

1. **دامنه** — point a domain the business owns, or buy one through the platform's registrar.
   A quote is free and needs no site; an order is priced, wallet-checked, placed, then billed.
2. **CDN** — ArvanCloud in front of the site, or a recorded «بدون CDN». The zone itself is
   platform-staff work; the business reads its own zone and can purge its own cache.
3. **نوع سایت** — معرفی کسب‌وکار / نمونه‌کار / فروشگاه, plus the plan it runs on. This is what
   the CMS is told at provision time, so it picks the blocks and starter content.
4. **ساخت** — provision, connect, subscribe, in that order: a business is never billed for a
   site whose provisioning failed.

Every charge — the monthly fee, a domain registration or renewal, a setup fee — is settled
against the **same platform wallet** as the assistant and messaging (migration 0130), with the
period as its idempotency key. A wallet that cannot cover a renewal marks the subscription
`past_due` and leaves the site serving; nothing cuts a shopfront off from a cron.

### The CMS manager, day to day

- **Connect or provision** — attach an existing CMS site with a pasted key, or build one through
  the wizard (`POST /api/cms/website/setup/build`); either way the key is stored encrypted
  (`eshobe_cms_connections`, migration 0122) and the browser never sees it.
- **One overview call** — the site's descriptor, pages, catalogue and orders
  (`GET /api/cms/website/overview`), 30s SWR, owner/manager only.
- **A DNS checklist and a live preview** — resolves the customer domain from this server,
  checks it points at the CMS, and reads `domainVerified` from the CMS's own admin flag;
  once all three are green, an in-app iframe shows the live site.
- Order status changes (`PATCH /api/cms/website/orders/[id]`) are the one e-commerce write
  here — the CMS's own hooks settle stock and snapshot the change.

### One-way price and stock sync (Phase 38w)

The manager above talks to *one* CMS. Phase 38w puts a `WebsiteAdapter`
(`src/lib/website/adapter.ts`) between this app and whatever the site is, and wires the site into
the things an owner actually repeats: keeping prices and stock honest, and getting a post drafted
without retyping the menu. The rule it runs on — **سایت ویترین است؛ منبع حقیقت اینجاست** — the
site is a shop window; price and stock are decided here and flow one way.

- **Connect** from «سایت‌ساز اشوبه ← تنظیمات و همگام‌سازی» (owner only, `integrations`; this
  section is where the connections hub's «وب‌سایت» tab moved). The key is tested before it is
  saved and never shown again.
- **Mark what goes.** Nothing is sent until the owner ticks a product; «ارسال قیمت‌ها» and «ارسال
  موجودی» are two separate switches. Both menu items and retail items can be marked.
- **A queue, not a hope.** Changes land in `website_outbox`; a background tick sends them with
  backoff. A hundred sales re-arm one stock row, and the quantity sent is read from the database
  at that moment. Failed and stopped rows have «تلاش مجدد»; «همگام‌سازی اکنون» drains on demand.
- **The assistant drafts, a person publishes.** `list_website_posts`, `list_website_products`,
  `get_website_status` read; `website.post.draft`, `website.post.update`, `website.product.upsert`
  write drafts using real item data. `website.post.publish` always needs your confirmation — even
  with autopilot fully open, even over MCP.

Money is integer Rial across the adapter (the adapter converts to the site's unit); content is
Markdown. Details and the before/after measurements are in
[docs/phases/Phase-38-Website-Manager.md](docs/phases/Phase-38-Website-Manager.md).

## Support ticketing (پشتیبانی, migration 0130)

A full support channel between a business and the platform team, on both sides of the tenant
boundary (same RLS-shape as bug reports — see the console's **پشتیبانی** page).

**Member side** — every signed-in member has a **پشتیبانی** entry in the sidebar
(`/dashboard/support`). Anyone may open a ticket: subject, category (فنی / صورتحساب / حساب
کاربری / پیشنهاد / سایر), priority and a description, with an optional image attachment per
message. The ticket is a conversation thread — the member replies from the same screen, closes
or reopens their own ticket, and sees every platform answer. Owners and managers additionally
see the whole business queue (`canSeeAllBusinessTickets`); everyone else only their own tickets
(enforced in `src/lib/support-service.ts`, on top of RLS).

**Platform side** — the console's **پشتیبانی** page (`/platform/support`, every admin role via
the `support.manage` capability) is a cross-tenant queue with stats (open, waiting on member,
urgent-open, unassigned), filters (status / priority / category / search / «فقطِ من»), the full
conversation, and the lifecycle controls: reply (hands the ticket back as «در انتظار پاسخ
شما»), status, priority, category and assignee. A member's reply reopens a resolved or closed
ticket; an admin reply to a closed ticket leaves it closed. Every platform write lands in
`platform_audit_log` (`support.ticket.reply` / `support.ticket.update`).

Data lives in `support_tickets` + `support_ticket_messages` (migration 0130), both RLS-forced on
`business_id`; the vocabulary and transitions are pure functions in
`src/lib/support-tickets.ts`.

## The business day (روز کاری)

A branch's trading day does not have to start at local midnight. `locations.business_day_start_minutes`
is the minutes after midnight at which it begins, or `NULL` for "not configured" — the default, and
what every branch had before this existed. A café working 18:00→03:00 sets 18:00 and gets business
days running 18:00 → 18:00, so its whole service is one day with one date; on the calendar day it was
two, the dashboard zeroed at midnight with the till still open, and the evening landed on two report
rows.

**Three rules follow.**

- **Never bucket a day inline.** Anything that asks "which day did this happen on" goes through
  `app_business_date(ts, tz, start_minutes)`, and anything that asks "when did the current day start /
  end" through `app_business_day_start` / `app_business_day_end`. A hand-written
  `(closed_at AT TIME ZONE l.timezone)::date` is the bug this replaced: it silently re-splits a night
  service, and it disagrees with every other screen. With `start_minutes` NULL these functions *are*
  the calendar day, so there is no reason to reach past them.
- **The app layer never re-derives the window.** `getBusinessDayStatus` (`src/lib/business-day-service.ts`)
  is the single answer to "what day is it at this branch, and where do the live counters start" —
  the dashboard KPIs, the orders screen and the settings panel all read it. The pure rules it applies
  (parsing the setting, the chart's hour order, how a manual close interacts with the schedule) are in
  `src/lib/business-day.ts` and unit-tested there.
- **The cash-up is what ends the night, not the clock.** A start time alone says when a day *begins*;
  nothing in it can say the service is over, so an 18:00→18:00 branch would sit all morning looking at
  last night's takings. The branch already announces the end through a function that has existed since
  Phase 20 — the cashier closing their shift — so the live window starts at the branch's most recent
  `employee_shifts.ended_at`, and only while **nobody** is still clocked in: a cash-up with a colleague
  on the floor is a handover mid-service, not the end of it. «بستن روز کاری» remains the override for a
  branch whose staff never clock in, and the later of the two wins.
- **Ending the night moves the screens, never the books.** Whichever ended it, reports are deliberately
  *not* derived from it: a sale rung afterwards is still filed under the business day it happened in.
  That is what makes it safe — no cash-up and no button can move money between report rows. Both also
  expire on their own once the next business day begins, so there is no state to clean up.
- **A bill belongs to the shift that opened it.** Every shift-scoped order read buckets on
  `orders.opened_at`, never on `closed_at` — one predicate, `ORDER_OPENED_IN_WINDOW`
  (`src/lib/order-read-service.ts`), shared by the orders screen's settled list and the
  «سفارش‌های شیفت» report so the two cannot disagree. A table opened at 23:30 and finally paid at 08:00
  is one sale, and it is the *night* shift's: that shift seated the guests and rang the items in. So a
  carried-over bill stays in its own shift's list and report however late it is settled, and the shift
  that merely took the last payment is never shown a sale it did not make. Keyed on `closed_at` it did
  both wrong at once — it vanished from the shift that opened it and inflated the one that closed it.
  The still-open queue is unbounded by time either way, so a carried-over table is always settleable;
  it simply files itself back under its own shift once it is.

**What follows the business day.** The reporting views (sales, menu items, modifiers, shift
reconciliation, staff performance, waste, delivery, courier); the dashboard KPIs and sales-trend
chart; the orders screen's settled-order window (whose *contents* are then bucketed by
`opened_at`, per the rule above); `employee_shifts.business_date`; the reports
screens' quick ranges («روز کاری جاری» و…), which anchor on the branch's current business date
rather than on the browser's calendar; the cross-server rollup's `getBusinessToday`; the AI
assistant's default date ranges; and the default date on a new purchase.

**What deliberately does not.** Accounting entry dates — journal entries, expenses, payroll,
AR/AP — still default to `CURRENT_DATE`. Those are fiscal dates governed by fiscal periods and
closing entries, and re-dating them by trading day is an accounting policy decision rather than a
display one; raise it as its own change if a business wants it. Reservations stay on the calendar
day, since a customer books a calendar date. Purchase *reporting* (`v_purchase_expense`) likewise
keeps its own user-entered `purchase_date`.

The setting is per branch, optional, and management-facing: تنظیمات ← «شیفت‌ها و روز کاری».
Changing the start time re-buckets the branch's reporting history (the views derive each row's date
from the current setting rather than from a stored column), which is deliberate — it means "this is how
our day works", not "from today onwards" — and is audited.

## Multi-business tenancy (Phase 12, Phase 23)

One deployment can host many businesses. Three things are worth knowing before working on
anything that touches the database — or the browser.

**Isolation is enforced by the database, not by query authors.** Every tenant-scoped table
has a row-level security policy keyed on the `app.business_id` session setting
(`migrations/0021_row_level_security.sql`). `src/lib/db.ts` applies that setting on every
connection checkout from the tenant context (`src/lib/tenant-context.ts`), which
`getSession()` establishes once per request. So a handler that forgets a `WHERE business_id
= …` gets *fewer* rows, never another tenant's. With no context at all, tenant tables read
as empty — it fails closed.

A handful of operations legitimately cross tenants and go through `withoutTenantScope()`,
each because it has to resolve *which* tenant a request is for before that tenant can be
known any other way: login, platform administration, server-sync and public-API bearer
auth, a narrow write to the global identity table, an employee-session re-check, and
desktop pairing, and host resolution. `src/lib/db.ts`'s doc comment on the function is the
authoritative list — grep for the function to audit the call sites against it.

**Since Phase 23, origin is the second boundary.** Row-level security keeps one tenant's rows
away from another's queries, but it says nothing about the browser: before Phase 23 every
business on a deployment was served from a single origin and told apart by a `/{slug}/dashboard`
path prefix the app itself applied. That means one cookie jar, one `localStorage`, one service
worker, one CSP/CORS boundary shared by every tenant — and origin is the browser's only real
isolation primitive.

Each business is served from `{subdomain}.$ROOT_DOMAIN`, the super-admin console from
`admin.$ROOT_DOMAIN`, and the bare domain is a "which business?" router. A business's origin
has two separate doors: the staff quick login (name-then-PIN) at `/login`, which is what the
root of the origin shows, and the owner/manager password login under the `/admin`
subdirectory of the same origin. Hostnames that are not under `$ROOT_DOMAIN` at all — a stale
DNS record from an earlier zone, say — fail closed in `src/middleware.ts`: everything is a 404
except `/` (which explains the situation), the liveness probe and the host diagnostics, so such
a name can never act as an entrance to a login page or to the super-admin console. The session
cookie deliberately carries **no `domain` attribute** (`sessionCookieOptions` in `src/lib/auth-edge.ts`),
so it is host-scoped and never sent to another business's origin; `src/middleware.ts` additionally
compares the request's host label against the session's own `businessSubdomain` claim and fails
closed on any mismatch. Setting a cookie `domain` would silently undo all of it, which is why
that omission carries a comment saying so.

**The origin is the only tenancy in a URL.** The `/{slug}/dashboard` path prefix is gone: the
dashboard is served at `/dashboard` on the business's own host, nothing generates a prefixed URL
any more, and an old prefixed bookmark 301s to the host that serves that business today. Each
business's subdomain is **typed in English by a super-admin** in `/platform` when the business is
created — it is never transliterated from the Persian business name — and can be renamed later,
with the old host kept as a redirecting alias.

**`ROOT_DOMAIN` is the switch**: setting it turns host-based tenancy on, and an install without
one (the desktop app, a single-café laptop) simply serves `/dashboard` unscoped. The root may
itself be a subdomain — `ROOT_DOMAIN=ac.eshobe.com` puts businesses at `biz1.ac.eshobe.com` and
the console at `admin.ac.eshobe.com` — in which case the wildcard certificate has to be
`*.ac.eshobe.com`, since one for `*.eshobe.com` does not cover a name a level deeper. ACME will
not issue `*.$ROOT_DOMAIN` over an HTTP-01 challenge, so the Traefik certresolver must use DNS-01;
`SUBDOMAIN_ROUTING=off` is the escape hatch for a deployment whose certificate is not issuing yet.
`WEBAUTHN_RP_ID` defaults to `ROOT_DOMAIN` for the same reason biometric login needs it to: a
browser only accepts an RP ID that is a registrable suffix of the page's origin.

**With the switch off, the staff login still reads the host — as a hint, not a boundary.** A
platform that serves `{subdomain}.{domain}` while `ROOT_DOMAIN` is unset (or held at
`SUBDOMAIN_ROUTING=off` until its wildcard certificate issues) parses every host as unknown, and
the staff quick login — which is the whole of a business origin's front door since the login split
— then has nothing to name a tenant with. So the PIN-login family matches the hostname's first
label against `businesses.subdomain` (and its rename aliases) before falling back to "the only
active business": `titea.app.eshobe.com` finds titea whether or not host tenancy is switched on.
Nothing is guessed — the label decides nothing unless a business row claims it, and a host that
matches none is still refused rather than pointed at some other shop. This is *not* the isolation
boundary; that is `ROOT_DOMAIN` plus the host-scoped cookie, and it is still what you want in
production.

**Behind a managed platform rather than Traefik, set `TRUST_FORWARDED_HOST=on`.** A PaaS/CDN edge
routes by hostname itself and gives the container an internal `Host` (`web-1234.internal:3000`),
leaving the browser's hostname in `X-Forwarded-Host`. Tenancy is decided from `Host` by default —
correct behind Traefik, which passes it through untouched — so on such a platform every request
would parse as an unknown host and fail closed. `GET /api/host/resolve?debug=1` shows which header
the app used and how it parsed, which is the quickest way to tell. See
[docs/phases/Phase-23-Subdomain-Tenancy.md](docs/phases/Phase-23-Subdomain-Tenancy.md).

**The app's database role must not be a superuser.** Superusers and `BYPASSRLS` roles ignore
row-level security entirely, which would make every policy a silent no-op. The `pos` role
that `docker-compose.yml` creates *is* a superuser — fine for local single-business work,
not for a hosted deployment:

```bash
APP_DB_PASSWORD=$(openssl rand -hex 32) npm run db:app-role
# then point DATABASE_URL at postgres://pos_app:<that password>@…
```

Migrations keep running as the owner. `server.ts` refuses to start in production when the
configured role can bypass RLS, and warns in development.
`integration/tenant-isolation.integration.test.ts` provisions its own unprivileged role, so
the policies are proven by `npm run test:db` regardless of how the local database is set up.

**Connection pool size** (`DB_POOL_MAX`, default 20). A transaction (order creation, payment
+ inventory consumption) pins one connection for its full lifetime, so the right ceiling
scales with how many businesses' concurrent write transactions one deployment expects to
serve — several busy cafés sharing one host need more headroom than a single one. See
`src/lib/pool-config.ts`.

**Surviving a database blip** (`DB_CONNECT_ATTEMPTS`, default 4). The app reaches Postgres by
*name* over a container network, so every new pool connection starts with a DNS lookup against
the container runtime's resolver — and that resolver drops queries under load and goes away
entirely while the network is reconfigured or the database container is replaced. Node reports
it as `getaddrinfo EAI_AGAIN <host>`, and node-postgres has no retry of its own, so one dropped
lookup used to fail whatever page or background tick asked for a connection at that instant.
`src/lib/db-retry.ts` retries the **checkout** — never a statement already in flight, which is
what makes it safe to repeat — backing off 100ms/300ms/900ms, and only for failures that mean
"couldn't reach it" (a rejected password or a missing database still fails at once). The pool
also holds connections open for a minute with TCP keepalive, so an idle deployment isn't
re-resolving the host every ten seconds; a checkout that can't connect gives up after 30s
(`DB_CONNECT_TIMEOUT_MS`) rather than hanging on the resolver's full budget; and an
idle-client error is logged instead of taking the process down with it. When a lookup keeps failing, one line per minute names the host and
says what to check: the app and Postgres containers must share a network, and the host in
`DATABASE_URL` must be the database service's name on it.

**Docker deployments (`docker-entrypoint.sh`) do this for you.** Every shipped compose file
(`docker-compose.local.yml` and `docker-compose.srv1.yml`, plus the retired
`archive/deploy/docker-compose.komodo.yml` and `archive/deploy/docker-compose.srv1.yml`)
hands the app container one Postgres superuser — the same one that runs migrations — because asking
every operator to hand-edit their stack's environment to carry a second role and password
isn't worth the friction. The entrypoint migrates with that connection as usual, then runs
`scripts/derive-runtime-database-url.ts`, which provisions `pos_app` from it (reusing its
password — nothing new to configure) and launches the server with *that* connection instead.
An already-restricted `DATABASE_URL`, or an explicit `RUNTIME_DATABASE_URL`, are both left
alone. This is why the compose files' `DATABASE_URL` staying a superuser is fine, on purpose —
it never reaches the running server process.

**Identity vs membership.** `platform_users` is the login identity (globally unique email);
a row in `users` is that person's *membership* of one business, carrying their role, PIN,
permission overrides and default branch. One person can hold several memberships and switch
between them (`/api/auth/switch-business`). PIN-only staff have no platform identity and
belong to exactly one business.

**Deployment profile.** `settings['deployment.profile']` records `cloud`, `hybrid`, or
`local` per business. This is separate from the process runtime role (`central | site`) and
from transient connectivity. Migration 0172 and the single adapter in
`src/lib/deployment-mode.ts` preserve older `deployment.mode` records: legacy `connected`
means Hybrid on a site process and Cloud on a central process. New code never writes the old
key. A Local install turns off cloud-dependent entitlements (`ai_assistant`,
`multi_location`, `integrations`, `site_cloud_sync`) while Accounting, CRM and local
operations remain available. See [docs/deployment-architecture.md](docs/deployment-architecture.md)
for capability enforcement, data ownership, connection state and sync behavior.

**Dashboard URL carries the business's slug.** The browser sees `/{slug}/dashboard/...` —
the business's slug (its stable, human-readable "english name", set at signup/provisioning
and immutable after) — while every page still lives at `/dashboard/...` underneath.
`src/middleware.ts` handles the whole thing: the bare form redirects to the slugged one (so
every existing internal link still works), and the slugged form is rewritten back to the real
route, validating the slug against the caller's own session and redirecting to the correct one
otherwise. The slug rides on the session JWT (`businessSlug`, minted at
login/switch/impersonate — see `src/lib/auth-edge.ts`) specifically so this needs no database
lookup in the Edge runtime; a token from before that field existed just serves the dashboard
unprefixed until the next login re-mints one. `RESERVED_SLUGS` in `src/lib/slug.ts` keeps a
business from ever being assigned a slug that collides with a top-level route (`dashboard`,
`api`, `login`, …).

## Super-Admin Console (Phase 15)

A platform operator administers every business on the deployment from a **separate console at
`/platform`** — provisioning, entitlements, health and support — without ever being a member of any
business. It is a distinct auth realm: `platform_admins` log in against their own JWT cookie
(`pos_platform_session`, path-scoped to `/platform`), and `src/middleware.ts` keeps the two realms
disjoint — a tenant session can't reach `/platform`, and a platform session can't be used against a
tenant API route.

Mint the first platform admin (support / engineer / owner role):

```bash
npm run db:platform-admin
```

The console (dark chrome, deliberately unlike the tenant dashboard's light theme) covers:

- **Businesses** — provision a working business end-to-end (owner + chart of accounts + first
  branch, the owner logs straight in), then suspend / reactivate / archive / reset / hard-delete.
  Suspending blocks members at login and at the API guard without deleting anything. Reset and
  hard-delete are both immediate and irreversible, with no archive step or grace window — the only
  safety net is the owner-only capability plus typing the fixed confirmation phrase (`delete-me`,
  `DESTRUCTIVE_CONFIRMATION_PHRASE` in `src/lib/platform-admin.ts`) into the console.
- **Plans & feature flags** — assign a plan or override a single `business_features` flag per
  business.
- **Support / impersonation** — enter a business read-only or full-access; impossible without an
  audit record naming the admin, the business and the time window. Every impersonated action is
  tagged in `platform_audit_log`, viewable in the console's **Audit** tab.
- **Support desk** (migration 0130) — every business's support tickets in one cross-tenant queue:
  reply to the member, re-prioritise, re-categorise, assign to a colleague, and move the ticket
  through its lifecycle (`open → in_progress → waiting_customer → resolved → closed`). Available
  to every admin role (`support.manage`); every console write is audited. See
  [Support ticketing](#support-ticketing-پشتیبانی) below.
- **System** — migration status, RLS effectiveness, pool health, per-business backups.
- **Updates** — read-only visibility of the versions reported by connected on-site installs.
  Desktop update installation is manual in this release; this page stores no distribution
  credential and downloads or executes nothing. See
  [docs/standalone-desktop-app.md](docs/standalone-desktop-app.md). This is the general pattern
  for cross-business client supervision: it belongs in this console, not a per-business
  dashboard — see `CLAUDE.md`.
- **Admins** — the platform admin roster (owner-only). Capabilities are gated by role
  (`src/lib/platform-admin.ts`): support = read + read-only impersonation; engineer adds feature
  writes, suspend/reactivate and impersonation revoke; owner adds full impersonation,
  provision/archive/delete and admin management.

## Accounting Suite (Phase 16)

The Phase 7 double-entry ledger (chart of accounts, auto-posting for payments/purchases/COGS/
waste, trial balance) becomes a suite an accountant can actually close a year on, all under
`/accounting` and `/accounting/reports` (Owner/Manager + the `accountant` role):

- **Fiscal years & periods** — soft-close and hard-lock a period so nothing posts into it, with
  a controlled reopen; year-end closing entries roll P&L into retained earnings.
- **Financial statements** — P&L, balance sheet, and cash flow, each with period comparison and
  drill-down to the journal entries behind any figure.
- **AR/AP subledgers** — customer/supplier balances, invoices/bills, receipts/payments, aging
  buckets and statements. The Accounting customer workflow links into Growth at
  `/dashboard/growth/customers` (including the selected customer for an A/R statement), where
  Growth shows a read-only projection for its own workflows. The customer *directory* and
  canonical record remain CRM-owned: `/dashboard/customers` is a compatibility redirect to the
  CRM directory (Owner/Manager/Cashier/Accountant, gated by the `customers.view`/`customers.manage`
  permissions), independent of the `ledger` feature flag.
- **Bank & cash reconciliation**, **expense management** (categorised, with attachments and
  recurring expenses), and **payroll entries** (accrual/payment postings, not a payroll engine).
- **Manual journals** — draft → review → post, reversal rather than deletion, recurring
  templates, and an approval permission distinct from posting.
- **Chart-of-accounts customisation** and **VAT/tax reporting** (output vs. input VAT, net
  payable position).

### Correcting a closed order

An order that has already been paid for can still be edited or removed — from its detail page
(`/dashboard/orders/{id}`), behind the `orders.amend_closed` permission (owner and manager by
default) — and the correction is a real one, not a cosmetic change to `orders.total`:

- Everything the checkout posted is reversed at its **own recorded values**: the revenue, VAT,
  tip and platform-commission entry and the COGS entry are mirrored line for line, the exact
  inventory consumption is put back at the cost it left at (cancelling any negative layer it
  opened), the A/R balance a credit sale created is cleared, and the payment is cancelled.
- An **edit** then re-posts the corrected bill in its place — fresh consumption, fresh revenue
  and COGS, fresh settlement (optionally through a different tender). A **removal** stops after
  the reversal and sets the order to `voided`, which is what drops it out of every order-derived
  report — they all filter on `status = 'completed'`.
- Both are dated on **the day the order was sold**, not the day of the correction — the journal
  entries *and* the stock movements, so the two ledgers agree about which day the goods moved.
  A locked or soft-closed fiscal period therefore refuses the amendment (migration 0024's
  trigger) rather than silently moving it, and a business pushing daily summaries to a central
  server (Phase 9) has its push high-water mark wound back to the amended day so central
  converges on the correction instead of keeping the stale figures.
- Every amendment records a mandatory reason, a before/after snapshot of the bill, and an
  `audit_log` row. An order that already has a customer return standing against it is refused —
  reverse the return first.

The line-level immutability guards (migration 0014) are **not** relaxed for this: an amendment
takes the same `FOR UPDATE` lock and announces itself with `app.order_amendment` for the length
of its transaction. Grep for that setting to audit every place a settled order's lines may move.

Two things it deliberately does **not** do, both of which matter when correcting an old order:

- **Sales made after it are not re-costed.** Under FIFO the restored stock re-enters the queue
  at the original order's own position, so its cost basis is exact — but sales that consumed
  layers in the meantime keep the COGS they were posted at. Correcting those would mean
  re-costing a chain of later sales, which this does not attempt.
- **It does not move cash.** Reversing a week-old cash sale takes the money out of the *books*,
  not out of the drawer, so a shift that was already counted and reconciled that day will no
  longer agree with the count recorded then. When the customer actually got money back, a
  customer return (`/api/orders/[id]/returns`) is the more faithful record — an amendment says
  the sale never should have been rung up that way.

### Recording a past sale — removed

«ثبت سفارش گذشته» (a panel on the orders screen, the `orders.backdate` permission and
`POST /api/orders/backdated`) has been removed. Typing a sale in after the fact writes revenue,
VAT, COGS and stock into a day that has already been reported on and reconciled, and in practice
the same branches used it to paper over counting mistakes rather than to enter genuine paper
bills. The orders already recorded through it remain ordinary `orders` rows and are untouched, as
is migration `0093_backdated_orders.sql` and the `backdated_orders` rows it holds; nothing was
deleted from the books.

A closed sale that was rung up wrongly is still corrected through the amendment flow above
(`/api/orders/[id]/amend`), which posts a dated correction instead of a new past sale. Migrating
historical trading from another system is an import rather than a till action: the Holoo migration
writes order-ticket sales through `src/lib/integrations/holoo/imported-sale-service.ts`, which
dates `orders.opened_at`/`closed_at`, `payments.received_at`, `stock_movements.occurred_at` and
`journal_entries.entry_date` to when the sale happened — so a closed fiscal period refuses the
import (`fiscal_period_locked`) rather than absorbing it into the current one — while taking the
order number off the branch's ordinary counter and never attaching a `table_id`.

## Feature Gating & Platform Hardening (Phase 17)

With many businesses on one deployment, this phase is what makes it safe to run for paying
strangers rather than just isolated by construction:

- **Flag-driven gating** — the feature flags Phase 12 modelled and Phase 15 administers actually
  gate UI *and* API; a disabled feature is hidden in the nav and refused at the guard, not just
  hidden client-side.
- **Plan limits** (`plans` table, `src/lib/plan-limits.ts`) — per-plan ceilings on branches,
  members and monthly orders, enforced at the point of creation with a clear Persian error
  rather than a crash. Three tiers ship by default (`free`/`pro`/`business`); exceeding a limit
  blocks the action, it never degrades existing data.
- **Per-tenant export & restore** — see [Backups](#backups-phase-10) above.
- **Tenant-scoped rate limiting** (`src/lib/rate-limit.ts`, enforced in `src/middleware.ts`) —
  per-business, per-sync-token, and per-IP-on-login limits so one business's traffic (or a
  runaway offline-sync client) can't degrade another's.
- **Generated isolation test suite** (`integration/tenant-isolation.integration.test.ts`) — proves,
  from `pg_policy` itself, that every tenant table's RLS policy both exists *and* actually scopes
  by business — a future migration that adds a table without one fails `npm run test:db`, not
  production.
- **Multi-tenancy performance review** — `integration/query-performance.integration.test.ts`
  proves the RLS design stays index-backed at realistic scale; `DB_POOL_MAX`
  (`src/lib/pool-config.ts`) replaces a hardcoded pool size; `scripts/order-perf-benchmark.ts`
  established the first order/payment latency baseline.
- **Security review** — impersonation revocation is now actually enforced (not just recorded),
  the tenant and platform-admin realms reject each other's session tokens, server-sync moved off
  a single global token onto per-business hashed tokens, and `JWT_SECRET` now has a minimum
  length requirement in production (`src/lib/jwt-secret.ts`), not just an unset/placeholder check.

## Decisions on Phase 0 open questions


Defaults chosen to keep moving; each is easy to revisit.

1. **Dev Postgres** — Docker Compose (`postgres:16-alpine`). The same compose file works on the eventual on-site mini PC; nothing assumes a cloud host.
2. **Repo structure** — single Next.js app with role-based routes (`/dashboard`, later `/cashier`, `/waiter`, `/kds`). A monorepo split is deferred until a client genuinely needs a separate deployable; nothing so far justifies the overhead.
3. **Auth details** — Owner/Manager JWT sessions last **12h** (configurable via `SESSION_HOURS`). No 2FA in v1; the schema doesn't block adding it later.
4. **PIN login** — **4 digits**, unique **per location** (PINs are bcrypt-hashed; uniqueness is enforced at PIN-assignment time in the app layer, since hashes can't carry a DB unique constraint).
5. **Font** — Vazirmatn (bundled woff2, SIL OFL) as primary, with `Tahoma, Segoe UI, sans-serif` fallback for Latin text/SKUs.
6. **Versions** — Node ≥ 20 (developed on 22), PostgreSQL 16. The schema uses PG15+ features (`UNIQUE NULLS NOT DISTINCT`).

## Phase 0 exit criteria → where satisfied

| Criterion | Where |
|---|---|
| Seed one Owner and log in | `npm run db:seed` + `/login` |
| Empty RTL dashboard shell | `/dashboard` (`dir="rtl"`, Vazirmatn, logical properties) |
| Migrations run clean on empty Postgres | `migrations/0001_foundation.sql` via `npm run db:migrate` |
| ISO → Jalali → back with no drift | `src/lib/jalali.test.ts` (round-trips every day 2020–2030) |
| Integer rial displays as Toman | `src/lib/money.test.ts` |
