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
Center, AI discovery, offline progress) are tracked on #972.

## What ships

| Piece | Where |
|---|---|
| Catalogue, eligibility, progress rules (pure) | `src/lib/tours.ts` |
| Popover placement and spotlight geometry (pure) | `src/lib/tour-geometry.ts` |
| Progress storage, row lock | `src/lib/tours-service.ts`, migration `0259_tour_member_progress.sql` |
| API | `GET /api/knowledge/tours?page=`, `GET /api/knowledge/tours/[tourId]`, `POST /api/knowledge/tours/[tourId]/progress` |
| Automatic baseline tours (pure) | `src/lib/tour-baseline.ts` |
| Verified-action whitelist (pure) | `src/lib/tour-verifiers.ts` |
| Verified-action evidence (storage) | `src/lib/tour-evidence-service.ts`, migration `0289_tour_action_evidence.sql` |
| Verified-action API | `POST /api/knowledge/tours/[tourId]/verify` |
| Coverage audit (pure) | `src/lib/tour-coverage.ts`, `npm run tours:audit` |
| Console authoring rules (pure) | `src/lib/tour-studio.ts` |
| Console authoring storage | `src/lib/tour-studio-service.ts`, migration `0288_knowledge_tours.sql` |
| Console API | `GET/POST /api/platform/knowledge/tours`, `GET/POST/DELETE /api/platform/knowledge/tours/[tourId]` |
| Console UI | «تورهای تعاملی» tab in `/platform/knowledge` (`kb-tours-panel.tsx`) |
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

## Tour Studio (super-admin authoring)

The console tab «تورهای تعاملی» authors the tours the runtime serves, without a
deployment (migration 0288):

- **Two tables, one shape as the articles.** `knowledge_tours` holds a tour's
  identity, working copy and which revision is live;
  `knowledge_tour_revisions` holds immutable snapshots. Both are platform
  catalogues with no `business_id` (listed in `src/lib/tenant-tables.ts`), so
  one published set of tours teaches every business. Member progress stays where
  it was — `tour_member_progress`, per business and per member.
- **Drafts are invisible.** Saving appends a revision; publishing points members
  at it; editing a published tour leaves the live revision in place until the
  editor publishes again, and the panel says so. Archiving hides a tour without
  deleting what was taught; a never-published draft can be deleted outright.
- **Rollback is a new version.** Going back copies the old revision into
  `version + 1` and publishes it, so history stays append-only and the step ids a
  member already saw become seen again rather than being renumbered.
- **Validation is the review.** `parseStudioTourInput` refuses an unknown page, a
  route that is not that page's own, a malformed or `baseline.` id, a reused
  code-tour id on a different page, an unregistered anchor (the picker offers
  only `TOUR_ANCHORS`), an explanation that names an anchor, a tour that does not
  open with an explanation, and eligibility naming a permission, trade, flag or
  rule the runtime does not know. A stored tour is validated again before it is
  served, so a row left behind by a renamed page is skipped rather than shown.
- **Precedence.** A published tour with a code tour's id replaces it; a published
  tour with a new id joins that page's catalogue; a page with none still falls
  back to its automatic baseline. `tourCoverage(tours, regions, published)` counts
  published tours as `advanced` coverage, and the console lists both.
- **Concurrency and audit.** Saves carry the version the editor read (a stale one
  is a 409, never a silent overwrite); publish/rollback/archive lock the row and
  write a `platform_audit_log` entry under `knowledge.manage`, the same
  capability that guards the article editor.
- **Refusals are Persian and tour-specific.** `STUDIO_ERROR_TEXT` maps every code
  this feature emits to its own sentence (`version_conflict` here is a tour
  revision, not a knowledge article; `not_draft` explains why delete was
  refused), and the API's English diagnostic `detail` is shown only as a small
  LTR line under it — never instead of it.

Where each promise is checked: `tour-studio.test.ts` (rules, precedence,
operator text), `src/app/api/platform/knowledge/tours/route.test.ts` (auth,
validation, 409, lifecycle, audit), `kb-tours-panel.test.tsx` (mounted panel:
coverage sentence, default key, read-only mode, anchor picker, payloads),
`src/app/api/knowledge/tours/route.test.ts` (members see published tours and
never drafts or archived ones), and `integration/guided-tours.integration.test.ts`
(the same lifecycle against a migrated database, including visibility).

## Verified action steps

Phase 2 of the epic: a tour may ask the member to do something real — register
the first customer, create a product, take an order. The honest way to grade
that is not a click on «بعدی».

