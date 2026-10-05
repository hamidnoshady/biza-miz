# AGENTS.md

Guidance for every AI coding agent working in this repository — Claude, Codex, Cursor,
Copilot, or anything else.

**Read [CLAUDE.md](CLAUDE.md) first.** It is this repo's full agent guidance (testing gate,
multi-business tenancy, the business day, payment ways, dashboard UI rules, phase layout,
prompt vocabulary) and applies to you whatever tool you run in. Two things cause the most
damage when missed:

- **The only quality gate is the local checklist** in CLAUDE.md — `npx tsc --noEmit`,
  `npm test`, `npm run test:db` (needs the Docker Postgres), `npm run build` — run in full
  before a change is "done". There is no CI; nobody else runs it for you. Say which steps
  you actually ran.
- **Tenancy**: a new tenant-scoped table needs an RLS policy in the same migration, and
  `withoutTenantScope()` is a documented, countable hole — never add one without matching an
  already-justified shape in `src/lib/db.ts`.
- **Shamsi-only dates**: every date shown to a user — in every function and every screen (the
  user/dashboard section and the super-admin/platform section alike), in accounting, loyalty,
  marketing, AI, reports, exports, receipts and notifications — MUST be **Shamsi (Jalali)**.
  Gregorian is only ever internal storage (`timestamptz`/`date`) and the wire/API. Never render a
  raw ISO/Gregorian date to a user, never show a date in a Gregorian calendar, and never use the
  native `<input type="date">` (it opens a Gregorian calendar) — use `JalaliDatePicker`
  (`src/app/dashboard/jalali-date-picker.tsx`). Format every displayed date through
  `src/lib/jalali.ts` (`formatJalali`, `formatShiftWindow`, `jalaliToIsoDate`, `todayJalali`) or
  `Intl.DateTimeFormat` with the `fa-IR` locale (which resolves to the Persian/Shamsi calendar).
  Read the "Shamsi-only dates" section of CLAUDE.md before touching any date.

## Prompt vocabulary

**Product identity rule:** this is a multi-industry platform with exactly four standalone business apps: Accounting, Growth & Marketing, CRM, and Website Management. Sales/POS, operations, inventory, reporting and settings are work areas or shared utilities, not additional apps. The AI assistant is the platform home. Never present the platform as only a café/restaurant POS; hospitality wording belongs in hospitality features. See [docs/app-boundaries.md](docs/app-boundaries.md).

How the user names things in prompts — full version in the "Prompt vocabulary" section of
CLAUDE.md. Don't assume the everyday English sense:

- **Platform** = this whole repo / product. Not `src/app/platform/**` (that's the
  super-admin console) unless they also say super-admin / platform console.
- **App** = one of the four registry keys in `src/lib/apps.ts`: `accounting`, `growth`, `crm`, `website`. Sales/POS and operations belong inside Accounting; settings, connections and AI are shared platform surfaces. The Next.js application, Electron desktop client, WordPress plugin and the two website managers are not extra platform apps.
- **Section** = a menu item / page **inside** an app (loyalty inside Growth; products
  inside the WP manager; deals inside CRM) — never the app itself. When the user says
  "section" they mean those **items in apps**. App availability / enable-and-disable in
  the super-admin console (migration 0128) is **per app**, never per section; a section
  follows its owning app's state. Don't add a per-section enable/disable table.
- **AI assistant** = the platform's main page: `/dashboard` itself — the assistant is
  the dashboard for every tenant (the old `workspace` flag is retired; `/overview`,
  `/ai`, `/dashboard/overview` and `/dashboard/ai` are compat redirects, and its
  management sections open at `/dashboard?aiPanel=<key>`). Not MCP, coworker jobs,
  or autopilot unless those are named. Its three **runtime modes** are `auto`,
  `instant` and `deep_research` — the vocabulary is in
  `src/lib/ai-runtime-modes-shared.ts`, the one file a `"use client"` component may
  import (never `ai-runtime-modes.ts`, which reaches `src/lib/db.ts` and fails the
  client-bundle boundary test). The sections are `memory`, `coworkers`,
  `automations`, `activity`, `research`, `usage`; the retired `agents` and
  `knowledge` values degrade to the chat home rather than 404ing.
- **Agent** = a Superadmin-built, versioned system agent (`ai_system_agents`).
  Nothing a tenant configures is called an agent. The proactive tick's background
  jobs are **scheduled jobs** (`src/lib/ai-scheduled-jobs.ts`). If you are about to
  write "agent" for a tenant-configurable thing, stop — that is the bug this issue
  existed to remove.
- **Website management** = **both** website systems inside the single `website` app: Eshobe CMS (`/websites/cms`) and WP / Woo management (`/websites/wp`). They are peer managers behind one app door; never fold one into the other, and don't default “website management” to only the CMS.

## Accounting is the primary workspace

«حسابداری» is the business's main work menu, not a ledger tool: its sidebar
holds the business's own work areas (فروش، خرید و انبار، محصولات، عملیات،
گزارش‌ها، تنظیمات) **plus** the ledger as one named group, «فضای کار حسابداری».

Two rules when you touch that menu:

