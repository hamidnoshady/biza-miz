# Issue #868 — repository ownership & decision matrix

This document records which repository owns what data, which side is the ledger authority, which contracts must change together, and which remaining items require explicit product decisions before code can proceed.

## Repositories inspected

The PR works against the monorepo `hamidnoshady/biza-miz`. Other accounting-relevant surfaces:

- `hamidnoshady/biza-cloud` — multi-tenant control plane (provisioning, billing, sync coordination).
- `wordpress-plugin/` (in this repo) — WooCommerce sales connector; writes via the API.
- `electron/` (in this repo) — desktop shell; does not originate or transform accounting data.
- Holoo import adapter (`src/lib/integrations/holoo/`) — posts through in-repo services; producer only.

No separate mobile/sync-worker/reporting repos are referenced from `AGENTS.md`/`CLAUDE.md`; any future consumer must use the public HTTP/JSON contract.

## Ownership (single source of truth)

| Concern | Owner |
| --- | --- |
| Dimension master data (settings, values, hierarchy, archive) | `biza-miz` via `accounting-dimensions-service.ts`. Tables `accounting_dimension_settings`/`accounting_dimension_values`, RLS from migration 0216. |
| Journal postings with dimensions | `biza-miz` via `ledger-service`/`manual-journal-service`/`expense-service`/`fixed-assets-service`. One posting guard: `assertDimensionsPostable`. |
| Branch/project attribution | `journal_entries` (entry-level), never duplicated onto lines. |
| Reports by dimension | `biza-miz` via `accounting-dimension-reports-service.ts` (read-only over `journal_lines`). |
| Desktop packaging | `electron/`; no accounting logic. |

Golden rules:
1. Projects/branches stay canonical and unduplicated.
2. The monorepo is the ledger authority — cloud replicates, never recomputes.
3. `assertDimensionsPostable` is the single-policy gate; every posting path calls it.
4. Forward-only migrations; every new tenant table gets an RLS policy in the same migration.

## Deferred items — required contracts and decisions

### 4. Bulk dimension assignment on unposted drafts (safe mode)

- Service: `assignDimensionsToDrafts(businessId, { draftIds, dimensions, overwrite })` running in one transaction, `FOR UPDATE` locks on `journal_entry_drafts`, refusing approved/posted rows, writing `journal_entry_draft_dimension_audit` rows (draft_id, line_no, actor, before/after, at).
- API: `POST /api/ledger/dimensions/bulk-assign` with `dryRun=true` preview; 409 on concurrent approval race.
- UI: three-step wizard in the journal review queue; disabled on posted/approved entries.
- Decision needed: overwrite semantics for lines already carrying a dimension — (a) fill blanks (default), (b) overwrite all, (c) cancel. No silent overwrite.

### 5. Opening / carry-forward with dimension splits

- Service: `closeFiscalYearWithDimensions(from, to)` reads P&L balances by the complete dimension tuple (including NULLs), posts closing entries against retained earnings split by tuple, posts opening entries for balance-sheet accounts split by tuple. Idempotent via marker; rollback is soft-delete behind an explicit reverse button.
- Migration: `fiscal_year_closings` marker table + `generated_by_closing_id` on `journal_entries`.

### 6. Site/cloud sync

Must land together, in order:
1. Add `accounting_dimension_settings`, `accounting_dimension_values` to `MASTER_SYNC_TABLES` and the trigger list (same migration).
2. Emit outbox events per insert/update/archive (archive propagates as `is_active=false`; no cross-wire deletes).
3. `sync_domain_handlers.ts` idempotent applier; outbound-only for initial rollout (site owns master data).
4. Add four dimension columns to ledger-event payloads (schema already exists on `journal_lines`).
5. Cloud PR mirrors tables and columns; do not create cloud tables in this repo.

### 7. Restricted-role RLS tests (DONE)

`integration/accounting-dimensions-rls.integration.test.ts` provisions a NOSUPERUSER/NOBYPASSRLS role via `scripts/create-app-role` and asserts scoped reads/writes on settings and values (4 tests). Fixed-asset RLS coverage deferred until fixtures include `users`/`locations`/`accounts`; the RLS policy (migration 0219) follows the repo's tenant pattern.

### 9. Management-list pagination (DONE)

`listDimensionValues` now accepts `{ limit, offset }` capped at `DIMENSION_VALUE_LIST_MAX_SCAN=5000`; `GET /api/ledger/dimensions` accepts `limit` (≤200 for non-search listings) and `offset`, returning `{ total, offset, limit, truncated }`. Search results keep the hard 50-row cap. Picker capping at 2000 preserved.

### Payroll / trading / settlement allocations (blocked on product decisions)

- **Payroll** options: (1) per-employee default (recommended first ship), (2) per-run percentage allocation, (3) salary-rule engine tied to time sheets. Until chosen, payroll accruals post «بدون بُعد».
- **Purchase/sale/COGS profit centre**: choose the winning field (product category / sales channel / customer group / per-line override) before adding any posting rule; returns/credit-notes must mirror the chosen rule. Do not add stub columns ahead of the decision.
- **Receipts/payments**: settlement-allocation problem affecting ageing. Options: (a) leave unattributed (current), (b) FIFO split, (c) explicit allocation at payment entry (recommended). Do NOT blindly copy invoice header dimensions.

## Dead code inspected

- `next/dist/compiled/amphtml-validator` is Next.js-internal, not imported by our code.
- `unpdf` and `playwright-core` are lazy-imported (`await import(...)`) and externalised in `next.config.ts` + the esbuild desktop builder; required by PDF/printing; not dead.
- No duplicate picker components; `DimensionFields` + `useDimensionSearch` are the single shared entry points.

## Verification for this batch

- `tsc --noEmit` clean; ESLint clean.
- Unit 41/41; design 38/38.
- DB integration 114/114 (fixed-assets 75, dimensions 35, new RLS suite 4).
- Desktop budgets green on prior CI run (staged 193 MiB, installed 613 MiB, installer 160 MiB).
