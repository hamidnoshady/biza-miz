# Issue #866 — Accounting Next: Iranian Taxpayer System (سامانه مودیان) integration & invoice lifecycle — implementation plan

Working branch: `arena/cc8eb97a-biza-miz`, from `main` at `7b1b11c`.

Reference: `docs/tax-invoicing.md` (how it works), `CLAUDE.md` section «Taxpayer invoicing» (rules for changing it).

## Scope of this change

Issue #866 is an epic. This change is the first slice, and it is deliberately split
at the point where the work cannot be verified from here:

- **Built and verified:** the record model with database-enforced immutability,
  the lifecycle, the payload and reference rules, the idempotent send and inquiry
  path with its worker, the provider boundary with a sandbox simulator, encrypted
  write-only credentials, the browser API routes, Accounting workspace,
  `tax.*` permissions, reconciliation/reports, customer filters, immutable archive,
  signed platform/TSP callbacks, and accepted/pending/disputed retention protection.
  See the follow-up verification below for the exact latest results.
- **Not active, on purpose:** live transmission to the authority. A gated transport
  implements public-documentation GET_TOKEN/enqueue/inquiry plumbing with mock tests,
  but no reviewed cryptographic codec or official sandbox verification. The production
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
- [~] Invoice numbering — internal `{prefix-}{unit}-{orderNumber}-{S|A|C}{revision}`, unique per business. Official 22-character taxid/check digit and invoice pattern mapping remain blocked on current official vectors/specification.
- [x] Test and production environments — `sandbox` and `production`, with production never falling back to the simulator.

### Tax invoice model

- [x] Internal source document — `order_id`, the completed sale.
- [~] Tax invoice / reference number — internal `reference_number`, unique per business; not claimed to be the official taxid.
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
- [x] Dedicated customer filter on the register and reconciliation, API propagation and export. Stored historical buyer choices are included; register matches the stored buyer, reconciliation matches source-sale customer.
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
- [x] Durable queue — leases, `FOR UPDATE SKIP LOCKED`, opaque claim fencing, stale-result audit evidence and disputed-evidence holds; source-order locks fence held orders from new claims.
- [x] Safe retry — exponential backoff capped at 5 min; only proven non-delivery exhausts to retryable error. Unknown delivery stays in inquiry beyond eight attempts. Legacy exhausted ambiguity receives a retention hold.
- [~] Callback — authenticated platform/TSP HMAC endpoint, bounded raw body, timestamp freshness, tenant binding, replay dedup/conflict, row locks and immutable event history. This is NOT a claim of official Moodian callback compatibility.
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
- [x] CSV export and immutable archive checkpoints with JSON download/hash verification. Operational threshold defaults to 365 days; retention is indefinite, NOT an assumed statutory period. No accepted record/event/archive is purgeable. Pending delivery and disputed-evidence holds also block reset/delete.

### Definition of Done

- [x] Taxpayer submissions are first-class immutable records — enforced by triggers and RLS, tested as the application role.
- [~] Retry cannot create a duplicate external invoice — simulator and database concurrency scenarios verified. Actual authority idempotency/acceptance is NOT yet verified; production remains disabled.
- [x] Submitted payload snapshots stay historically reproducible — after an amendment, the accepted original still verifies against its stored hash, and a cancellation reproduces the sent totals and lines, not the current sale.
- [x] Taxpayer status is separate from accounting financial truth — reconciliation is read-only.
- [x] Granular permissions and secure credentials are enforced — API guard tests, the permission matrix, and database tests on sealing, merging and the audit payload.
- [x] Reconciliation ties submissions to internal source documents — per sale, with the mismatch, missing and voided cases tested.

## Defects found and fixed while testing against a real database

These were not visible to the unit tests, and each one would have failed in production.

