# Issue #868 — repository ownership & decision matrix

This document records which repository owns what data, which side is the ledger authority, which contracts must change together, and which remaining items require explicit product decisions before code can proceed.

## Repositories inspected

The PR works against the monorepo `hamidnoshady/biza-miz`. Other accounting-relevant surfaces:

- `hamidnoshady/biza-cloud` — multi-tenant control plane (provisioning, billing, sync coordination).
- `wordpress-plugin/` (in this repo) — WooCommerce sales connector; writes via the API.
- `electron/` (in this repo) — desktop shell; does not originate or transform accounting data.
- Holoo import adapter (`src/lib/integrations/holoo/`) — posts through in-repo services; producer only.

No separate mobile/sync-worker/reporting repos are referenced from `AGENTS.md`/`CLAUDE.md`; any future consumer must use the public HTTP/JSON contract.

## Ownership — two axes, kept separate

Earlier revisions of this document conflated **repository ownership** (which codebase implements a thing) with **runtime authority** (which deployment is the system of record for a row), and stated both "the monorepo is the ledger authority — cloud replicates, never recomputes" and "the ledger stays cloud-owned". Those are not the same axis and the first phrasing was wrong about runtime authority. The split below is the single source of truth; it follows `src/lib/data-ownership.ts`, which the replication catalogue and sync code read.

### Axis A — repository ownership (code)

| Concern | Repository / module |
| --- | --- |
| Dimension master data logic (settings, values, hierarchy, archive) | `biza-miz` via `accounting-dimensions-service.ts`. Tables `accounting_dimension_settings`/`accounting_dimension_values`, RLS from migration 0216. |
| Journal postings with dimensions | `biza-miz` via `ledger-service`/`manual-journal-service`/`expense-service`/`fixed-assets-service`. One posting guard: `assertDimensionsPostable`. |
| Branch/project attribution | `journal_entries` (entry-level), never duplicated onto lines. |
| Reports by dimension | `biza-miz` via `accounting-dimension-reports-service.ts` (read-only over `journal_lines`). |
| Trading attribution rules | `biza-miz` via `accounting-dimension-mappings-service.ts` (table `accounting_dimension_mappings`); resolved at posting, never referenced by posted rows. |
| Desktop packaging | `electron/`; no accounting logic. |

Repository ownership says where the code lives. It says nothing about which deployment may write a row.

### Axis B — runtime authority (data), per `src/lib/data-ownership.ts`

| Data | Runtime authority | Consequence |
| --- | --- | --- |
| `accounting_journals` (and the dimension attribution stamped on their lines) | **cloud_authoritative** | The cloud deployment is the ledger system of record. A site never maintains a second writable ledger. The only site-originated ledger effect is reversing a manual journal, and it is applied as a **mirror** of the original entry (`dimensionMirror: true`) — nothing is recomputed. |
| `accounting_dimension_master` (settings, values, mappings) | **cloud_authoritative** | IDs are preserved end to end so a site's attribution columns reference exactly the values the cloud holds; archive propagates as `is_active=false`. A site is never a second writable authority for a value a posting names. |
| Orders, expenses, and other site business facts | **site_authoritative** | The site writes its own facts; the cloud replicates them and never recomputes them. |
| `payroll_run_allocations`, employee default-dimension columns | not on the feed | Immutable posted-run snapshot / staff-local configuration; cloud-owned, deliberately outside master sync (see §6.4). |

### Golden rules

1. Projects/branches stay canonical and unduplicated.
2. **Runtime**: the cloud deployment is the ledger authority — `accounting_journals` and the dimension master are `cloud_authoritative`, and no site ever holds a second independently writable ledger. **Replication**: both directions move facts as rows (per-field HLC, LWW) and the receiving side never recomputes a fact — "cloud replicates, never recomputes" is the replication contract, not a claim that the repository is the runtime authority.
3. `assertDimensionsPostable` is the single-policy gate; every posting path calls it.
4. Forward-only migrations; every new tenant table gets an RLS policy in the same migration.

## Implemented contracts (this batch) and what stays deferred

### 4. Bulk dimension assignment on unposted drafts (DONE)

