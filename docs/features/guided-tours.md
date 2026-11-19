# Interactive guided tours (issue #972)

A tour is a short walk over the live UI of one page, started from that page's
existing «آموزش» button. There is no second help button: the button's one modal
offers **تور تعاملی صفحه** (when the page has a tour the member may use) and
**راهنمای پایگاه دانش** (the article / external learning page, unchanged).

The button never leads to a dead end: a page with no authored tour gets an
**automatic baseline tour** derived from the Knowledge registry
(`src/lib/tour-baseline.ts`). That is the owner's 2026-11-06 decision — one
shared, metadata-driven system rather than a hand-written tour per page.

This document covers what ships and the rules the next slices must keep. Cross-page
tours, the platform/app navigation overviews, the Learning Center, staff
reporting, contextual recommendations and the offline queue are now part of the
same system; the remaining editorial and operational work is listed at the end.

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
| Cross-page tours | `navigate` step kind in `src/lib/tours.ts`, route resolution in `tourStepRoute`/`tourRoutes`, provider hand-off |
| Modal | `src/app/dashboard/knowledge-help.tsx` |
| Learning Center | `/knowledge/learning` (`src/app/dashboard/knowledge/learning-center.tsx`) |
| Staff learning report | `GET /api/knowledge/learning-assignments` (`team.manage`) |
| Recommendations | `src/lib/learning-recommendations.ts` (pure), `learning-recommendation-service.ts`, `GET /api/knowledge/recommendations`, assistant tool `recommend_learning` |
| Offline delivery | `src/lib/tour-progress-queue.ts`, flushed by the provider on open/online |
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
| `/accounting/products/barcode-templates` | `accounting.products.barcode-templates` | `inventory.view` (retail), `vehicles.view` (automotive) |

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
  (or `"*"` for every baseline page) to `{ anchor, title, body }`, and
  `PAGE_TOUR_REGION_PREFIXES` does the same once for a whole app. Today the
  shared declarations are `page.header` on `PageHeader`, `app.section-nav` on
  the CRM/Growth/Websites sidebar, `accounting.section-nav` on Accounting's own
  sidebar, `page.section-nav` on the in-page menu, `page.table` on the shared
  table frame and `page.filters` on the shared search/filter row — all data
  attributes, no visual change. That is why 95 of 101 pages now have a real
  spotlight: one declaration covers every page that renders the same shell. A
  page can reword a shared region without showing it twice. `tours.test.ts`
  fails when a `data-tour-id` in the source is not registered in `TOUR_ANCHORS`,
  so a declared region can never point at a selector nobody renders. A page that
  does not render a declared region degrades that step to its explanation after
  three seconds — the overlay's normal rule — so it is never a stuck highlight.
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
- **Templates and preview.** `TOUR_STUDIO_TEMPLATES` offers three reviewed
  presets (standard intro, list page, section/menu); inserting one generates
  fresh step ids, so it can be used twice. «پیش‌نمایش مراحل» walks the authored
  steps in the panel with their kind, anchor, title and body — an authoring
  check, not a claim about the live target page. Every template is still run
  through `parseStudioTourInput` on save/publish.
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
  `order.created`, `receivable.payment_recorded`, `payable.payment_recorded`,
  `stock.received`, …). Each entry carries the Persian promise shown in the card
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

## Cross-page tours

A tour may now walk across registered pages without a second engine or a global
store. The contract is one new step kind:

- `kind: "navigate"` with `navigateTo` (a **registered** route). The step is an
  explanation: it shows one button («رفتن به بخش بعدی») and the card says why the
  member is leaving. Nothing moves until they press it.
- Every step after a hand-off belongs to that destination until the next
  hand-off; `tourStepRoute(tour, index)` is the one definition of where a step
  lives, and `tourRoutes(tour)` lists the tour's pages. `validateTours` refuses
  an unregistered destination, an anchor on a hand-off, and a tour that ends on
  one.
