# Cross-app route and workflow audit

**Epic:** ESH-108 / GH #1081 (Phase 0 — route inventory and measurable baseline)
**Measured on:** `main` at `15d5bdc4`, 2026-11-18.
**Scope:** every `page.tsx` in `src/app/**` — tenant apps, shared platform
surfaces, entry surfaces and the Superadmin console.

This document is the audit the epic asks for before any further UI work. It
records **what exists, what it is reached from, and what is measured**, and it
splits the remaining work into three bounded child slices (navigation; forms and
tables; responsive and system states). It deliberately does **not** restyle
anything and does not reopen work already delivered.

It complements, and does not replace, [`coverage-matrix.md`](coverage-matrix.md):
the matrix measures *component adoption inside screens*; this audit measures
*route and workflow coverage across screens*.

---

## 1. Method and definitions

Everything in the tables below is a count produced from the working tree, not an
estimate. Reproduction commands are in the appendix.

| Term | Definition used here |
| --- | --- |
| **Route** | a `page.tsx` file. `[param]` files count as one route that answers many URLs. |
| **Screen** | a destination a person can reach from a menu. One `[section]` route can be many screens. |
| **Nav entry** | an item in one of the navigation registries (`tenant-navigation.ts`, `accounting-nav.ts`, `crm-nav.ts`, `growth-nav.ts`, `website-nav.ts`, `settings-tabs.ts`, `workspace-shared.ts`). |
| **Orphan route** | a route no nav registry names. |
| **Dead nav link** | a nav href that resolves to no route and is not a legacy redirect. |
| **Framing** | `PageShell` + `PageHeader` from `page-chrome.tsx`, directly or through an app/manager shell. |

**Limits of static measurement.** Counts come from file contents and the import
graph. They say nothing about what a screen looks like, whether its focus ring is
visible, or how a dialog behaves at 360×640 — those need a browser and are listed
as unverified in §10. No deployed SHA was available, so no claim here is about
production.

---

## 2. Realm inventory

195 routes in total.

| Realm | Routes | Framing | Loading boundary | Visual baselines |
| --- | ---: | --- | --- | ---: |
| Tenant apps and shared platform surfaces (`src/app/(app)/**`) | 112 | `WorkspaceShell` (`(app)/layout.tsx`) + one shell per app / page body per module | `(app)/loading.tsx` | 20 |
| Superadmin console (`src/app/platform/**`) | 57 | its own `ui.tsx` identity (deliberately separate) | `platform/loading.tsx` | 0 |
| Entry and system surfaces (`login`, `setup`, `invite`, `sign`, `verify`, `review`, `welcome`, `activate`, `mcp`, `telegram`, `reset-password`, `desktop-login`, `admin`, `/`, `/dashboard`, `/error`) | 26 | per-surface card panels | `setup/loading.tsx`, root `loading.tsx`, per-surface skeletons | 0 |

### 2.1 Tenant routes by area

| Area | Route files | Menu source | Framing owner |
| --- | ---: | --- | --- |
| Accounting (`/accounting/**`) | 26 | `accounting-nav.ts` (29 sections) + `tenant-navigation.ts` | `accounting-app-nav.tsx`, `accounting-page-body.tsx`; operational surfaces own their frame |
| CRM (`/crm/**`) | 22 | `crm-nav.ts` (14 rail items + 3 declared sub-sections) | `crm-app-shell.tsx` |
| Growth & Marketing (`/growth/**`) | 18 | `growth-nav.ts` (10 destinations) | `growth-app-shell.tsx` |
| Website Management (`/websites/**`) | 23 | `website-nav.ts` (CMS 11 + WP 8) | `cms/cms-manager-shell.tsx`, `wp/wp-app-shell.tsx`, `website-home.tsx` |
| My Workspace (`/workspace/**`) | 7 | `workspace-shared.ts` (10 sections) | `workspace-page-body.tsx` |
| Platform settings (`/settings/**`) | 10 | `settings-tabs.ts` (22 sections) + standalone pages (profile, billing, subscription, security, connections, transfer) | `settings-page-body.tsx` |
| Shared surfaces (`/media`, `/knowledge`, `/support`, `/petty-cash`) | 6 | `tenant-navigation.ts` | their own pages |
| **Total** | **112** | | |