1. **Audit inserts with one parameter in two types.** `saveTaxProfile` and `saveTaxUnits` used `$1` as both a `uuid` business id and a `text` entity id. Postgres refuses that, so no settings could be saved. Fixed by giving each its own parameter.
2. **Business deletion and retention.** Explicit purge removes only eligible nonaccepted/nonpending/nonheld records, archives and events, leaves-first under the transaction-local flag. Accepted (including cancelled), pending delivery and disputed evidence block destructive operations atomically, preserving source documents.
3. **Nested table rows in three screens.** The register, the reports and the settings tables put a `<tr>` inside `DataTableHead`, which already renders one. Invalid HTML, and a hydration error in the browser. Found by the screen tests and fixed in all three modules.

## Baseline verification (through 4fac7c3; not the latest follow-up)

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

- [ ] Current official protocol/SDK vectors and sandbox access; verified taxid/pattern mapping, signing/encryption, trust roots, wire snapshot/version persistence, real direct and TSP acceptance/inquiry.
- [ ] Product/legal confirmation of indefinite retention and resulting reset/delete refusal. No accepted history is deleted while open.
- [ ] Reviewed resolution workflow for contradictory provider evidence. Holds cannot currently be cleared through an application endpoint.
- [ ] Owner decision on inherited expenses visual change; this PR does not update baselines or touch expenses.
- [ ] User decides whether/when to merge PR #897. **Do not merge.**

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


## Follow-up verification (2026-10-10)

Continue existing PR #897 on `arena/cc8eb97a-biza-miz`; pulled and confirmed
`4fac7c3` before follow-up. No baseline recording, expenses edits/reverts, or
navigation removal. Migrations 0217–0220 are forward-only and applied locally;
new archive table includes forced RLS and tenant policy in its creating migration.

- [x] Customer filter in register, API and reconciliation; historical buyer choices.
- [x] Archive settings/download, hashes, indefinite retention, accepted and in-flight
  purge protection, disputed-evidence holds, tenant FK guard and immutable anchors.
- [x] Signed platform/TSP callback with replay event history; secret remains sealed
  and write-only. No official callback compatibility claimed.
- [~] Gated real HTTP/TSP auth plumbing, mock HTTP tests; no codec or live activation.
- [x] Callback/inquiry and callback/send fencing, source-order hold/claim barrier,
  unknown-delivery attempt-limit regression and app-role isolation scenarios.
- [x] Tax suites: **3 files / 37 tests passed** (latest focused run).
- [x] Final unchanged-tree full units: **706 files / 9,327 tests passed**;
  targeted tax/UI/API guard check **9 files / 1,054 tests passed**.
- [x] Final `npx tsc --noEmit`, `npm run lint` (zero warnings), and
  `npm run test:design` (**5 files / 38 tests**) all passed on Node 24.
- [~] Full DB run completed: **198/200 files passed; 2,729 passed, 3 failed,
  1 skipped**. It overlapped edits/targeted DB runs: two hybrid-sync failures plus
  one retention-hold error-shape assertion against cached pre-fix platform service.
  Both failing files reran alone on final code: **2 files / 23 tests passed**.
  A fresh unchanged-tree full DB run is in progress, without competing DB runs.
- [x] Final taxpayer logical backup/restore round trip includes an accepted record,
  immutable archive, events and verified hashes; excludes the other tenant.
- [x] Full-run Linux tenant/RLS, data-transfer, migrations, reset, backup, restore
  and AI isolation suites passed. Migrations reapply as a no-op.
- [~] Local build attempted on Node 24 with repository heap setting (3072 MB) and
  Postgres stopped: kernel OOM (~3.7 GB RSS on 3.9 GB/no swap). No successful local
  build claimed. CI production build passed at 4fac7c3; new-head result pending.
- [ ] Follow-up push/CI watch/comments pending. The full checklist has run and
  the failed DB files passed in isolation; the extra unchanged-tree full DB repeat
  is retained as an additional check (not presented as green before it finishes).

Main visual evidence (annotations rechecked):
- https://github.com/hamidnoshady/biza-miz/actions/runs/37919841516
- https://github.com/hamidnoshady/biza-miz/actions/runs/37925908136
Both report `accounting-expenses.png`, **4.06%**, bounds **54,18 1370×830**.
PR 4fac7c3 visual job 113980285958 reports the same. No baseline update authorized.
