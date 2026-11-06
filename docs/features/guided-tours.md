# Interactive guided tours (issue #972)

A tour is a short walk over the live UI of one page, started from that page's
existing «آموزش» button. There is no second help button: the button's one modal
offers **تور تعاملی صفحه** (when the page has a tour the member may use) and
**راهنمای پایگاه دانش** (the article / external learning page, unchanged).

The button never leads to a dead end: a page with no authored tour gets an
**automatic baseline tour** derived from the Knowledge registry
(`src/lib/tour-baseline.ts`). That is the owner's 2026-11-06 decision — one
shared, metadata-driven system rather than a hand-written tour per page.

This document covers what ships and the rules the next slices must keep. The
epic's remaining phases (hierarchy and learning paths, verified tasks, Learning
Center, Tour Studio, AI discovery) are tracked on #972.

## What ships

| Piece | Where |
|---|---|
| Catalogue, eligibility, progress rules (pure) | `src/lib/tours.ts` |
| Popover placement and spotlight geometry (pure) | `src/lib/tour-geometry.ts` |
| Progress storage, row lock | `src/lib/tours-service.ts`, migration `0259_tour_member_progress.sql` |
| API | `GET /api/knowledge/tours?page=`, `GET /api/knowledge/tours/[tourId]`, `POST /api/knowledge/tours/[tourId]/progress` |
| Automatic baseline tours (pure) | `src/lib/tour-baseline.ts` |
| Coverage audit (pure) | `src/lib/tour-coverage.ts`, `npm run tours:audit` |
| Runtime | `src/components/tours/tour-provider.tsx` (one, in `DashboardMain`), `tour-overlay.tsx` (lazy) |
| Modal | `src/app/dashboard/knowledge-help.tsx` |
| Tours | the catalogue below, in `TOURS`, plus one automatic baseline per registered page |

## Which pages have a tour

Every page in the canonical Knowledge registry (`KNOWLEDGE_PAGES`) — that is,
every page that can carry an «آموزش» icon — answers with a tour. Two catalogues
answer, and `tour-baseline.ts` decides which one owns a page:

- **authored** (`TOURS` below): a reviewed, step-by-step walkthrough. It owns
  its page outright: an eligible member gets it, an ineligible member gets
  nothing (a baseline "about" a screen whose instructions are gated would
  describe screens they may not be allowed to see).
- **baseline** (`tour-baseline.ts`): an automatic, read-only introduction
  derived from the page's own metadata, for every page no authored tour owns.

Where one route draws different screens there is one authored tour per screen,
and their eligibility rules are disjoint (`tours.test.ts` proves a member is
never offered two, or the wrong one, for any trade, costing system, permission
set or feature state).

| Page | Tour id | Offered when |
|---|---|---|
| `/accounting/overview` | `accounting.overview.ledger` | holds `ledger.view` and the ledger feature is on |
| | `accounting.overview.staff` | no `ledger.view`, or the ledger feature is off (the page draws the staff overview) |
| `/accounting/pos` | `accounting.pos.order-ticket` | café order screen (`salesModel = order_ticket`) |
| | `accounting.pos.invoice` | invoice over a priced catalogue (retail family) |
| | `accounting.pos.service-invoice` | invoice over described services (service trades) |
| `/accounting/inventory` | `accounting.inventory.food-service` | food-service stock, perpetual system |
| | `accounting.inventory.food-service-periodic` | food-service stock, periodic system |
| | `accounting.inventory.retail` | retail stock model (`items`/`item_stock`) |
| `/accounting/products` | `accounting.products.list` | the original pilot, unchanged |
| `/accounting/products/new` | `accounting.products.new` | `inventory.adjust` |
| `/accounting/products/prices` | `accounting.products.prices` | `inventory.view`; the edit steps need `inventory.adjust` |
| `/accounting/products/attributes` | `accounting.products.attributes` | `inventory.view`; the edit steps need `inventory.adjust` |
| `/accounting/products/reports` | `accounting.products.reports` | `inventory.view` |
| `/accounting/products/barcode-templates` | `accounting.products.barcode-templates` | `inventory.view` |