- **Progress is saved before navigation.** The overlay sends `step_seen` and
  only calls the provider's router when the server accepted it; a failed write
  keeps the member on the page with a retry message.
- **The session survives the route change.** The provider (`tour-provider.tsx`)
  remembers the hand-off target and reopens the same tour at the exact step on
  the destination instead of treating the navigation as leaving. Moving to
  another page of the tour by any route keeps the workflow; leaving every page
  of it pauses as before.
- **A refresh resumes.** The active tour and step are kept in `sessionStorage`
  (`bizamiz.guided-tour.session`); on mount the provider asks the server for the
  playback again (eligibility is re-checked) and opens the saved step. Pausing
  or completing clears it.
- **Back/Skip stay coherent.** Back across a page boundary routes back to the
  previous step's page; Skip crosses a hand-off without marking anything seen;
  a completed step is a union on the server, so it can never be counted twice.
- **Single-page tours are unchanged** — no `navigate` step, no new state, same
  progress rows.

## Platform and application navigation overviews

Six authored walkthroughs explain where things are and how the apps relate,
using the same hand-off mechanism:

| Entry page | Tour | Route(s) |
|---|---|---|
| `/workspace` | `platform.learning-overview` | `/workspace` → `/knowledge` |
| `/accounting/orders` | `accounting.navigation.overview` | `/accounting/orders` → `/accounting/pos` → `/accounting/products` |
| `/crm/overview` | `crm.navigation.overview` | `/crm/overview` → `/crm/directory` |
| `/growth/overview` | `growth.navigation.overview` | `/growth/overview` → `/growth/campaigns` → `/growth/loyalty` |
| `/websites/overview` | `websites.navigation.overview` | `/websites/overview` → `/websites/cms` → `/websites/wp` (the WordPress leg is gated on `integrations`) |
| `/settings` | `settings.navigation.overview` | `/settings` → `/settings/connections` (gated on `settings.manage`) |

They describe only the modules the member is eligible for: a step (and the
hand-off that leads to it) is filtered out for an ineligible viewer, so the
tour never promises a screen they cannot open. The `/knowledge` page itself is
now a registered page with the same Knowledge button, and links to
`/knowledge/learning`.

## Learning Center

`/knowledge/learning` is a child of the existing centre, not a second help
product. It renders the server's one aggregate
(`GET /api/knowledge/learning-progress`) and the curated paths:

- platform percentage, per-app and per-section progress (deduplicated over
  eligible content, never averaged);
- resume the last incomplete tour, or the next lesson;
- each path with its real steps: a `tour` step starts through the existing
  runtime; an `article` step links to the guide and can be acknowledged as read;
  a `page` step links to the route. A `tour` step **cannot** be claimed by the
  client — `POST …/progress` answers `step_not_completable`; it completes only
  when that tour's own server progress says completed
  (`completedTourStepIds`/`completedTourIdsForPaths`).
- members with `team.manage` additionally see `GET
  /api/knowledge/learning-assignments`: who was assigned which tour or path,
  their state, percentage and last activity. The endpoint joins the member's
  name and learning state only, under RLS and an explicit business predicate.

## Contextual recommendations

`recommendLearningRecommendations` ranks **existing** tours and paths:
deterministic, permission-filtered, never inventing an id and never starting
anything. It prefers the current page, then in-progress work, then a starter
path, excluding completed and empty items. The server function caches its feed
per member and page for 60 seconds, so it is not recomputed on every render and
never calls a model in a render path.

Two consumers share it:

- the Learning Center's «پیشنهاد برای شما» strip, where the member presses the
  start button themselves;
- the assistant's `recommend_learning` tool. The model may name a tour or path
  and explain why, but the user still starts it from the existing button; the
  model never navigates, clicks or claims completion.

## Offline and Hybrid progress

Progress events are a monotone union on the server, so delivery only needs to be
at-least-once. The provider queues client-legitimate events (`start`,
`step_seen`, `pause`, `complete`, `reset`) in
`src/lib/tour-progress-queue.ts` when the request fails or the server answers
5xx/429, and flushes them in order when a tour opens or the browser goes online.