**Route files are not screens.** Accounting's 29 ledger sections resolve through
one dynamic route (`/accounting/[section]`), and the same pattern serves
`/settings/[section]` and `/workspace/[section]`. A route-file inventory
therefore *understates* the surface area and must always be read next to the nav
registry. Any future coverage table should be keyed by nav entry, not by file.

---

## 3. Navigation audit

### 3.1 Shell ownership — verified, no duplication

- **One registry, one owner.** `src/lib/app-shells.ts` (`APP_SHELLS`) maps each
  app prefix to the sidebar that owns it: `/accounting` → `accounting-app-nav`,
  `/growth` → `growth-app-nav`, `/crm` → `crm-app-nav`, `/websites` →
  `website-app-nav`. `appShellForPathname` matches whole segments; the flat
  business nav excludes app-owned hrefs through `isInsideAnyAppShell`.
- **No page is reachable from two menus.** The previous failure mode — an app
  page also listed in the flat nav, so its active state disagreed with itself —
  is structurally prevented rather than fixed screen by screen.
- **Website Management is one app with two managers**, and both manager shells
  (`cms-manager-shell.tsx`, `wp-app-shell.tsx`) render `PageShell` + `PageHeader`
  themselves. This audit confirms the app is **not** missing the shared frame;
  the frame is one level lower than in the other three apps.
- **Operational surfaces own their chrome on purpose.** POS, orders, floor,
  kitchen, waiter, delivery and reservations are the approved dense variation
  (`docs/design-system.md` § "When an operational variation is allowed") and are
  exempt from the primitive lint by path. They are not drift and must not be
  "fixed" into `PageHeader` pages.

### 3.2 Active state and canonical routes

- Active state is one rule (`navHrefIsActive` in `app-routes.ts`): a bare href is
  active on its whole path prefix; a `?tab=` href matches only that tab and
  ignores unrelated query parameters. Longest-match wins in `nav-tree.ts`, so a
  sub-section is named by its own entry rather than by its parent.
- Every former `/dashboard/*` address has one permanent redirect row
  (`LEGACY_PREFIX_MAP`), including the suffix-preserving app move and the
  query-dependent legacy ledger, WordPress and assistant targets.
- **Measured: 0 orphan routes** among non-platform, non-entry routes — every one
  is named by a nav or route registry.
- **Measured: 0 dead nav links.** Every literal href extracted from the
  registries that resolves to no `page.tsx` is one of three explained sets:
  legacy addresses answered by `LEGACY_PREFIX_MAP` (e.g. `/dashboard/crm`,
  `/dashboard/ledger`), `/api/*` endpoints, or strings that exist only in tests
  to prove a non-route stays a non-route (`/growthlab`, `/workspace-tools`,
  `/crm/overview/overview`). None is a menu item a user can click.

### 3.3 Declared non-navs (deliberate, do not "fix")

| Surface | Why it has no rail entry |
| --- | --- |
| CRM `duplicates`, `reconciliation`, `automations` | `CRM_SUB_SECTIONS` — opened from «کیفیت داده» and CRM settings; kept as real routes and bookmarks. |
| Settings `profile`, `billing`, `subscription`, `connections` | Real directories beside the tab body; reached from the platform user menu, not the settings rail. |
| Detail routes (`[id]`, `contracts/[id]/print`, `wp/[shopId]`) | Destinations of a row, not menu items. |
| `/dashboard` (AI home) | The platform home itself; named in the rail toolbar, not as a row. |

### 3.4 Navigation findings

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| N1 | P2 | The ledger's 29 screens live behind one dynamic route, so route-count dashboards and any future automated coverage check must key on nav entries; a file-based count reports 26 for Accounting. | `accounting-nav.ts`, `/accounting/[section]/page.tsx` |
| N2 | P2 | The Superadmin console (57 routes) is excluded from both design lints by design and has no visual baselines. It needs its own documented pass rather than tenant chrome. | `design-lint.test.ts` realm list, `docs/design/visual/` |
| N3 | P3 | Growth's 14 route files answer 10 rail destinations plus detail/supporting routes (`marketing-targets`, `marketing-assignments`, `marketing-touchpoints`, `torob/[shopId]`, `commission/runs`), reached from their parent sections. Worth stating in the design doc so a future agent does not read them as orphans. | `growth-nav.ts`, route tree |
| N4 | P3 | Mobile bottom navigation and the app launcher resolve destinations from the flattened nav by href; a section added to an app menu but not to `tenant-navigation.ts` would be invisible to those two surfaces even though the page works. No such case exists today; the audit found none. | `nav-tree.ts`, `bottom-nav.ts` |