- The business entries are **adopted**, never re-declared. The composer
  (`src/app/(app)/accounting/accounting-workspace.ts`) picks them out of the
  nav the shell already built and already gated, by href. Adding a page to the
  menu is one href in `WORKSPACE_GROUP_SLOTS` — writing a second role/module
  check is the bug this design exists to prevent.
- There is **one** people directory: `/accounting/directory`.
  «مشتریان»، «تأمین‌کنندگان»، «فروشندگان» are `?view=` filters of it
  (`src/lib/party-directory.ts`), over one `parties` table, one `/api/parties`
  endpoint and one add/edit form. A person holds a **set** of roles
  (`parties.roles`, migration 0148) with `parties.role` as the primary one that
  decides the accounting-code prefix — so never add a per-role party screen,
  and never assume one person has one role.

Route/nav map and the legacy-URL table: [`docs/accounting-workspace-ia.md`](docs/accounting-workspace-ia.md).

### Canonical route migration rule

When a business workspace route is moved, **only its new canonical route may be
used by application code, navigation, tests, and documentation**. Move the
`page.tsx` out of the old route tree in the same change so the old URL cannot
render the old app page. Preserve existing bookmarks only through the central
permanent redirect table in `src/lib/app-routes.ts`; never leave a duplicate
legacy page, link to the legacy URL, or add a new legacy URL. In particular,
the operational Accounting workspaces use `/accounting/{section}` — not
`/dashboard/{section}`. Reuse `ACCOUNTING_WORKSPACE_HREFS` and
`accountingProductsHref()` instead of spelling former dashboard work-area URLs.

## Design system

**The visual canon is [`docs/design-system.md`](docs/design-system.md).** Read its
**Decision guide** before building or restyling any screen: it maps each UI need to the one
approved component, says when an operational variation is allowed, and lists the checks to
run before calling a screen complete. The page-by-page audit and the ordered remaining work
are in [`docs/design/coverage-matrix.md`](docs/design/coverage-matrix.md).

The short form:

- **Compose, never re-derive.** Dashboard pages/panels compose the primitives in
  `src/app/dashboard/page-chrome.tsx` (`PageShell`, `PageHeader`, `SectionCard`/`cardClass`,
  `CardEyebrow`, `TabBar`/`TabPanel`, `EmptyState`, `KpiCard`/`KpiRow`, `StatusBadge`),
  `src/app/dashboard/data-table.tsx` (`DataTable`, `Th`, `Td`),
  `src/app/dashboard/filters.tsx` (`FilterChip`, `SearchField`),
  `src/app/dashboard/section-nav.tsx`, plus `<Button>` and `ui.tsx`'s
  `inputClass`/`Field`/`ErrorBox`/`InfoBox`. A long Tailwind string copied into a page is the
  bug the primitives exist to prevent — **two lints fail it**, one on spellings
  (`design-lint.test.ts`) and one on shapes (`primitive-lint.test.ts`).
- Warm neutrals come from the **theme tokens** (`bg-card`, `text-foreground`, `bg-muted/60`,
  `border-border`) because they flip in dark mode; a hardcoded `stone-*` with no `dark:`
  pair is a regression. 1px warm hairlines; the one warm card shadow
  (`0 1px 2px rgb(41 37 36/0.035)`); `rounded-2xl` cards, `rounded-xl` pills, `rounded-lg`
  controls.
- **Amber = selection** (active nav/tabs/chips, warnings); **teal = brand** (filled buttons,
  links) and the **form focus ring**; emerald/red only for success/danger.
- **The POS is an approved dense variation, not a template.** Taller targets, denser cards,
  amber CTA — on full-screen operational surfaces only (`FilterChip dense` carries the
  density as a prop). Never push that density onto ordinary CRM, Growth or Website
  Management pages, and never copy one app's nav items or business fields into another to
  make them look alike. Share the language; keep each workflow.
- Numbers: Persian digits are display-only; money uses the business-selected display unit via
  `formatMoneyText`/`useMoney` (Toman or Rial). Never hard-code a user-facing currency label
  or divide by 10 directly. Storage, calculations, journal lines and internal API contracts
  remain integer Rial; every user input must be converted from the selected unit at the
  UI/API boundary and every displayed amount must be formatted with the selected unit.
- Hovers are quiet washes (`hover:bg-muted`); motion is 150–650 ms ease-out, skeletons
  instead of spinners, and `prefers-reduced-motion` is respected.
- **Before calling a screen done:** `npm run test:design` (design + primitive lint + loading
  coverage + reference-screenshot guard), plus the usual `npx tsc --noEmit`, `npm test`,
  `npm run build`. Then look at the
  screen in both themes, both widths, and in its hover / focus / selected / disabled /
  loading / empty / error states. `npm run test:visual` diffs representative screens of all
  four apps against committed baselines — **never re-record a baseline to clear a failure**
  (see [`docs/design/visual-regression.md`](docs/design/visual-regression.md)).
- The approved reference is the 2026-09-18 screenshot set; the pre-2026-09 images are
  archived under `docs/design/reference/archive-2026-09/` and are **historical, not
  normative**. When prose and an approved screenshot disagree, the screenshot wins.