- **Nothing sensitive is stored**: a tour id, an event name, a step id and an
  opaque per-member key — no customer, amount, form value or free text.
- **Identity is enforced**: the key is a server-issued hash of (business,
  member). A queue belonging to another viewer is discarded, and an auth
  failure clears it instead of replaying it into the next session.
- **Duplicates are harmless and bounded**: identical events are stored once, a
  `reset` drops earlier events for that tour, and the queue is capped.
- **A queued `complete` is not a finished tour.** The overlay still reports
  "incomplete" until the server accepts completion; the replay then finishes
  it. `verified` is never queued (it is server-raised only).
- **Hybrid**: `/knowledge` is a cloud-pane route, so its writes already go to
  the cloud origin; this queue covers a local page that loses connectivity. It
  deliberately does **not** ride the business `sync_events` outbox, which is
  location-scoped operational data (orders, stock) and has a different
  authorization shape.

## Coverage audit

`tourCoverage()` (pure) lists **every** registered page exactly once with
`advanced` or `baseline`, its primary tour, step count, spotlight count, action
and hand-off counts and the anchors it points at. It separates:

- **spotlight coverage** — pages whose own tour points at a region other than
  the universal `page.header`;
- **explanation-only coverage** — pages that still rely on a baseline or a
  header-only spotlight (the editorial backlog);
- **contract problems** — an anchor nobody registers, a region for a page that
  does not exist, an authored tour attached to an unregistered page, a
  duplicate or colliding id;
- **uncovered pages** and **stale tours**, listed explicitly rather than hidden.

`npm run tours:audit` prints the report (grouped like the console, `--json`,
`--check` exits non-zero on a contract problem or an uncovered page) and
`tour-baseline.test.ts` asserts the live registry is clean, so CI catches a new
page that escaped baseline coverage or an anchor contract break without a
browser. Current figures on this commit: **101 registered pages, 33 advanced,
68 baseline, 38 authored tours, 562 offered steps** (239 spotlight steps, 10
verified actions, 10 hand-offs), **95 pages with a page-specific spotlight, 6
header-only/explanation-only pages, 0 uncovered pages, 0 stale tours, 0 contract
problems**. The five app groups now derive a real section-navigation spotlight
from one prefix declaration, so every page in Accounting, CRM, Growth, Websites
and Settings points at the menu it actually uses. It distinguishes **content coverage** (this report) from **learning
progress** (`tour_member_progress`) and from **business setup readiness**
(`setup.progress`) on purpose.

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

## Remaining known limitations

- **Editorial coverage**: 68 pages still rely on their automatic baseline. Most
  now spotlight the real section menu their shell draws (95 of 101 pages have a
  page-specific spotlight); 6 remain header-only. Turning the baselines into
  step-by-step workflow tours is ongoing editorial work, not a code gap.
- **Tour Studio** authors explanations, spotlights, verified actions, hand-offs
  and cross-page navigation, and offers reusable step templates plus a
  step-sequence preview. The panel now exposes feature-flag and
  `withoutPermissions` rules; `anyOf` and conditional branches are still
  server-supported but not edited in the panel. The preview shows step content
  and order, not the target page's live DOM — that remains a review step on the
  real page.
- **Further verified actions** (role changes) still need their own
  reviewer-approved server success point.
- **Hybrid origin boundary**: the overlay runs in the page that renders it.
  Across the cloud pane's origin boundary a route-based explanation is the
  fallback; there is no cross-origin DOM access.
- **Per-tenant analytics** now exists at `GET /api/knowledge/learning-analytics`
  and in the Learning Center for `team.manage` (starts, completions,
  abandonment, completion rate and the most common stuck step). It is aggregate
  by design; it does not expose member names or business payloads.
- The queue covers connectivity loss on a local page; it is not a general
  business-data outbox and does not sync a tenant's operational records.