- Service: `assignDimensionsToDrafts({ businessId, actorId, draftIds, dimensions, mode, dryRun })` in `src/lib/draft-dimension-assignment.ts` — one transaction, `FOR UPDATE OF d` in `approveDraft`'s lock order (a targeted draft that vanished answers **409 `draft_approval_race`** and the whole call aborts), values held to `assertDimensionsPostable` (cross-tenant / archived / parent / wrong-kind / out-of-window / disabled refused with 400 before any write), one `journal_entry_draft_dimension_audit` row per changed line (`action` = `bulk_fill` | `bulk_overwrite`, the migration-0222 check constraint's names) that survives the draft's deletion (no FK on `draft_id`, on purpose).
- API: `POST /api/ledger/dimensions/bulk-assign` (`ledger.approve`), body `{ draftIds, dimensions, mode: "fill_blank" | "overwrite", dryRun? }`. Overwrite semantics shipped as (a) fill blanks **and** (b) explicit overwrite — an explicit `null` clears a kind; unnamed kinds are never touched. No silent overwrite.
- UI: the drafts screen's «تخصیص گروهی ابعاد» panel — select drafts, pick values + mode, dry-run preview of every changed line (before → after), explicit confirmation.
- Proof: `integration/accounting-dimension-operations.integration.test.ts` §1.

### 5. Opening / carry-forward with dimension splits (DONE)

- `closeFiscalYear` closes every (account × dimension tuple) group against a **retained-earnings line of the same tuple** (`src/lib/closing-dimensions.ts`); each group balances within itself and an unattributed year posts exactly the pre-#868 entry. The closing entry posts with `dimensionMirror: true` — a year archived mid-way still closes. Idempotence is the existing `fiscal_year_already_closed` guard + transaction; rollback stays the existing reversal flow (which mirrors attribution).
- `generateCarryForward` groups the prior close by tuple: balance-sheet rows carry their split, one RE line per tuple (identical single line when nothing is attributed), AR/AP/cheque/fixed-asset specials documented in `opening-balances.ts`. Generation is idempotent under 0217's `uq_opening_balance_sets_carry_forward`. Carry-forward sets post as mirrors (`source = 'carry_forward'`); manual opening sets face the policy. `toCarryForwardApiLines` exposes the attribution.
- Proof: `integration/accounting-dimension-operations.integration.test.ts` §2–§3.

### 6. Site/cloud sync (DONE — runtime authority is the cloud; see Axis B above)

1. `accounting_dimension_settings`, `accounting_dimension_values` **and** `accounting_dimension_mappings` are in `MASTER_SYNC_TABLES` + migration 0223's `trg_sync_capture` (the two are one contract, compared verbatim by `master-sync-registry.test.ts`). Order: settings → values → mappings. Backfilled at the zero clock like 0190/0206.
2. The feed is the 0190 per-field HLC master feed — continuous, both directions mechanically, but ownership is declared `accounting_dimension_master: cloud_authoritative / cloud_to_site / authoritative_scope` in `data-ownership.ts` + `replication-catalogue.ts`. A site never becomes a second writable authority for a value a posting names; archive propagates as `is_active=false` (softDeleteColumn), IDs are preserved so a site's attribution columns reference exactly the values the cloud posted.
3. Ledger events need no dimension columns: `accounting.manual_journal.reversed` carries `entryId` and the apply side re-posts a **mirror** of the original entry's lines (`dimensionMirror: true`) — attribution preserved by construction, including over archived values (integration-proven). Runtime authority for `accounting_journals` is the cloud (Axis B) — this is why a reversal mirrors rather than recomputes.
4. Deliberately not on this feed: `payroll_run_allocations` (immutable posted-run snapshot; payroll is cloud-owned) and the `employees` default-dim columns (users bootstrap, `staff_access`).
5. Proof: `integration/accounting-dimension-operations.integration.test.ts` §5 (UUID row identity, `business_id|kind` for settings, per-field clocks excluding `updated_at`).

### 7. Restricted-role RLS tests (DONE)

`integration/accounting-dimensions-rls.integration.test.ts` provisions a NOSUPERUSER/NOBYPASSRLS role via `scripts/create-app-role` and asserts scoped reads/writes on settings and values (4 tests). Fixed-asset RLS coverage deferred until fixtures include `users`/`locations`/`accounts`; the RLS policy (migration 0219) follows the repo's tenant pattern.