The products pages are for the trades that have the products workspace. The
trade groups for the till and the inventory are derived from the industry
profile (`salesModel`, `hasSellableCatalogue`, the `inventory`/`stock`
modules), never listed by hand, so a new trade lands in the right group by what
it is; `tours.test.ts` fails if a trade ends up with no till or inventory tour.

## Automatic baseline tours

`baselineTourForPage(page)` builds a tour from what the registry already knows —
the canonical route, the page label and the navigation group it is filed under
(the same grouping the Knowledge Center and the super-admin page picker show) —
plus any **declared safe region**: a registered `data-tour-id` anchor an owning
shared component really renders. It is a normal `TourDefinition`: same runtime,
same overlay, same `tour_member_progress` row, same rules. Nothing about
progress had to change.

```
intro    explain    what this page is, in its group
region.* spotlight  each declared region (see below)
where    explain    its canonical route and that only what the member sees is described
learn    explain    where the written guide is, and that an authored tour will replace this intro
```

Rules that make it honest and universal:

- **No catalogue entry, no PR.** A page added to `KNOWLEDGE_PAGES` gets basic
  guidance immediately. `tour-baseline.test.ts` builds a page that exists only
  in the test and proves the result is a valid tour.
- **Nothing guessed.** Without a declared region the tour is explanation-only —
  no highlight, no selector, no DOM heuristic. A page is *never* reported as
  missing: "no authored tour yet" shows as a baseline row in the coverage
  audit, which is the editorial backlog.
- **One guide per page.** `pageTourCandidates(pageKey)` returns the authored
  tours when the page has any, otherwise exactly one baseline. `tourDefinitionById`
  applies the same rule to playbacks and progress writes, so a baseline id for
  an authored page is unknown (404) rather than a second, competing tour.
- **Ids are namespaced and stable.** `baseline.<route>` (e.g.
  `baseline.accounting.orders`), so a baseline id can never collide with — or be
  mistaken for — a hand-authored one, and progress survives a copy change.
- **Declared regions, not discovered ones.** `PAGE_TOUR_REGIONS` maps a page key
  (or `"*"` for every baseline page) to `{ anchor, title, body }`. Today the one
  shared declaration is `page.header`, the anchor `page-chrome.tsx` now carries
  on its `PageHeader`; it is a data attribute, no visual change. A page can
  reword a shared region without showing it twice. `tours.test.ts` already fails
  when a `data-tour-id` in the source is not registered in `TOUR_ANCHORS`, so a
  declared region can never point at a selector nobody renders. A page that does
  not render the shared header (the app shells that draw their own) degrades that
  step to its explanation after three seconds — the overlay's normal rule — so it
  is never a stuck highlight.
- **Not an authorization input.** A baseline describes the page's label, group
  and route — metadata that ships in the client bundle (`KNOWLEDGE_PAGES`) — and
  never a control, a figure or a permission-gated instruction. Authored tours
  keep deciding eligibility on the server, step by step.

## Coverage audit

`tourCoverage()` (pure) lists **every** registered page exactly once with
`advanced` or `baseline`, its primary tour, step count, spotlight count and the
anchors it points at, plus contract problems: an anchor nobody registers, a
region for a page that does not exist, an authored tour attached to an
unregistered page, a duplicate or colliding id. `npm run tours:audit` prints it
(grouped like the console, `--json`, `--check` exits non-zero on a contract
problem) and `tour-baseline.test.ts` asserts the same report is clean, so CI
catches an anchor contract break without a browser. It distinguishes **content
coverage** (this report) from **learning progress** (`tour_member_progress`)
and from **business setup readiness** (`setup.progress`) on purpose.

## Eligibility, in one place

`TourEligibility` (on a tour **and** on any single step) can ask for:
`permissions` (all held), `withoutPermissions` (none held), `industries`,
`features` (on) / `withoutFeatures` (explicitly off), `inventorySystem`, and
`anyOf` (at least one alternative). It is the pages' own gate restated, so each
rule names the page guard it mirrors.

