# Issue #866 — Accounting Next: Iranian Taxpayer System (سامانه مودیان) integration & invoice lifecycle — implementation plan

Working branch: `arena/cc8eb97a-biza-miz`, from `main` at `7b1b11c`.

Reference: `docs/tax-invoicing.md` (how it works), `CLAUDE.md` section «Taxpayer invoicing» (rules for changing it).

## Scope of this change

Issue #866 is an epic. This change is the first slice, and it is deliberately split
at the point where the work cannot be verified from here:

- **Built and verified:** the record model with database-enforced immutability,
  the lifecycle, the payload and reference rules, the idempotent send and inquiry
  path with its worker, the provider boundary with a sandbox simulator, encrypted
  write-only credentials, the sixteen API routes, the Accounting workspace,
  `tax.*` permissions, reconciliation and reports, and the reset and hard-delete
  purge.
- **Not built, on purpose:** live transmission to the authority. The production
  adapter fails every record permanently with `live_provider_unavailable`. The live
  protocol (signing, certificates, pattern versions, exact fields) cannot be checked
  from this sandbox, and a submission that is half-right is worse than none. See
  `docs/tax-invoicing.md` → Open items.

## Requirements and where they stand

Legend: **[x]** built and tested · **[~]** built, with a stated limit · **[ ]** not in this slice.

### Tax configuration

- [x] Taxpayer identifiers — `tax_invoice_profiles` (taxpayer id, name, submission mode, reference prefix).
- [x] Branch and unit identifiers — `tax_invoice_units` (memory id, unit code, per branch).
- [x] Credentials and certificates — sealed with the platform's integration-secret key (`encryptSecret`), write-only, partial merge, audit never carries values.
- [~] Provider connection — the environment selects the adapter. The production connection is a fail-closed stub until the protocol is verified.
- [x] Tax memory and device identifiers — the memory id per branch, validated.
- [x] Invoice numbering and reference requirements — `{prefix-}{unit}-{orderNumber}-{S|A|C}{revision}`, unique per business.
- [x] Test and production environments — `sandbox` and `production`, with production never falling back to the simulator.

### Tax invoice model

- [x] Internal source document — `order_id`, the completed sale.
- [x] Tax invoice / reference number — `reference_number`, unique per business.
- [x] Payload version and schema — `payload_version` = `tax-invoice-payload/v1`.
- [x] Submitted snapshot — `payload_snapshot` and `payload_hash`; checked against the hash in the tests.
- [x] Submission timestamp — `submitted_at`, `accepted_at`, `prepared_at`.
- [x] Provider and external id — `provider`, `receipt_id` (unique per business).
- [x] Status — the lifecycle below, with transitions enforced in SQL.
- [x] Inquiry result — `inquiry_result`, `last_inquired_at`.
- [~] Errors and warnings — the authority's issues (`code`, `message`, `field`) and the last error. There is no separate warnings channel; the issues list carries both.
- [x] Amendment and cancellation relationship — `parent_submission_id`, with one live correction per parent.
- [x] Retry and idempotency key — `idempotency_key` (derived from business, order, kind, revision, parent) and `uid` (generated once, reused on every retry).

### Lifecycle

- [x] prepared → queued → sending → submitted → awaiting_inquiry → accepted / rejected / error.
- [x] Inquiry, and retry from `error`.
- [x] Amendment (new linked record, from the current sale), cancellation (new linked record, from the stored snapshot), resubmission after rejection (new revision, new uid).
- [x] Immutable audit history — `tax_invoice_events`, append-only, with `UPDATE` always refused and `DELETE` only by the purge.

### Workspace

- [x] Sent, unsent and error views — the register's three views, and the unprepared worklist.
- [x] Status, kind, branch and date-range filters, and a free-text search over the reference, the sale number and the buyer — on the register.
- [ ] Customer filter on the screen — the API accepts it; the screen does not offer it yet.
- [x] Batch preparation and submission — prepare and send for selected rows.
- [x] Inquiry, selected or all pending.
- [x] Error detail — in the record's drawer, with the authority's issues.
- [x] Source invoice drill-down — the drawer links to `/accounting/orders?order=<id>`, which opens that sale.
- [x] Retry and resubmit controls.
- [x] Permission-aware actions — each control is drawn only for the capability the member holds, and the API checks the same grant. The screen has jsdom tests for the viewer, operator, administrator, refused, settings and reports paths.

### Permissions

- [x] View, prepare, send, inquiry, amend, cancel, export, and manage settings (credentials) — eight `tax.*` keys, in the permission registry and the matrix. Manager and accountant presets as stated in the doc. Every route checks its key.

### Reliability

- [x] Idempotent submission — `uid` and `idempotency_key`, both unique per business, plus the partial unique indexes for one live sale per order and one live correction per parent.
- [x] Durable queue and job state — the table, with leases and `FOR UPDATE SKIP LOCKED` claims.
- [x] Safe retry — exponential backoff from 5 s, capped at 5 min, dead after 8 attempts. Unknown delivery is inquired, never resent blind.
- [ ] Callback and webhook verification — **not built.** There is no inbound endpoint. Records learn their outcome by inquiry, which is why nothing needs signature verification yet. If the authority pushes callbacks, they must be verified before any record changes.
- [x] Deduplication by provider and external id — the uid is the authority's deduplication key, and the simulator enforces it.
- [x] Correlation IDs and structured logs — every record carries a correlation id, and every log line names it.
- [x] No duplicate tax invoice on timeout or retry — tested against the simulator, including a timeout after the packet has left, a lease that expired after delivery, and a lease that expired before it.

### Accounting boundary

