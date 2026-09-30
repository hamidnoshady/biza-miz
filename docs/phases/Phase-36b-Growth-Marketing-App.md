# Phase 36b — the Growth & Marketing app («رشد و بازاریابی»)

> Filed as **36b** because it is the direct continuation of Phase 36's wave 1
> (#359): the registry grouped loyalty, campaigns/gift cards and commission
> under one app key, but the three surfaces stayed three flat sidebar pages.
> This phase builds the app that key was promising. The next phases keep their
> issue numbers — CRM is #367 ("Phase 36" in issue numbering), messaging #372,
> the website manager #378. CRM and the website manager were both expected to
> grow this app as sections; both instead became their own apps once built —
> see "Revised once more" below.

## Why

Loyalty, campaigns and gift cards, and seller commission were built right —
each with a pure engine, a service, and a posting rule that puts its money in
the ledger (store credit credits ۲۴۱۰, gift cards ۲۴۲۰, commission debits ۵۲۱۰
and credits ۲۳۰۰). But they were reached as three unrelated pages, and the
facts an owner actually wants — «بازاریابی‌ام چه خبر؟», what campaigns cost,
what we owe customers and staff because of marketing — were scattered across
them and the trial balance.

The accounting suite had already solved this shape for the money side: one
route, a rail of sections, each section a screen with its own data
(`ledger-manager.tsx`). This phase gives marketing the same container:

- **`/dashboard/growth`** — the app's home, a management dashboard («میز کار
  رشد») over all four engines, plus one section per engine. Same
  `SectionNav` rail pattern as حسابداری, same chrome, nothing new invented.
- The three flat sidebar entries collapse into **one** entry, «رشد و
  بازاریابی». The old routes (`/dashboard/loyalty`, `/dashboard/promotions`,
  `/dashboard/commission`) redirect into the app's sections, so bookmarks,
  saved bottom-nav slots and assistant links keep working.
- **The connection to accounting is not just kept, it is made visible**: a
  «پل حسابداری» card on the dashboard shows the four ledger accounts this app
  writes to, with balances reconstructed from `journal_lines` — the same
  reconstruction the trial balance does — and a link into `/dashboard/ledger`.

## The architecture rule, kept

Per the ecosystem's rule — *a new app adds modules, a section screen, read
tools and posting rules; not a second write path* — this phase added:

- **No new tables.** The dashboard reads `promotions`,
  `promotion_applications`, `customer_points`, `gift_cards`,
  `commission_accruals`, `customers`, `accounts` + `journal_lines` — tables
  the engines already own.
- **No new ledger writes.** Issuing a gift card from the new section runs the
  same `promotions.gift_card_issued` event and the same posting rule the old
  page ran; the KPI card reads the liability the rule posted. A marketing
  dashboard that disagrees with the books would be worse than none, so every
  balance on it *is* the ledger's.