### 9. Management-list pagination (DONE)

`listDimensionValues` now accepts `{ limit, offset }` capped at `DIMENSION_VALUE_LIST_MAX_SCAN=5000`; `GET /api/ledger/dimensions` accepts `limit` (≤200 for non-search listings) and `offset`, returning `{ total, offset, limit, truncated }`. Search results keep the hard 50-row cap. Picker capping at 2000 preserved.

### Payroll / trading / settlement allocations (decided and implemented)

- **Payroll**: both (1) per-employee default **and** (2) per-run percentage allocation shipped (the issue's menu didn't force one — a run can override the employee default). Shares are shareBp integers summing to 10000, the split is exact to the Rial, expense legs split per tuple, liability/settlement legs stay unattributed, and the applied split snapshots into `payroll_run_allocations`. Option (3) time sheets remain out of scope. Surfaces: `PATCH /api/ledger/payroll/staff/:id` (`defaultDimensions`) + the payroll screen's member cards; `POST /api/ledger/payroll/runs` (`allocations`) + the accrual panel's per-member share dialog; run details render the snapshot; engine cost-allocation profiles round-trip the tuple per share.
- **Purchase/sale/COGS**: the winning field is *all of them, ranked*: explicit per-line override > mapping rules (item → product category → supplier → sales channel; a kind adopts only when ≥1 speaker agrees and none disagree) > mirror of the source document > unattributed. Returns/credit-notes **mirror** the original posting's tuple (found-but-unattributed stays unattributed); amendments re-post under their own source id. Periodic-period aggregate COGS is unattributed. Surfaces: `/api/ledger/dimensions/mappings` CRUD + the dimensions manager's «انتساب تحلیلی» tab.
- **Receipts/payments**: option (a) — unattributed, unchanged. Settlement allocation (b)/(c) is a separate settlement/ageing change, not #868.

### Status labels for issue #868 (evidence-based)

- **Implemented and tested in-repo**: line-level attribution model; posting guard + mirrors; dimension reports (matrix / profit / cost-centre card / trial-balance filter / rollup reconcile); bulk assign with concurrency guard; closing + carry-forward splits with UI display; payroll employee defaults + per-run allocations (API + UI + run display); trading attribution mappings (API + tab); master sync of the dimension master (registry order settings → values → mappings, `trg_sync_capture`, HLC merge); restricted-role RLS suite.
- **Implemented, packaged verification externally blocked**: Windows packaged `source_ref` baseline/current size comparison and real installed cloud/site sync behavior (ID/archive-state/ownership preservation, replay/conflict/attributed-reversal on an installed system). The exact dispatch blocker (HTTP 403) and the four required workflow commands are recorded in `docs/plans/ISSUE_868_PLAN.md` ("Packaged baseline/current comparison"). Database/feed tests are **not** a substitute and this is not claimed complete.
- **Out of scope (deliberate)**: payroll time sheets (option 3); receipts/payments attribution and settlement/ageing allocation; periodic-COGS attribution; a second ledger anywhere.
- **Not claimed**: production/deployment validation (Coolify access unavailable); no deployment is asserted by this document.

## Dead code inspected

- `next/dist/compiled/amphtml-validator` is Next.js-internal, not imported by our code.
- `unpdf` and `playwright-core` are lazy-imported (`await import(...)`) and externalised in `next.config.ts` + the esbuild desktop builder; required by PDF/printing; not dead.
- No duplicate picker components; `DimensionFields` + `useDimensionSearch` are the single shared entry points.

## Verification for this batch

- `tsc --noEmit` clean; ESLint clean.
- Unit 41/41; design 38/38.
- DB integration 114/114 (fixed-assets 75, dimensions 35, new RLS suite 4).
- Desktop budgets green on prior CI run (staged 193 MiB, installed 613 MiB, installer 160 MiB).

Later batches (post-#967, 2026-10-16): payroll suite 451/451 plus run-source/section 91/91 and new mappings/profiles UI tests 5/5; sync suites 28/28 (`master-sync-registry`, `master-sync-merge`, `data-ownership`, `replication-catalogue`). Packaged Windows comparison and installed-site sync verification remain externally blocked — see the status labels above.