- [x] No second revenue or VAT ledger — the feature writes no journal rows. Reconciliation reads `orders` and the records and writes nothing.
- [x] Taxpayer status separated from accounting truth — a record's status never changes a sale's totals.

### Reports

- [x] Sent, accepted and rejected register.
- [x] Pending and inquiry queue.
- [x] Reconciliation against internal invoice and VAT totals — eight states, with the difference and the unrecorded totals.
- [x] Provider error report — grouped by the authority's own code.
- [~] Export and archive — CSV export of the register, in the business's display unit. There is no separate archive store or retention policy.

### Definition of Done

- [x] Taxpayer submissions are first-class immutable records — enforced by triggers and RLS, tested as the application role.
- [x] Retry cannot create a duplicate external invoice — tested end to end, and the database refuses a second live sale.
- [x] Submitted payload snapshots stay historically reproducible — after an amendment, the accepted original still verifies against its stored hash, and a cancellation reproduces the sent totals and lines, not the current sale.
- [x] Taxpayer status is separate from accounting financial truth — reconciliation is read-only.
- [x] Granular permissions and secure credentials are enforced — API guard tests, the permission matrix, and database tests on sealing, merging and the audit payload.
- [x] Reconciliation ties submissions to internal source documents — per sale, with the mismatch, missing and voided cases tested.

## Defects found and fixed while testing against a real database

These were not visible to the unit tests, and each one would have failed in production.

1. **Audit inserts with one parameter in two types.** `saveTaxProfile` and `saveTaxUnits` used `$1` as both a `uuid` business id and a `text` entity id. Postgres refuses that, so no settings could be saved. Fixed by giving each its own parameter.
2. **Business deletion blocked by immutable records.** Reset and hard delete hit `RESTRICT` foreign keys and the immutability trigger. Fixed by `purgeTaxInvoiceRecords`, which runs first, under its own flag, leaves first. Tested by disabling it and confirming both paths fail.
3. **Nested table rows in three screens.** The register, the reports and the settings tables put a `<tr>` inside `DataTableHead`, which already renders one. Invalid HTML, and a hydration error in the browser. Found by the screen tests and fixed in all three modules.

## Verification

Run on this branch, in this sandbox, against the working tree before the commit. The full database and unit suites ran on Node 22. The type check, lint, design checks, the unit suite and the tax and sweep database suites were also run on Node 24, which is the runtime the repo's CI pins. The production build was attempted on Node 24 only.

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc --noEmit`, heap 3 GB | **passed**, on Node 22 and Node 24 |
| Lint | `npm run lint`, zero warnings | **passed**, on Node 22 and Node 24 |
| Unit suite | `npm test` | **passed**: 704 files, 9,311 tests, on Node 22 and Node 24. Before this change the baseline was 698 files and 9,175 tests. |
| Database suite | `npm run test:db` | **passed**: all 200 integration files on Node 22. 31 files ran in one run, and the other 169 in two parallel shards (85 and 85 files). The shards passed 877 tests with one pre-existing skip (in the AI gateway suite), and 830 tests. The tax suites and the tenant-isolation, reset, export, backup and restore sweeps were re-run on Node 24: 67 tests passed. |
| Design | `npm run test:design` | **passed**: 5 files, 38 tests, on Node 22 and Node 24 |
| Build | `npm run build` | **not verified locally.** The webpack compile was killed by the kernel's out-of-memory killer, twice, on Node 24.21.0 with a 3 GB heap cap, on this 3.9 GB sandbox with no swap. A Turbopack compile reached the same memory ceiling and was stopped. The CI build job is the gate for this step. |
| Visual regression | `npm run test:visual` | **not run locally.** Chromium download is blocked by sandbox egress. CI fails only on `accounting-expenses.png` (4.06%, bounds 54,18 1370×830). The identical failure already exists on main before this feature; see the evidence below. No baseline was re-recorded. |

Two problems surfaced by the checks above, and fixed:

- The new screen tests found a table row nested inside another row in three tax modules. The fix removes the inner row, which the shared table head already renders.
- The full suite found three rule violations in the new code: bare loading sentences (now the shared `LoadingSkeleton`), and the authorization contract, which allow-listed the accounting families but not the taxpayer capabilities. The contract now lists the `tax.*` keys explicitly, and the test name says so. The rule itself is unchanged.

## Open items

Tracked in `docs/tax-invoicing.md` → Open items: the live protocol and its verification, the TSP token flow, webhooks or callbacks, and a separate archive. These are the decisions and the external work that stand between this slice and live taxpayer submission.

## PR #897 — CI follow-up (2026-10-09)

Production build, type check, unit tests, real-database integration tests,
ESLint, API guards, design checks, data transfer and shippable checks passed
on feature commit `936242f`. The aggregate gate remains red because visual
regression fails on the expenses screen. Do not merge while it is red.

This is an inherited, intentionally unapproved expense-register redesign, not
evidence of a taxpayer navigation regression:

- Main commit `ac48d7faae8461ea967317b13b947d92a874dd85` (issue #832)
  explicitly says the expenses baseline awaits owner approval.
- Its visual check `113784854336` reports 4.06% changed pixels, bounds
  `54,18 1370×830`, on `docs/design/visual/accounting-expenses.png`.
- The subsequent main commit `6ec02b5ea671920ab250a0d5860d681a22fcff66`
  (parent of this session's base `7b1b11c`) has the same annotation in
  check `113804662696`.
- PR #897 check `113945903828` reports exactly the same file, percentage
  and bounds. Other captured screens pass.

The artifacts cannot be downloaded here because their Azure blob host is
blocked. The annotations and main commit message were read through the GitHub
API. No unrelated expense features were reverted and no navigation was hidden
to clear this check. Owner approval/resolution of the existing expense visual
change is required before this PR can satisfy the all-green merge rule.