---

## 4. Workflow audit

One row per workflow that a business owner actually performs, with the entry
point and what the audit could confirm without a browser.

| Workflow | App | Entry screen | Primary action | Density | States present | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| Ask the assistant / start the day | Home | `/dashboard` | Compose a request; open a management panel | Low | skeleton, empty conversation, streaming, error | High (code + existing baselines absent) |
| Take a payment | Accounting | `/accounting/pos` | Add items → take payment | Dense (approved) | skeleton, empty cart, busy button, receipt | High — operational exemption documented |
| Work the order queue | Accounting | `/accounting/orders` | Open/advance an order | Dense | skeleton, two empty states, chips | High — `orders-queue` reference absent |
| Find a person | Accounting | `/accounting/directory` | Search, filter by role view, open file | High | skeleton, empty, filters | High |
| Read the books | Accounting | `/accounting/ledger` → section | Post / review an entry | High | skeleton, empty, error box | High — trial balance, expenses, receivables baselined |
| Count stock | Accounting | `/accounting/inventory` | Adjust / transfer stock | High | skeleton, empty, filter chips | High — baselined |
| Who needs attention today | CRM | `/crm/overview` | Open the queue item | Medium | skeleton, KPI row, empty | High — baselined |
| Work an opportunity | CRM | `/crm/deals` | Move a deal stage | High | skeleton, empty, table/cards | High — baselined |
| Serve a customer file | CRM | `/crm/directory` → person | Log activity, edit, consent | Medium | skeleton, empty | Medium — no baseline |
| Run a campaign | Growth | `/growth/campaigns` | Create / send | Medium | skeleton, empty | Medium |
| Read audience list | Growth | `/growth/customers` | Segment / export | High | skeleton, empty, table | High — baselined |
| Pay commission | Growth | `/growth/commission` → run | Approve a run | High | skeleton, empty, detail drawer | Medium |
| Check the site | Websites | `/websites/overview` | Open a manager | Low | skeleton, empty-managers state | High — both managers baselined |
| Publish content | Websites | `/websites/cms/pages` | Create / publish a page | High | skeleton, empty, sync state | Medium |
| Fulfil a store order | Websites | `/websites/wp/orders` | Open order, change status | High | skeleton, queue state, modal | Medium |
| Run a project | Workspace | `/workspace/overview` | Open project, move task | Medium | skeleton, KPI, empty | **Low — no baselines** |
| Configure the business | Settings | `/settings` | Edit a tab's form | Medium | skeleton, save/busy, errors | High — business tab baselined |
| Approve a contract | Workspace | `/workspace/approvals` | Approve / request changes | Medium | skeleton, empty, workflow refusals | **Low — no baselines** |
| Operate the platform | Superadmin | `/platform` | Inspect a tenant, change a plan | High | skeletons, error box, confirmations | **Low — no baselines, lint-exempt** |

**Reading the confidence column.** "High" means the screen is covered by a
committed visual baseline and its states exist in code. "Medium" means the
states exist but the screen has no baseline. "Low" means neither the screen nor
its states have ever been frozen, so any change to it is unverified by
construction.

---

## 5. Forms and tables

### 5.1 Tables

| App | Files composing `DataTable`/`DataCardTable` |
| --- | ---: |
| Accounting | 38 |
| Growth | 10 |
| CRM | 5 |
| Website Management | 3 |
| Shared (workspace, settings, reports) | 24 `DataCardTable` call sites + `report-table.tsx`, which composes `DataTable` internally |

- The table rule is unconditional in `primitive-lint.test.ts`
  (`TABLE_MIGRATION_BACKLOG` was deleted when the last hand-rolled table moved).
