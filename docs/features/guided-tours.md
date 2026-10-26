# Interactive guided tours (issue #972)

A tour is a short walk over the live UI of one page, started from that page's
existing «آموزش» button. There is no second help button: the button's one modal
offers **تور تعاملی صفحه** (when the page has a tour the member may use) and
**راهنمای پایگاه دانش** (the article / external learning page, unchanged).

This document covers what the first slice ships and the rules the next slices
must keep. The epic's remaining phases (hierarchy and learning paths, verified
tasks, Learning Center, Tour Studio, AI discovery) are tracked on #972.

## What ships

| Piece | Where |
|---|---|
| Catalogue, eligibility, progress rules (pure) | `src/lib/tours.ts` |
| Popover placement and spotlight geometry (pure) | `src/lib/tour-geometry.ts` |
| Progress storage, row lock | `src/lib/tours-service.ts`, migration `0259_tour_member_progress.sql` |
| API | `GET /api/knowledge/tours?page=`, `GET /api/knowledge/tours/[tourId]`, `POST /api/knowledge/tours/[tourId]/progress` |
| Runtime | `src/components/tours/tour-provider.tsx` (one, in `DashboardMain`), `tour-overlay.tsx` (lazy) |
| Modal | `src/app/dashboard/knowledge-help.tsx` |
| Pilot | `accounting.products.list` on `/accounting/products` |

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
  permissions and the business's industry, on the lookup *and* on every
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

Cross-page tours and learning paths, verified-action steps, offline progress
queueing, the Learning Center, Tour Studio, staff assignments and reports, the
AI discovery tool, Hybrid cloud-pane handling (the overlay runs in the page that
renders it; across the pane's origin boundary a route-based explanation is the
fallback), and per-tenant analytics. Each needs its own design decision on the
epic.