- **One new read endpoint**, `/api/growth/overview` (owner/manager — it
  aggregates commission, which is compensation data, the same line the
  ledger's payroll tab draws), plus a widened `GET /api/promotions` that
  returns the management catalogue (name, `is_active`, date window as text)
  instead of the engine's name-less shape. That widening also fixed a real
  bug: the old page rendered `p.name` from a payload that never carried one.

Accounting's customer surfaces are a later cross-app reader, not a change to
this app's ownership. The A/R customer list and statement link into
`/dashboard/growth/customers`, where Growth shows a read-only customer
projection. CRM remains the canonical customer-record owner; Growth reads the
shared customer service and links back to CRM for edits. See Phase 40.

## What the dashboard shows

| Card | Source of truth |
| --- | --- |
| تخفیف کمپین‌ها · ۳۰ روز | `promotion_applications` (applications count, discount sum) |
| بدهی کارت هدیه (۲۴۲۰) | `journal_lines` balance of ۲۴۲۰ + `gift_cards` issued in window |
| اعتبار فروشگاهی مشتریان (۲۴۱۰) | `journal_lines` balance of ۲۴۱۰; `customer_points` for engagement |
| پورسانت فروشندگان · ۳۰ روز | `commission_accruals` (۵۲۱۰/۲۳۰۰ by rule) |
| امتیاز در گردش | `Σ customer_points.points`, with the default program's rate as an *estimated* redemption value |
| آمادهٔ خرید مجدد | `customersDueForRepurchase` for the caller's branch |

Plus: top campaigns and top sellers leaderboards, a merged **activity feed**
of the last events across all four engines (a campaign firing, points earned
or redeemed, a card issued, a commission accrued), the bridge card, and a
first-run «شروع برنامهٔ رشد» checklist whose buttons jump to the sections.

Windows are **rolling 30-day ranges** over the stored Gregorian ISO dates,
deliberately not calendar months, so a number means the same thing on any day
it is opened.

## Campaign management, added

The campaigns section keeps the engine untouched (`promotions.ts` still
decides every discount deterministically) and adds the management half:

- every campaign labelled **در حال اجرا / زمان‌بندی‌شده / پایان‌یافته /
    متوقف** — `classifyCampaign()` in `growth-shared.ts`, inclusive date
    bounds exactly as the engine reads them, and a paused campaign answers
    «متوقف» even mid-window;
- **one-tap pause/resume** through the existing `POST /api/promotions`
    upsert, sending the full row so nothing else changes;
- the **effectiveness report** (how often each campaign fired and what it
  cost) rendered beside the form, over the same 30-day window as the KPIs.

## Files

| File | What |
| --- | --- |
| `src/lib/growth-shared.ts` (+ test) | Framework-free half: campaign states, window math, bridge account list, balance signing |
| `src/lib/growth-overview.ts` | The one dashboard query, read-only |
| `src/app/api/growth/overview/route.ts` | GET, owner/manager |
| `src/app/dashboard/growth/page.tsx` | The app's route; validates `?section=` deep links |
| `growth-manager.tsx`, `growth-sections.ts` | The rail + the shared section keys (a `"use client"` export is a stub on the server, so the keys live apart) |
| `overview-section.tsx`, `campaigns-section.tsx`, `gift-cards-section.tsx`, `loyalty-section.tsx`, `commission-section.tsx` | The screens — the three old pages' substance, moved, plus the dashboard and campaign states |
| `src/app/dashboard/{loyalty,promotions,commission}/page.tsx` | Now redirects into the app |
| `src/app/dashboard/layout.tsx`, `dashboard-sidebar.tsx` | One nav entry; the workspace rail's growth href prefers the new route |
| `src/lib/promotions-service.ts` | `listPromotionCatalogue()` — full rows, dates as text |
| `src/lib/apps.ts`, `src/lib/industry-profile.ts` | The growth app's description; `/dashboard/growth` in `PAGE_MODULE_PREFIXES`, anchored on `loyalty` |

## Roles

The app's page admits owner, manager and cashier; **the rail restricts
itself**: a cashier lands directly on «وفاداری و اعتبار» — the one surface
the old `/dashboard/loyalty` gave them — and never sees commission
(compensation), the campaigns/gift-card counters, or the KPI dashboard, the
same way the ledger drops its payroll tab for a manager. A deep link a role
cannot use (`?section=commission` as a cashier) falls back to that role's
first section rather than an empty panel.

## Exit criteria

| # | Criterion | Where it is met |
| --- | --- | --- |
| 1 | One sidebar entry opens the app; the three old routes redirect into its sections | `layout.tsx`; the three redirect pages |
| 2 | The dashboard's gift-card and store-credit numbers equal the trial balance's | Both reconstruct from `journal_lines`; `GROWTH_BRIDGE_CODES` is exactly ۲۳۰۰/۲۴۱۰/۲۴۲۰/۵۲۱۰ |
| 3 | Issuing a gift card from the app still posts cash/۲۴۲۰ and appears on the dashboard | Verified live: `promotions.gift_card_issued` → ۱۱۰۰ debit, ۲۴۲۰ credit, bridge reads it back |
| 4 | A campaign starting today is «در حال اجرا», not «زمان‌بندی‌شده» | `classifyCampaign` inclusive bounds; catalogue casts dates to text; unit tests |
| 5 | Pause/resume changes nothing but `is_active` | The row is POSTed whole; the upsert is unchanged |
| 6 | A cashier sees only وفاداری; the overview API refuses them (403) | `growth-manager.tsx` filter; `requireRole("owner","manager")` |
| 7 | No new table, no new write path, no new `withoutTenantScope` reason | `growth-overview.ts` is read-only and runs inside the caller's tenant scope |
| 8 | `npx tsc --noEmit`, `npm test`, `npm run build` green | Locally and CI |

## Revised again — the app owns its own main sidebar

The revision above moved the app out of the flat pages but not out of the
accounting shell: `/dashboard/growth` still rendered inside the dashboard's
sidebar, which listed the business's own pages (حسابداری, گزارش‌ها, تنظیمات…),
while the app's section menu was drawn *inside the page*, next to it. Two
symptoms, one cause — the app was a guest in another product's chrome. Clicking
«رشد و بازاریابی» looked like opening a sub-app of accounting, and its menu was
a sub-sub-menu.

So the sidebar slot itself is now handed to the app:

| File | What |
| --- | --- |
| `src/lib/app-shells.ts` | The registry of apps that own their main sidebar — the route prefix they own, their name, their one line of description. `appShellForPathname` is the whole rule, and it matches path segments, so `/dashboard/growthlab` is not inside the app. |
| `src/app/dashboard/app-shell-nav.ts` | Which component fills the slot for an app. `dashboard-sidebar.tsx` asks the map; it never names an app. |
| `src/app/dashboard/growth/growth-nav.ts` | The app's menu entries — label, line of help, glyph — filtered by `canViewGrowthSection`, so the menu and the route guard are the same rule. |
| `src/app/dashboard/growth/growth-app-nav.tsx` | The menu, drawn in the dashboard's sidebar slot. Also carries «بازگشت به میز کار» (the rail) or «بازگشت به داشبورد» (the classic shell), which is the only way out — deliberately, since the app is not a page of accounting. |
| `src/app/dashboard/growth/growth-app-shell.tsx` | Header and page only. The in-page rail is gone, so the section gets the full 1600px column. |
| `src/app/dashboard/sidebar-nav-styles.ts` | The one amber-selection button skin, shared by the rail, the flat nav and an app's own menu — three menus, one look. |

What this changes for the business, and what it does not:

- Inside `/dashboard/growth*` the sidebar lists the app's six sections and
  **nothing else** — no حسابداری, no گزارش‌ها. The accounting suite keeps the
  business nav exactly as it was; `appShellForPathname` is the only thing that
  decides whose menu a route gets.
- The growth entry is dropped from the business nav by href (`isInsideAnyAppShell`)
  rather than by module, and only where the workspace rail exists to launch the
  app from. With the flag off — no rail — the entry stays, because it is the only
  door into the app.
- Role gating is unchanged and now visibly so: a cashier's sidebar holds
  «وفاداری و اعتبار» alone, which is why their redirect still lands somewhere real.
- No new routes, no new API, no arithmetic touched. The engines, the posting
  rules and the bridge card are the same code paths as before.

Criterion 6 of the exit list above is met by `growth-nav.ts` now (the filter runs
where the menu is built), and the app's own sidebar is covered by
`src/lib/app-shells.test.ts` and `src/app/dashboard/growth/growth-nav.test.ts`.

## Revised once more — CRM and the website manager left, both

This phase (and this doc, above) assumed CRM (#367) and the website manager
(#378) would grow this app as sections. Both were built later and both moved
out into their own apps instead, for the same underlying reason stated
differently for each:

- **CRM** — `docs/phases/Phase-36-App-Ecosystem.md`. The customer record is
  read by every app (Sales creates it, Growth messages it, the ledger
  settles against it); seating it behind the door of the one department
  that markets to it would have put a shared source of truth behind one
  app's door.
- **The website manager** — `docs/eshobe-cms-integration.md`. It holds one
  credential to an external system of record (eshobe-cms, a separately
  deployed multi-tenant CMS), the same shape as the standalone WP Manager and
  technical Connections apps rather than as a Growth section. It never reads or
  writes a Growth engine's tables, so
  folding it in here would have made a different product's page read as a
  tab of this one's marketing suite.

`website` moved to its own app entry in `src/lib/apps.ts` (`/dashboard/website`);
`/dashboard/growth/website` and `/growth/website` redirect there for old bookmarks
(entries in `LEGACY_PREFIX_MAP`, with no page left at either address). Nothing else in
this phase's scope changed — the four engines, their posting rules and this
app's own sidebar are exactly as the revision above left them.

## Out of scope, deliberately

- **SMS/email marketing (#372)** — the module key already sits under the
  growth app in `apps.ts`.
- Campaign budgets and a marketing-expense cost centre (#376 exists for the
  messaging phase; project cost centres are #377's subject).
- Changing any engine's arithmetic, posting rule or account number.
