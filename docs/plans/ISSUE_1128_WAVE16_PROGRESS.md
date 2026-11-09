# Issue #1128 — vendor quote → approved project purchase → payable

Date: 2026-10-26. Additive continuation of #1297, not a claim that all agency
acceptance criteria or all of §D are complete.

## Delivered boundary

This document covers **client-funded/reimbursable vendor purchases**, not
agency-owned operating expenses or an independent procurement app. A project,
canonical Customer and active canonical Supplier are required. A quote records the
supplier's reference, description, quoted date and final total in integer rial.
It does not calculate or invent tax, agency fees, media performance or attribution.

Migration `0289_agency_vendor_purchases.sql` adds an RLS-protected register and
widens the existing Workspace approval/activity subject checks. There is no
backfill, no change to old costs and no SQL journal insertion. Quote numbers use
the existing business register-number allocator (`VP-001` etc.).

Lifecycle:

1. `draft` → `submitted` freezes the quote and queues a shared `vendor_purchase`
   approval in one tenant transaction.
2. A different authorized project manager decides through the existing shared
   queue. Self-approval and project-viewer decisions are refused. Withdrawal
   returns to draft; rejection or a request for changes rejects this immutable
   quote (record a new quote). Neither submission nor approval posts an expense.
3. `approved` is a commitment, **not a ledger fact**. Explicit booking requires
   `workspace.manage`, project-manager capability and `finance.expenses_manage`.
   The operator supplies the expense occurrence date independently of quote date.
4. Booking calls the existing reimbursable-cost/domain-event posting engine with
   `settledBy: payable`. It adopts the business's saved gross/net policy (or that
   engine's documented fallback), never inferring treatment from spend. A posted
   payable cost is linked before the purchase becomes `booked`.
5. Payment and exact-mirror reversal remain in the existing Accounting client-cost
   workflow with its separate `finance.payables_manage` gate. There is no new
   payment implementation or automatic payment tool.

The purchase row lock serializes booking. Concurrent/retried requests return the
same cost ID after success. A posting failure or non-posting result rolls back the
cost, domain event, purchase link and booking activity: the approved purchase stays
unbooked. This endpoint does **not** leave a second unposted expense in a human
posting queue; resolve the posting prerequisite and explicitly retry booking.
Submitted financial substance and booked cost links cannot be rewritten. Canonical
client/vendor attribution participates in the existing audited CRM merge registry;
that endpoint remains Customer-only and is not widened to merge Supplier-only
parties. Inactive/merged-away suppliers cannot receive new bookings.

## Member workflow

The agency project's existing **finance tab** now contains the purchase panel:

- Canonical client/supplier pickers appear only with directory-read authority and
  project-management capability. The API independently checks `parties.view`.
- Rial storage, business-selected rial/toman input, Persian digits and Jalali date
  controls/display; explicit occurrence date before booking.
- Register rows show current client/supplier names, supplier quote reference,
  description, amount, date and distinct commitment/posted statuses.
- The commitment subtotal includes only approved, unbooked quotes in the displayed
  list, explicitly capped at 200 rows. Booked costs are excluded. This is **not** a
  new full-project P&L aggregate, forecast margin or a claim about missing hours.
- Shared approval subjects link back to the project's finance tab and the exact
  purchase row, so the reviewer can inspect the quote rather than an unsupported
  generic entity drawer.
- No approval shortcut on the purchase API/screen. Read-only users have no create,
  submit or accounting-book controls. Server capabilities remain authoritative.
- Loading, error and refresh states use the existing shared chrome. Successful
  creation clears the quote fields to avoid accidental duplicate drafts.

Routes:

- `GET /api/agency/vendor-purchases?projectId=<uuid>` — workspace view + project view.
- `POST /api/agency/vendor-purchases` — workspace manage + directory read + project
  manage; creates a draft only.
- `POST /api/agency/vendor-purchases/[id]` — submit or book; booking adds expense
  management authority. There is no approve action.
- Shared approval route and direct generic approval decisions propagate through
  the same purchase service. This includes the existing human-approval-gated AI
  decision action. Generic approval requests refuse this subject: only purchase
  submission can freeze its quote and create its request atomically.

MCP coverage is regenerated. No create/book/payment tool is added. Purchase author
attribution is registered in the existing member-history hard-deletion guard.
Exactly four business apps remain; no new navigation app or eligibility gate.

## Verification

- Vendor-purchase DB integration: **11/11** on the final implementation. Covers
  concurrent booking, no posting at approval, actual settlement, self/viewer
  refusal, frozen SQL facts, foreign-tenant/project/non-member refusal, generic
  decision propagation, posting rollback/retry, archived suppliers, audited client
  merge, saved gross policy and actual RLS using a non-bypass database role.
- Adjacent integration suites: vendor settlements **20/20**, agency party merges
  **7/7**, live party-reference coverage **6/6**. These ran together with the prior
  10-case purchase suite before current-name display and the additional RLS case;
  the final 11-case purchase suite was rerun afterward.
- Focused vocabulary, API, UI, shared approval, loading/design, agency guard,
  member-history and MCP drift tests pass. Shared-queue link plus purchase UI/API
  were rerun after the final screen changes: **13/13**.
- Changed-file ESLint and `git diff --check`: pass.
- Narrow TypeScript check reports only the two pre-existing Holoo errors:
  `client.ts:54` missing `mssql` declarations and `client.ts:77` untyped generic.
  No changed-file errors. This is not a clean full-project typecheck claim.
- Full unit regression: running separately; not yet a full-green claim. The draft
  PR must remain under review until its final regression result and CI are checked.

## Still not delivered

Remaining agency acceptance work includes reporting/calendar and defensible manual
campaign attribution/KPIs, dashboards/report/AI/print templates, renewal/versioned
scope, customer advances/overdue balances, actual time capture and campaign ledger
dimension, preset-combination UX, and rollout/security sweeps. Agency-owned vendor
expense procurement and a full commitment-aware project P&L aggregate are not added
by this slice. No fictional campaign facts, integrations or actual hours are shown.

The #1110 eligibility matrix is still absent and that issue is OPEN; #1128 P0 item
5 cannot be marked implemented by this work. GitHub #1128 was already CLOSED when
checked during this session; that administrative state is not evidence that its
remaining acceptance criteria have passed. This continuation does not reopen it.
