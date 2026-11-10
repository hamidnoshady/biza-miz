# Issue #1128 — cancel an approved, unbooked vendor commitment

Continuation of merged #1332. The commitment report could show an abandoned,
approved purchase forever because the register previously allowed only booking
from that state. This slice adds an explicit, auditable retirement path, not an
expense reversal or a new procurement engine.

## Lifecycle and authority

`approved` → `cancelled` is now allowed only while the purchase is unbooked. The
existing action endpoint accepts `{ action: "cancel", reason: "..." }` and checks:

- Active agency membership and `workspace.manage` through the existing guard.
- **Independently**, `workspace.approve`, not just expense or payable authority.
- Project-management capability inside the service, with tenant-scoped lookup.
- A nonblank, trimmed reason of at most 500 characters.

The actor may be the original requester if they now hold both required platform
permissions and project-management capability: cancelling an unposted commitment
reduces it, and is not a self-approval to spend. This does not alter the separate
shared-queue rules for approving the original purchase. The original approval
remains approved and is not deleted or rewritten; the cancellation is a later act.

Cancellation locks the same purchase row booking locks. Only one operation wins a
booking/cancellation race. A purchase already booked cannot be cancelled here;
posted facts and payment reversals remain the Accounting engine's responsibility.
Concurrent duplicate cancellations produce one cancellation/activity and one state
conflict, preserving the first reason rather than silently rewriting history.

## Storage and accounting invariants

Additive migration `0292_agency_purchase_cancellation.sql`:

- Adds terminal `cancelled` status and cancellation reason, actor ID/name snapshot
  and server timestamp. No explicit data backfill or change to earlier postings.
- Requires complete cancellation metadata for the cancelled state and empty
  metadata for other states. The update trigger permits metadata creation only
  during `approved` → `cancelled` and freezes it thereafter.
- Preserves the prior identity/submitted-fact freezes, tenant/reference checks,
  approval guard, supplier checks, booked payable matching and audited merge door.
- A cancelled purchase cannot be reopened, re-priced, deleted, booked, or have its
  cancellation history rewritten. Its cost link remains null.
- Registers `cancelled_by` in the existing member-history attribution guard so a
  later hard member deletion cannot silently remove the cancelling actor.

The transaction updates the purchase and writes Workspace activity; it creates no
cost, domain event, payable or journal entry. The existing P&L's approved/unbooked
filter automatically excludes cancelled purchases without adding a second report
formula. Other live commitments and existing posted margin are unaffected. An
inactive supplier does not prevent retiring a historical approved commitment.

## Member workflow

The project purchase panel exposes cancellation only for an approved purchase and
only with the server-derived management/approval capabilities. Neither directory
read nor accounting-booking authority alone grants cancellation. A second form
requires a reason and explicit confirmation and says this is **not** an accounting
reversal. The entered reason is retained on refusal; a successful cancellation
refreshes the register and adjacent project P&L through the existing revision
callback. Refresh closes a stale confirmation if its purchase is no longer approved.

Cancelled rows show the Persian status, reason, actor snapshot and Jalali date.
They retain the original quote facts and have no booking/cancellation controls.
The loaded-page commitment subtotal now also uses exact decimal/BigInt formatting,
matching Wave 17's whole-project precision instead of rounding large page totals.
No new app, route, background task or AI cancellation tool is introduced. The MCP
coverage matrix is regenerated and records the new human-action boundary.

## Verification

- Database integration: **44/44** across vendor purchases (**17**), project P&L
  (**14**), agency party merges (**7**) and live party-reference coverage (**6**).
- New assertions cover cancellation audit fields and original approval retention;
  no cost/event/payable; immutable history/substance; no reopen or booked-cancel;
  required reason; viewer/non-member/foreign tenant refusal; archived supplier;
  booking/cancellation races and concurrent retries; and commitment removal with
  unknown posted figures/margin preserved.
- Focused vocabulary, API, components, member-history, MCP drift, loading and
  design checks: **140/140**. API tests pin both independent permissions and
  no booking call. UI tests pin explicit confirmation/reason, authority, history,
  report invalidation only on success, refusal state and exact large page totals.
- Targeted TypeScript (agency libraries/routes, project components, related
  integration tests and repository `src/types` declarations): pass.
- Changed-file ESLint and `git diff --check`: pass.
- Full repository unit regression not run locally for this slice. CI/review is
  still required before merge; no auto-merge is enabled.

## Still remaining

This completes the missing approved/unbooked cancellation path, not every #1128
criterion or general purchase amendments. Changes to approved quote substance
still require a new quote and independent approval. Actual time/resources,
campaign ledger dimensions, agency-owned procurement, advances/overdue balances,
campaign calendar/reporting/manual attribution, dashboard/report/AI/print templates,
renewals/versioned scope, preset-combination UX and rollout/security sweeps remain.
The #1110 eligibility matrix is still absent; do not claim that boundary complete
or treat #1128's pre-existing closed status as proof all acceptance items shipped.