- The one remaining `<thead>` outside `data-table.tsx` in tenant code,
  `settings/security/support-access/page.tsx`, **is the sanctioned API** —
  `DataTable` + `<Th>` children — not a hand-rolled table. No action.
- **Remaining gap: the phone fallback is duplicated.** 21 files wrap a table in
  their own `overflow-x-auto` (Accounting 11, Settings 4, CRM 2, Workspace 2,
  Growth 1, Websites 1) and 17 files carry a bespoke `lg:hidden` card list
  (Accounting 16, Growth 1). `DataTableMobileList` — named as the remaining item
  in `coverage-matrix.md` — is still unbuilt, so a table's desktop and phone
  renderings can drift independently.

### 5.2 Forms

- One field skin (`Field` + `inputClass`) and one submit pair
  (`PrimaryButton`/`SecondaryButton`); the lint fails a restated input.
- **Dates: not clean.** `AGENTS.md` forbids the native `<input type="date">`
  because it opens a Gregorian calendar. **9 tenant component files still use
  one** (14 occurrences):

  | File | Occurrences |
  | --- | ---: |
  | `crm/client-campaigns-section.tsx` | 3 |
  | `crm/briefs-section.tsx` | 2 |
  | `workspace/projects/[id]/field/field-screen.tsx` | 2 |
  | `accounting/menu/price-history-panel.tsx` | 2 |
  | `crm/proposals-section.tsx` | 1 |
  | `accounting/client-costs-section.tsx` | 1 |
  | `accounting/vendor-payment-controls.tsx` | 1 |
  | `settings/transfer/data-transfer-ui.tsx` | 1 |
  | `workspace/contracts/[id]/document-editor.tsx` | 1 |

  The deviation is deliberate in at least some places rather than an oversight:
  `field-screen.tsx` labels its two fields «(میلادی)», and two instruction
  strings go further and tell the user to type a Gregorian date
  (`accounting/reconciliation-statement-preview.tsx:106`,
  `settings/transfer/holoo-transfer-section.tsx:142`). That is why this is
  reported as its own issue (Child 5) instead of being folded into a forms pass.
  `src/app/dashboard/jalali-date-picker.tsx` also contains one; that is the
  approved primitive and not a violation. `platform/audit/page.tsx` has one more
  in the lint-exempt console.
- **Remaining gap:** six search fields still hand-roll their own input
  (`coverage-matrix.md` § Remaining) because each needs a `SearchField` prop that
  has not been designed (inline clear at a different offset, combobox, nav
  filter). No lint rule exists for them yet.
- Dialog/drawer behaviour at small viewport heights (clipped footer, focus trap,
  scroll) is **not measured** — it needs a browser; see §10.

---

## 6. Responsive and system states

### 6.1 What is in place