- **Steps are filtered per member.** A step whose eligibility the member does
  not match is not part of *their* tour: not described, not counted, not needed
  for completion. A read-only member is never walked through a save button, and
  their percentage is over the steps they were shown. `tourForViewer` returns
  the narrowed definition and every server path (lookup, playback, progress
  writes) starts from it. If permissions change, seen ids for steps that no
  longer apply are dropped on the next write; a step that applies again is
  simply unseen.
- **Optional facts are read lazily.** Feature flags and the costing system cost
  a query each and the lookup runs whenever a page's «آموزش» button mounts, so
  `tourViewerFor` reads them only when a tour on that page asks
  (`tourFactsNeeded`). A tour that asks about a fact that was not read does not
  match; it never guesses.
- **A feature flag that the catalogue does not list counts as on**, the way the
  pages read it (`features.ledger ?? true`).

## Anchors on responsive screens

An anchor id may be drawn twice when a screen has a phone layout and a desktop
one (`pos.cart` is the bottom bar on a phone and the cart column on a desktop;
`product-new.save` is the sticky mobile bar and the side panel). The overlay
targets the first copy that has a box. Parts of a screen that exist only behind
a click the tour must not make (a bottom sheet, a form view, a dialog, the
«مدیریت فاکتورها» list) are explained in an explain step instead of being
spotlighted, and a conditionally-rendered region (the ledger notices, an empty
barcode-template grid) falls back to the explanation after three seconds
instead of trapping the member.

## Rules

- **The catalogue is code, for now.** `TOURS` is reviewed like any source file
  and versioned by `version`. `TourDefinition` is the shape a Superadmin-authored
  catalogue would store; nothing else should need to change when that lands.
- **Anchors are `data-tour-id`**, registered in `TOUR_ANCHORS`. Never target a
  class, a label or a DOM position. `tours.test.ts` fails when a registered
  anchor is missing from the source or a source anchor is unregistered. Put the
  attribute on an element the owning component already renders; do not edit the
  shared dashboard primitives to carry it.
- **Eligibility is decided on the server**, from the member's effective
  permissions, the business's industry, feature flags and costing system, on the lookup *and* on every
  progress write. An ineligible tour is indistinguishable from a non-existent
  one (404) and is never described in a list.
- **Seen is not learned; skipped is not seen.** Every step in this slice is an
  explanation, so "seen" means the member pressed Next. A step that asks for a
  real action must complete on a server-verified success event, never on a click
  — that step kind does not exist yet and the progress API accepts no
  client-claimed success. A tour is completed only when every step was seen.
- **Progress is monotone.** Events are unions of seen steps, so two devices or a
  retry converge; the row is locked `FOR UPDATE` per write. Replaying a completed
  tour never lowers it. Only an explicit `reset` removes anything.
- **Revisions keep what still applies.** Seen steps whose id still exists are
  kept; a step added later is simply unseen, so a member who finished v1 is asked
  about what is new instead of being reset. Never reuse a step id for a different
  step.
- **Learning progress is not setup progress.** `tour_member_progress` is
  separate from `setup.progress` and must stay so.
- **The tour never operates the app.** The overlay blocks clicks on the page
  behind it and only scrolls the anchor into view. It must not click, type or
  read form values.
- **Nothing can trap a member.** Escape / the close button pause; a missing,
  hidden or unmounted anchor degrades the step to a plain explanation after
  three seconds; leaving the tour's route pauses it.
- **The article never depends on the tour.** The modal fetches the tour list in
  a separate request; its failure leaves the article exactly as it was.

## Not in this slice

The Superadmin **Tour Studio** (authoring, preview, publish, versions and
rollback without a code change), the parts of the coverage report that need
editorial data (stale published article, last validation, per-page abandonment),
cross-page tours and learning paths, verified-action steps, offline progress
queueing, the Learning Center, Tour Studio, staff assignments and reports, the
AI discovery tool, Hybrid cloud-pane handling (the overlay runs in the page that
renders it; across the pane's origin boundary a route-based explanation is the
fallback), and per-tenant analytics. Each needs its own design decision on the
epic.