- **A step names a whitelisted event, not a URL.** `kind: "action"` requires a
  key from `TOUR_VERIFIERS` (`product.created`, `party.created`,
  `order.created`, …). Each entry carries the Persian promise shown in the card
  and the endpoint that records it; `tour-verifiers.test.ts` asserts every
  `recordedBy` really calls `recordTourEvidence` with that key, so a tour can
  never be published around a writer that does not exist.
- **Only the server credits the action.** The success path itself records
  evidence — `POST /api/products/items`, `POST /api/parties`, `POST /api/orders`
  — after the write succeeded, inside the same tenant scope. The client's
  `POST …/verify` body carries one field, a step id; the server looks the
  evidence up and answers `200` or `409 evidence_missing`. There is no field a
  page could set to claim success, and `step_seen` on an action step is a
  `400 requires_evidence`.
- **Nothing about the member's data is stored.** `tour_action_evidence`
  (migration 0289) holds one row per business/member/verifier: first and last
  time, a counter, and an opaque entity id — never a customer's name, an order's
  contents or a form value. It is tenant data (RLS forced) and is not in the
  platform exemption list.
- **Recording is best-effort in one direction only.** A failure to credit the
  tour never fails the sale, the product or the customer — the member retries
  the tour step. The reverse is not possible: a failed write leaves no evidence.
- **No duplicate work to prove learning.** Evidence is read as "has this member
  ever done this", so a member who registered a customer last week finishes the
  step by pressing «بررسی»; the card says «قبلاً هم انجام داده بودید» instead of
  asking for a second record. That is also why the epic's rule against writing
  demo rows to production is respected: the tour never creates anything.
- **The overlay gets out of the way.** For an action step there is no click
  blocker and no dimmer; the card docks at the bottom, keeps the page usable,
  polls the server (and re-checks on focus) until the evidence appears, and only
  then enables Next. Skip is still available and is still not completion. If the
  member's own save navigates away, the runtime sends the same verify before it
  pauses the tour, so a completed action is not lost to a route change.
- **Authoring.** The console's step editor offers «کار واقعی» with the verifier
  list and shows the promise plus the recording endpoint; the tour validator
  refuses an action step without a registered verifier, a verifier on any other
  kind, and an action step pointing at an unregistered anchor.

The pilot is `crm.directory.first-customer` on `/crm/directory`: the page stays
usable, the member registers the customer themselves, and the third step clears
when `party.created` evidence exists. Its action step points at the shared
«افزودن مشتری» button (`data-tour-id="parties.add"`), which the store's
suppliers and the ledger's party file reuse — one button, one anchor.

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

- **Two catalogues, one shape.** `TOURS` is reviewed like any source file and
  versioned by `version`; the console publishes to the same `TourDefinition`
  shape (migration 0288) and a published tour replaces a code tour with the same
  id. Neither path is privileged in the runtime: the member API composes them in
  `pageTourCandidates`, and the baseline answers only when both are empty.
- **Anchors are `data-tour-id`**, registered in `TOUR_ANCHORS`. Never target a
  class, a label or a DOM position. `tours.test.ts` fails when a registered
  anchor is missing from the source or a source anchor is unregistered. Put the
  attribute on an element the owning component already renders; do not edit the
  shared dashboard primitives to carry it.
- **Eligibility is decided on the server**, from the member's effective
  permissions, the business's industry, feature flags and costing system, on the lookup *and* on every
  progress write. An ineligible tour is indistinguishable from a non-existent
  one (404) and is never described in a list.
- **Seen is not learned; skipped is not seen.** An explanation or a spotlight is
  "seen" when the member pressed Next. A step that asks for something real
  (`kind: "action"`) is not: `step_seen` is refused for it
  (`requires_evidence`), and it completes only through the server's own
  verification of the business event it names — see *Verified action steps*
  below. The progress and verify APIs accept no client-claimed success, and a
  tour is completed only when every step was seen.
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

Rich Studio features beyond authoring and publishing: reusable templates, a
live in-panel preview, conditional branches, and the parts of the coverage report
that need editorial data (stale published article, last validation, per-page
abandonment). Also: eligibility **rules** the API already accepts but the panel
does not yet expose (`anyOf`, feature flags, `withoutPermissions`), cross-page
tours and learning paths, further verified actions (payments, stock receipts,
role changes — each needs its own reviewer-approved success point), offline progress
queueing, the Learning Center, staff assignments and reports, the AI discovery
tool, Hybrid cloud-pane handling (the overlay runs in the page that
renders it; across the pane's origin boundary a route-based explanation is the
fallback), and per-tenant analytics. Each needs its own design decision on the
epic.