- **Loading:** 14 `loading.tsx` boundaries. Every one of the 112 tenant routes
  inherits a boundary (measured by walking each route's ancestor directories);
  the same holds for `/platform/**` and `/setup/**`. `loading-coverage.test.ts`
  additionally requires a skeleton above every realm and a `*Skeleton` render
  from every client component that starts a fetch.
- **Empty states:** shared `EmptyState` (simple) and the rich variant, with
  amber icon chip and Persian copy; both are lint-enforced shapes.
- **Mobile primitives:** `src/components/mobile/` supplies `AppSheet`,
  `MobileAppHeader`, `MobileAppBottomNav`, `QuickCreateSheet`,
  `MobileRecordList`, `MobileFilterSheet`, `MobileDetailHeader`.
- **No horizontal page overflow policy gap at the component level:** tables and
  wide panels scroll inside their own container rather than the page; the
  containers are the 21 files listed in §5.1.

### 6.2 What is missing

> **Status (S1, S2):** both are addressed by the ESH-207 change — realm boundaries
> at `(app)/error.tsx` and `platform/error.tsx` over a shared
> `src/components/error-panel.tsx`, and `not-found.tsx` at the root and in
> `(app)` over a shared `src/components/not-found-panel.tsx`. The measurements
> below are the baseline this audit was taken at, kept so the gap and its fix
> stay comparable. S3–S6 remain open (ESH-206).

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| S1 | **P1** | **One error boundary for 195 routes.** `src/app/error.tsx` and `src/app/global-error.tsx` are the only ones; there is no boundary per realm, so a render failure inside the tenant shell replaces the whole shell with the root error page, and the Superadmin console falls back to that same tenant-facing boundary. | `find src/app -name 'error.tsx'` → 1 (+ `global-error.tsx`) |
| S2 | **P1** | **No `not-found.tsx` anywhere.** An unknown URL renders Next's default 404: unstyled, Latin, outside the design system, with no way back to the app. This is the most visible uncovered state in the product. | `find src/app -name 'not-found.tsx'` → 0 |
| S3 | **P1** | **Visual coverage is 14% of tenant routes and 0% of platform routes.** 20 PNG baselines cover 16 distinct routes; Workspace (7 routes), Media, Knowledge, Support, Petty cash and all 57 platform routes have none. Only one route family has a mobile baseline (`/accounting/receipts`, 390×844, light + dark). | `scripts/visual-regression.mjs` (23 declared screens, 16 distinct paths), `docs/design/visual/*.png` (20) |
| S4 | P2 | **State baselines barely exist.** Every committed baseline captures a seeded, populated screen at 1440×900. None captures an error, a loading skeleton, a permission-denied view or an open dialog at a small height, so a regression in those states cannot fail CI. | baseline list, `scripts/seed-visual-fixture.ts` |
| S5 | P2 | **Accessibility automation is one screen deep.** `npm run test:a11y:subledger` covers the subledger; no axe-style run covers the four apps' shared primitives or the entry surfaces. Keyboard-only and 200% zoom checks are manual and unrecorded. | `package.json` |
| S6 | P3 | **Dark mode and phone widths are baseline-tested on one route family only**; every other baseline is 1440×900 light. Dark-mode regressions on other screens are caught only by the heuristics in `design-lint.test.ts`. | baseline list |

---

## 7. Findings ranked

| Priority | Finding | Slice |
| --- | --- | --- |
| **P0** | The six approved reference screenshots are still absent from the repo (§8). No screen can be pixel-compared against the canon; baselines are the only substitute and their expansion needs owner approval. | Owner decision — blocks the epic's definition of done, not this audit |
| **P1** | One error boundary and no 404 page for the whole product (S1, S2) | Responsive & states |
| **P1** | Visual coverage 14% of tenant routes, 0% of platform (S3) | Baseline expansion (child 4) |
| **P1** | Table phone fallback duplicated in 17 files, horizontal wrappers in 21 (5.1) | Forms & tables |
| **P1** | 9 tenant files still render a native Gregorian `<input type="date">` (5.2), against the repo's Shamsi-only rule | Date inputs (child 5) |
| **P2** | No state baselines: error, loading, denied, dialog (S4) | Responsive & states |
| **P2** | Accessibility automation limited to the subledger (S5) | Responsive & states |
| **P2** | Superadmin console lint-exempt and baseline-free (N2) | Navigation (documented) + baseline expansion |
| **P2** | Six hand-rolled search fields awaiting a `SearchField` prop (5.2) | Forms & tables |
| **P3** | Route-file counts understate screens for the three `[section]` modules (N1) | Documentation — done here |
| **P3** | Dark-mode and mobile baselines limited to one route family (S6) | Baseline expansion |

No security, tenancy, financial or business-logic defect was found in this pass;
nothing here changes a permission, a query or a total.

---

## 8. Reference screens — confirmed status

**The six approved 2026-09-18 references are not in the repository.**

```
docs/design/reference/
└── archive-2026-09/        # 7 historical PNGs, not normative
```

`orders-queue.png`, `pos-sell-screen.png` (new set), `inventory-warehouses.png`,
`settings-menu-import.png`, `accounting-trial-balance.png` and
`settings-business.png` exist only as names in `docs/design-system.md`. Their
absence is enforced honestly by `src/app/reference-screenshots.test.ts`, which
fails both if the note is deleted while the files are missing and if the files
appear while the note stays.

**Consequence for this audit:** "Confirm reference screens" cannot mean
confirming them against a file that does not exist. It means one of two owner
decisions:

1. **Supply the originals** (preferred) → commit under
   `docs/design/reference/`, run the pixel comparison once per screen, record it
   in `docs/design/test-results.md`, retire the availability note and the test
   that guards it; or
2. **Approve the current baselines as the reference** → say so explicitly in the
   epic, extend the baseline set (§9, child 4), and treat
   `docs/design-system.md`'s rules as the only normative description.

Until one happens, no completion claim in this epic may describe a screen as
"matching the approved reference".

---

## 9. Proposed child issues

Four bounded design slices, plus one correctness defect kept in its own PR.
Each is independently reviewable, changes no business logic, and ends with the
gates in §9.5.

### Child 1 — Navigation: audit trail and cross-app consistency

**In scope**

- Document the shell map, the declared non-navs and the operational-surface
  exemptions in `docs/design-system.md` (one short section pointing at this
  audit), so a future agent does not "fix" them into consistency.
- Verify keyboard behaviour of the app switcher, the sidebar rail, `SectionNav`
  collapse and browser back/forward across all four app shells.
- Confirm the active-state rule on the one ambiguous case: `/accounting/products`
  and its four sub-sections, plus `/crm/directory?view=` filters.

**Out of scope:** adding or removing destinations; changing permissions;
re-drawing any sidebar; touching the in-flight #909 shell work.

**Done when:** the shell map is documented in the design doc, and the
keyboard/back-forward checks are recorded with the routes exercised and the
results, including any failure as a follow-up rather than a fix.

### Child 2 — Forms and tables: one phone fallback, one search field

**In scope**

- Build `DataTableMobileList` (or finish `DataCardTable` adoption) and migrate
  the 17 bespoke `lg:hidden` card lists; remove the corresponding
  `overflow-x-auto` wrappers where the shared fallback replaces them.
- Design the `SearchField` prop the six remaining hand-rolled fields need, then
  migrate them and add the lint rule named in `coverage-matrix.md`.
- Record a dialog/drawer pass at 360×640: visible actions, no clipped footer,
  focus trap and restoration, predictable close.

**Out of scope:** any table that is already `DataTable`-based and renders
correctly; changing column sets, sorting or totals; financial formatting.

**Done when:** no bespoke mobile card list remains outside the operational
surfaces; the search-field lint passes with no exception list; the dialog pass is
recorded with the screens and viewports used.

### Child 3 — Responsive and system states: honest failures

**In scope**

- Add a realm-level `error.tsx` for `(app)` and `platform`, using the existing
  root error recipe (error id, retry, technical report) with realm-appropriate
  copy; keep the root boundary as the last resort.
- Add `not-found.tsx` at the root and inside `(app)`, in the design system's
  language, with a Persian message and a link back to the assistant home.
- Freeze the four states that have never been photographed: an empty register, a
  loading skeleton, a permission-denied view and an open dialog at 390×844.

**Out of scope:** changing any API error contract; adding retry logic to routes
that already have it; touching the entry surfaces' copy.

**Done when:** a render failure inside the tenant shell keeps the shell; an
unknown URL is a designed page; the four new state baselines are reviewed and
committed; `npm run test:design` passes with no new exemption.

### Child 4 — Baseline expansion and accessibility gate

**In scope**

- Extend `scripts/visual-regression.mjs` from 16 routes to at least one screen
  per app section group: Accounting (POS, orders, ledger, inventory),
  CRM (directory, cases), Growth (commission), Websites (CMS pages, WP orders),
  Workspace (overview, projects), Settings (team), and one representative
  Superadmin screen.
- Add a mobile baseline for one screen per app, and a dark baseline for one
  screen per app.
- Add an automated accessibility run over the four app homes and the login and
  setup entry surfaces (axe or equivalent) with a documented rule set.

**Out of scope:** re-recording an existing baseline to clear a diff; changing a
screen to make a new baseline look right (that is the screen's own issue).

**Done when:** the new baselines are reviewed as images before commit; the a11y
run is wired into `test.yml`; and the coverage percentage is updated in this
document.

### Child 5 — Shamsi date inputs (reported defect, separate PR)

Filed separately because the epic's rules keep a correctness defect out of a
styling pass.

**In scope:** replace the 14 native `<input type="date">` occurrences listed in
§5.2 with `JalaliDatePicker`, keeping each field's stored value a Gregorian ISO
string at the API boundary (the existing conversion already does this everywhere
else). Decide, with the owner, whether the two fields labelled «(میلادی)» are an
intentional exception; if they are, document that exception in
`docs/design-system.md` rather than leaving an undocumented violation.

Also review the two Gregorian instruction strings named in §5.2: telling a user
to type `YYYY-MM-DD` is the same rule broken in copy rather than in a control.

**Out of scope:** changing stored dates, validation rules or any payload shape;
re-formatting dates that already render correctly through `formatJalali`.

**Done when:** `grep -rn 'type="date"' src/app` returns only
`jalali-date-picker.tsx` (and, if the owner approves an exception, the platform
console file named in the doc), and each migrated form is checked for Shamsi
display, Persian digits and an unchanged stored value.

### 9.5 Gates every child keeps

```bash
npx tsc --noEmit
npm test
npm run test:design
npm run build
# plus, for any change that alters pixels:
npm run test:visual      # needs a built app + seeded database + Chromium
```

Never re-record a baseline to clear a failure. A changed pixel is either an
intended change with a reviewed diff and an explanation, or a regression to
revert.

---

## 10. Not verified in this pass

Recorded plainly so nobody reads a green static check as visual acceptance:

- **No browser.** No page was rendered, clicked, tabbed through, zoomed or viewed
  in dark mode. Every responsive and interaction claim above is from source, not
  from pixels.
- **No deployed SHA.** Nothing here describes production.
- **No database.** `npm run test:db`, `npm run test:visual` and the E2E suites
  were not run; dependencies were not installed for a doc-only change.
- **No accessibility run.** The keyboard, focus-order, contrast and screen-reader
  state of the shared primitives is unmeasured beyond what the lints enforce.
- **No RTL stress test** with long Persian labels, ZWNJ, mixed Latin codes and
  Jalali dates in the same cell.
- **The date-input finding is static.** It is a grep result, not a rendered
  check: whether each of the 10 fields currently *displays* a Gregorian value to
the user depends on the input's own locale, which needs a browser to confirm.
- **No runtime check** of PWA/Android, Windows desktop, hybrid or offline states.

The next audit pass should be executed against a deployed preview at a recorded
SHA with a seeded database, and should replace the "confidence" column in §4 with
observed results.

---

## Appendix — reproduction

```bash
# route inventory by realm
find src/app -name page.tsx | wc -l                                  # 195
find 'src/app/(app)' -name page.tsx | wc -l                          # 112
find src/app/platform -name page.tsx | wc -l                         # 57

# per-area route counts
for d in accounting crm growth websites workspace settings knowledge media support petty-cash; do
  echo -n "$d "; find "src/app/(app)/$d" -name page.tsx | wc -l
done

# loading boundaries and error surfaces
find src/app -name loading.tsx | wc -l                               # 14
find src/app -name error.tsx                                         # 1
find src/app -name not-found.tsx                                     # 0

# table adoption
for d in accounting crm growth websites; do
  echo -n "$d "; grep -rlE '<DataTable|<DataCardTable' "src/app/(app)/$d" --include='*.tsx' | wc -l
done                                                                 # 38 / 5 / 10 / 3

# duplicated phone fallbacks
grep -rl 'overflow-x-auto' 'src/app/(app)' --include='*.tsx' | wc -l  # 21
grep -rl 'lg:hidden' 'src/app/(app)' --include='*.tsx' | wc -l        # 17

# dates (native Gregorian input, forbidden in tenant code)
grep -rn 'type="date"' src --include='*.tsx' | wc -l                  # 18
#   ... of which in tenant non-test files: 14 occurrences in 9 components
#       + jalali-date-picker.tsx (the approved primitive)
#       + platform/audit/page.tsx (lint-exempt console)
#       + 2 *.test.tsx

# visual baseline coverage
ls docs/design/visual/*.png | wc -l                                   # 20
grep -E 'path: "/' scripts/visual-regression.mjs | sed -E 's/.*path: "([^"]+)".*/\1/' | sort -u | wc -l  # 16
```
