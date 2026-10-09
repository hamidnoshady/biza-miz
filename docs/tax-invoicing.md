# Taxpayer invoicing (سامانه مودیان) — Accounting

Issue #866. This is the reference for the taxpayer submission workspace inside
Accounting (`/accounting/tax-invoices`). It describes what is built, how a record
moves, what guarantees the database enforces, and what is not live yet.

> **Status: live transmission is not active.** The production adapter is a stub
> that fails every record permanently with `live_provider_unavailable`. The
> sandbox simulator is the only adapter that submits. The live protocol (signing,
> certificates, pattern versions, and the exact header and body fields) has not
> been verified against the authority's official specification and sandbox. Do not
> switch a profile to `production` until that verification is done. See
> [Open items](#open-items).

## What a record is

A tax record reports **one completed sale** (an `orders` row with status
`completed`) to the taxpayer system. It is a first-class, append-only submission:

- It keeps the **snapshot that was sent** (`payload_snapshot`) with its hash
  (`payload_hash`) and payload version. The snapshot is what the authority received.
  It is never rebuilt from current products or customers.
- It keeps the **reference number** (`{prefix-}{unit}-{orderNumber}-{S|A|C}{revision}`,
  e.g. `BIZ-K1-1042-S1`), the **uid** (the sender's «شناسه یکتای ارسال», a UUID
  generated before the first send and reused on every retry), and the authority's
  **receipt id** once it holds the packet.
- It keeps its **status**, attempts, last error (code, message, and the authority's
  own issues), the **inquiry result**, and a **correlation id** that ties every log
  line and event for that record together.
- It links to what it corrects: an amendment or cancellation points at its parent
  accepted record (`parent_submission_id`).

Each state change writes one row to `tax_invoice_events`. That table is append-only.

## Lifecycle

Every move is one of the transitions below. The database refuses any other move,
and each move writes one event.

| From | What happens | To |
| --- | --- | --- |
| *(none)* | the sale is prepared and frozen | `prepared` |
| `prepared` | queued for sending | `queued` |
| `queued` | claimed by the worker under a 5-minute lease | `sending` |
| `sending` | the authority received the packet | `submitted` |
| `sending` | refused before delivery (connection refused and similar) | `queued` with backoff, or `error` (`retries_exhausted`) after 8 attempts |
| `sending` | outcome unknown (a timeout after the packet may have left) | `awaiting_inquiry` |
| `sending` | the authority rejected the content | `rejected` |
| `sending` | permanent failure | `error` |
| `sending` | the worker died and the lease ran out | `awaiting_inquiry` |
| `submitted` or `awaiting_inquiry` | inquiry: accepted | `accepted` |
| `submitted` or `awaiting_inquiry` | inquiry: rejected | `rejected` |
| `submitted` | inquiry: still processing | `submitted`, asked again later |
| `submitted` | inquiry: unreachable | `awaiting_inquiry` |
| `awaiting_inquiry` | inquiry: not found (the packet never arrived) | `queued`, with the same uid |
| `error` | operator retry | `queued` |
| `accepted` | an accepted cancellation of this sale | `cancelled` |

`rejected` and `cancelled` are terminal. A rejected sale is corrected by a new
revision, and the refused record stays as it was.

- **prepared**: built and frozen. Blockers, if any, prevent a record from being created at all.
- **queued → sending**: claimed under a lease (5 minutes). The worker holds the record while it sends.
- **not delivered** (connection refused and similar): back to `queued` with backoff
  (5 s, doubling, capped at 5 min). After 8 attempts it becomes `error`
  (`retries_exhausted`).
- **unknown delivery** (a timeout after the packet may have left): `awaiting_inquiry`.
  The record is **never resent blind**. It is inquired by uid first.
- **rejected** (the authority refused the content): terminal. A new revision is
  created to correct it. The refused record is kept as it was.
- **error** (permanent failure, or retries exhausted): an operator's retry moves it
  back to `queued`.
- **accepted**: the authority holds the packet and accepted it.
- **cancelled**: the parent sale, once an accepted cancellation record is accepted.

Money is integer Rial throughout. Display follows the business's unit. Dates are
Shamsi.

## Corrections

| Action | Kind | Requires | What it builds from | Reference |
| --- | --- | --- | --- | --- |
| Amend | `amendment` | an accepted sale | the **sale as it now stands** (the new facts), linked to the accepted record | `…-A{n}` |
| Cancel | `cancellation` | an accepted sale (kind `sale`) | the **snapshot that was sent**, so the withdrawal matches the original exactly | `…-C{n}` |
| Resubmit | sale / amendment / cancellation of the same kind | a `rejected` record (and an accepted parent, for a correction) | the current source; a **new revision and a new uid** | `…-S{n+1}` |

An amendment or cancellation that is already live for the same parent is returned
as `existing`, not duplicated. An accepted cancellation offers no further actions,
and an accepted amendment offers only amend. A withdrawn invoice cannot be amended.

## Reliability

- **One packet per record.** The uid is generated once, stored, and sent on every
  attempt. The authority deduplicates on it, so a retry after a timeout cannot
  create a second external invoice. The simulator enforces the same rule: a second
  submit under a known uid returns the first receipt and stores nothing new.
- **Durable queue.** The queue is the table. Claims use `FOR UPDATE SKIP LOCKED`
  under leases, so two workers never hold the same record.
- **Worker.** `runTaxInvoiceTick` runs every 30 seconds from `server.ts`. Per
  business, in order: recover expired send leases (→ `awaiting_inquiry`), send due
  queued records, inquire due `submitted` and `awaiting_inquiry` records. Businesses
  are enumerated through `withoutTenantScope("platform", …)`, the same pattern as the
  other integration ticks.
- **Inquiry before resend.** A packet the authority does not hold (`not_found` from
  `awaiting_inquiry`) returns to `queued` with the same uid. A packet that is still
  `processing` stays `submitted` and is asked again later.
- **Observability.** Structured logs (`component: "tax-invoice"`) with the record's
  correlation id, and the event history per record.
- **Webhooks and callbacks.** Not implemented. The worker inquires by uid. There is
  no inbound endpoint, so no signature verification exists yet.

## Database guarantees

Migration `0216_tax_invoicing.sql` creates five tenant tables, each with forced row
level security and a `tenant_isolation` policy:

| Table | Purpose |
| --- | --- |
| `tax_invoice_profiles` | one per business: enabled, environment, submission mode, taxpayer identifiers, reference prefix, sealed credentials |
| `tax_invoice_units` | one per branch: memory id and unit code |
| `tax_item_codes` | a 13-digit «شناسه کالا/خدمت» per product |
| `tax_invoice_submissions` | the records above |
| `tax_invoice_events` | the append-only history |

The database enforces what the service also checks:

- A submission's **identity and payload columns cannot change** after insert
  (`business_id`, `order_id`, `kind`, `revision`, `reference_number`, `uid`,
  `payload_snapshot`, `payload_hash`, totals, and so on).
- A **receipt is recorded once**.
- **Status moves must be legal** (`tax_status_transition_allowed`).
- A submission is **never deleted**, except by the purge, which is gated on the
  transaction-local flag `app.tax_submission_purge` (see
  [Business reset and hard delete](#business-reset-and-hard-delete)).
- **Events are append-only**: `UPDATE` always fails, and `DELETE` fails unless the
  purge flag is set.

These are tested against a real database, as the application role, in
`integration/tax-invoices.integration.test.ts`.

## Permissions

| Capability | Key | Manager | Accountant | Admin | Owner |
| --- | --- | :-: | :-: | :-: | :-: |
| View the register, queue, reports | `tax.view` | ✓ | ✓ | ✓ | ✓ |
| Prepare (and resubmit) records | `tax.prepare` | ✓ | ✓ | ✓ | ✓ |
| Send, retry | `tax.send` | ✓ | ✓ | ✓ | ✓ |
| Inquire (selected or all) | `tax.inquiry` | ✓ | ✓ | ✓ | ✓ |
| Amend | `tax.amend` | | ✓ | ✓ | ✓ |
| Cancel an accepted invoice | `tax.cancel` | | ✓ | ✓ | ✓ |
| Export the register | `tax.export` | | ✓ | ✓ | ✓ |
| Manage taxpayer settings, units, item codes, credentials | `tax.manage_settings` | | | ✓ | ✓ |

Every API route checks its capability with `requirePermission`. The UI shows only
the actions the member's capabilities grant, and the API checks the same grant
again. Cashier, waiter and kitchen roles hold none of these.

## Configuration

- **Profile** (`PUT /api/ledger/tax-invoices/settings`): enabled, environment
  (`sandbox` or `production`), submission mode (`direct` or `tsp`), taxpayer id
  (1–32 Latin letters and digits), taxpayer name, and reference prefix (up to 8
  Latin letters and digits). **Enabling requires a taxpayer id** (409
  `taxpayer_id_required`), and that check rolls back the whole write.
- **Credentials** are write-only. The API returns only `credentialsConfigured`. They
  are sealed with `encryptSecret` under the platform integration key
  (`INTEGRATIONS_ENCRYPTION_KEY`, or a key derived from `JWT_SECRET`). A credentials
  object is a partial write: named fields replace, empty strings are ignored, and
  `null` clears both. The audit row `tax_invoice.settings_updated` records that
  credentials changed, never their values.
- **Units** (per branch): memory id (up to 64 characters) and unit code. The
  reference uses the unit code when present, and otherwise the first eight hex
  digits of the branch id.
- **Item codes** (per product): 13 digits. A sale with a product that has no code is
  blocked, and the blocker names the product.

## Sales, blockers, and what a record reports

A record is built from `orders` (status `completed`) and their non-voided
`order_items`. VAT is the order's own VAT, distributed over the lines by largest
remainder, so the lines sum exactly to it. Preparation is blocked, and nothing is
written, when any of these holds:

`profile_not_configured`, `profile_disabled`, `unit_not_configured`,
`order_not_completed`, `no_lines`, `service_charge_unsupported`,
`item_code_missing` (one per product), `invalid_amount`, `zero_total`,
`totals_mismatch`.

## Reconciliation and reports

The accounting boundary is strict: **taxpayer status never creates ledger rows.**
Reconciliation reads the posted sales (`orders`) and the tax records, and writes
nothing. Revenue and VAT remain the accounting ledger's truth.

Each completed sale in the window (business days, in the business's timezone) gets
one state:

| State | Meaning |
| --- | --- |
| `accepted` | the effective record is accepted and its totals match the sale |
| `pending` | a record is in flight and its totals match |
| `error` | the latest record is in error |
| `rejected` | the latest sale record was rejected and nothing live reports the sale |
| `cancelled` | the sale was withdrawn by an accepted cancellation |
| `mismatch` | a live record disagrees with the sale's current totals, or a voided sale has a live record |
| `missing` | a completed sale that no record reports |
| `voided` | listed, not counted |

The totals show the difference between the sales ledger and the records (for
`mismatch` rows) and the sales no record reports.

Reports on the **Reports** tab:

- **Register**: sent, accepted and rejected records, with status filters, the
  date range, branch, and a free-text search over the reference, the sale number and the buyer.
  Keyset pagination. The API also accepts a customer filter; the screen does not offer it yet.
- **Queue**: records that are queued, sending, submitted or awaiting inquiry.
  Inquire all, or the selected ones; send the first 50 queued records.
- **Unprepared sales**: completed sales with no record yet. Batch preparation.
- **Reconciliation**: the table above, for a date range.
- **Provider errors**: what the authority refused, grouped by its own code, with
  record counts and occurrences.
- **Export**: CSV (`tax-invoices.csv`) of the register, with amounts in the
  business's display unit.

Each record's detail shows its events, the stored snapshot's hash, the sibling
records of the same sale, and a link to the source sale
(`/accounting/orders?order=<id>`).

## Business reset and hard delete

Both paths delete a business's operational data. The tax records must go first:

- They are immutable, so the generic sweep cannot delete them.
- Their `order_id` references are `RESTRICT`, so the sales cannot go while they exist.
- Their events are append-only.

`purgeTaxInvoiceRecords` in `platform-service.ts` runs first in
`clearBusinessDeleteBlockers`, which both `resetBusiness` and `hardDeleteBusiness`
call. It sets `app.tax_submission_purge` for the transaction, deletes the events,
then deletes the submissions leaves first (children before parents), and only then
does the generic sweep run.

Tested in `integration/tax-invoices-business-delete.integration.test.ts`. With the
purge disabled, both paths fail, so the test covers the purge itself.

## Code map

| Path | Role |
| --- | --- |
| `src/lib/tax-invoice.ts` | client-safe types: statuses, transitions, labels, patterns |
| `src/lib/tax-invoice-core.ts` | pure server logic: allocation, hashing, references, payload build, failure and inquiry decisions, reconciliation |
| `src/lib/tax-invoice-provider.ts` | adapter interface, sandbox simulator, production stub, `providerFor` |
| `src/lib/tax-invoice-service.ts` | write path, worker tick, settings, units, item codes, prepare, send, inquiry, retry, amend, cancel, resubmit |
| `src/lib/tax-invoice-queries.ts` | read side: register, detail, unprepared, reconciliation, provider errors, queue, export |
| `src/lib/tax-invoice-http.ts` | error mapping, JSON body reader, filter parsing |
| `src/app/api/ledger/tax-invoices/` | 16 route handlers, each checking its capability |
| `src/app/(app)/accounting/tax-invoices-section.tsx` | the register, queue and unprepared views |
| `src/app/(app)/accounting/tax-invoice-settings.tsx` | taxpayer profile, units, item codes |
| `src/app/(app)/accounting/tax-invoice-reports.tsx` | reconciliation, provider errors, export |
| `src/app/(app)/accounting/tax-invoice-capabilities.ts` | pure mapping from permissions to the actions the UI shows |
| `migrations/0216_tax_invoicing.sql` | the tables, RLS, and the immutability and event triggers |

Client code imports only types from `tax-invoice-core.ts`, because that module imports
`node:crypto`.

## Tests

- Unit: `src/lib/tax-invoice*.test.ts`, `src/app/(app)/accounting/tax-invoice-capabilities.test.ts`,
  and the permission matrix.
- Screen (jsdom): `src/app/(app)/accounting/tax-invoices-section.test.tsx`. It checks
  that each control and tab is drawn only for the capability that grants it, that
  the settings tab never prefills the key field, and that the reports tab reads
  the reconciliation.
- Database: `integration/tax-invoices.integration.test.ts` (lifecycle, immutability,
  credentials, isolation, reconciliation), `integration/tax-invoices-worker.integration.test.ts`
  (the tick: retry, dead-worker recovery, live leases), and
  `integration/tax-invoices-business-delete.integration.test.ts` (reset and hard
  delete). The existing tenant-isolation, export, backup, restore and reset sweeps
  cover the new tables.

## Open items

These are deliberate gaps in this slice. Each one is either a decision still needed
or work that needs the authority's specification and sandbox.

1. **Live protocol.** Verify the signing, certificate, pattern version, header and
   body fields (including the authority's identifiers for the packet and its
   timestamps) against the official specification and the authority's sandbox. Then
   implement the production adapter behind `providerFor`. Until then, production
   records fail closed.
2. **TSP mode.** The setting exists. The token flow, and the TSP-specific request
   fields, are not implemented.
3. **Webhooks and callbacks.** Not implemented. Inquiry by uid is the only way a
   record learns its outcome. If the authority pushes callbacks, the endpoint must
   verify their signatures before it changes any record.
4. **Archive.** The register exports to CSV. There is no separate archive store or
   retention policy.
5. **Customer filter.** The API supports a customer filter; the screen currently
   offers buyer/reference search but no dedicated customer selector.
6. **Merge gate.** PR #897 is blocked by an inherited expenses visual regression
   from issue #832 awaiting owner approval. Production build and the other CI
   checks pass; the local build was OOM-killed. Node 24 type, unit, lint, design
   and targeted database checks also passed locally. See `ISSUE_866_PLAN.md`.
