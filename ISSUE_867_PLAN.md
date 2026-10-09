# Issue #867 — Opening balances and formal voucher numbering — implementation plan

Working branch: `arena/f69175ba-biza-miz` (from `main` at `7b1b11c`)

Baseline, verified before the first change:

- `npx tsc --noEmit` → clean (needs `NODE_OPTIONS=--max-old-space-size=3072`; the default heap aborts)
- unit suite (`npx vitest run`) → 698 files, 9175 tests green
- DB suite (`npm run test:db`) → 85 tests, 4 files green

Non-overlap: #820 (trial-balance semantics), #821 (journal hardening), #823 (manual-journal
hardening) and #834 (fiscal-period lifecycle) are not modified. This work uses their primitives:
`postExactJournalEntry`, `fiscal_periods` locks, `closeFiscalYear`, and the manual-journal
reversal helper.

## Scope decision for this slice

| Part of the issue | In this slice | Notes |
| --- | --- | --- |
| Voucher numbering, identity, renumber, reference, gap report, register, audit | **Yes** | DB trigger, services, routes, tests |
| Opening balance sets: draft, lines, submit, approve, post, reverse | **Yes** | services, routes, tests |
| Carry-forward generation, prior-close comparison, party attribution | **Yes** | services, routes, tests |
| Opening-balance **workspace UI** outside the setup wizard | **Deferred** | No screen is built here. The API is the contract a screen will use. |
| Voucher register / gap / opening report **screens** | **Deferred** | Read endpoints exist; no screens |
| PDF / print / export of vouchers and opening reports | **Deferred** | Not built |
| Summary (aggregate) voucher with source links and cutoff | **Deferred** | Not built. No summary-voucher table exists yet, so nothing is double-counted. |

Because the UI and print are not in this slice, the Definition of Done is only partly met. The
next slice must add the screens and the `/accounting/{section}` workspace route through
`ACCOUNTING_WORKSPACE_HREFS`.

## Phase 1 — schema: one voucher identity, and opening sets that cannot drift

- [x] `accounting_voucher_sequences` per business and Jalali year, with a unique sequence
- [x] `assign_journal_voucher_identity` BEFORE INSERT trigger: every journal entry gets
      `voucher_year`, `voucher_number` and `voucher_no` (`JV-YYYY-NNNNNN`)
- [x] `guard_journal_voucher_identity` BEFORE UPDATE trigger: identity changes need the
      `app.voucher_identity_change` GUC, are refused in a locked period, and a date move that
      changes the Jalali year is refused
- [x] `journal_voucher_audit`: append-only (UPDATE and DELETE refused, including by cascade), with
      no FK to `journal_entries`, so the trail outlives the document
- [x] `opening_balance_sets` (kind `opening` | `carry_forward`; status draft → in_review →
      approved → posted → reversed), with partial unique indexes for one posted set per year and
      one carry-forward per year, plus an idempotency key
- [x] `opening_balance_lines` with provenance, `customer_id` → `parties`, `supplier_id` →
      `suppliers`, and links to the journal lines (posted and reversal)
- [x] RLS `tenant_isolation` on all four new tables, in the same migration
- [x] Migration 0216 is unmerged, so it was edited in place. The CHECK on posted sets now allows
      a carry-forward with no journal entry, and only `opening` sets may own one.
- [x] Jalali year in SQL (`app_jalali_year`) matches `src/lib/jalali.ts` for every day 2024–2030
      (integration test, 0 mismatches)

## Phase 2 — the services that own the rules

- [x] `src/lib/vouchers.ts`: pure identity rules (format, reference, reason, renumber target)
- [x] `src/lib/opening-balances.ts`: pure rules (line validation, balance totals, provenance,
      transitions, reconciliation to prior close)
- [x] `src/lib/voucher-service.ts`: register, gap report (capped at 500), renumber (sequence and
      entry locked `FOR UPDATE`, audited), reference (audited), audit trail
- [x] `src/lib/opening-balance-service.ts`: create, replace lines, submit, reject, approve
      (maker-checker), post, reverse, delete draft, list, get, carry-forward, prior-close comparison
- [x] `src/lib/ar-service.ts`: the customer-balance listing now joins `opening_balance_lines`, so
      carried or opening customer attribution is not lost from the directory (found by the
      integration test)
- [x] `src/lib/ap-attribution.ts`: the supplier attribution SQL includes opening lines

### Carry-forward design (decided, and tested)

The ledger is continuous across the fiscal year end. `closeFiscalYear` rolls only revenue and
expense into retained earnings, and balance-sheet balances stay in their accounts. So a
carry-forward **is not posted as journal entries**. Posting the carried balances again would
double them. A carry-forward is generated from the closed prior year, reviewed, approved, and
then posted as an accepted, reconciled opening register with no journal lines. Its lines keep the
party attribution.

- Revenue and expense (4xxx, 5xxx and the like) are never carried.
- Reconciliation to the prior close is exact. There is no plug line. Edits that break it are
  caught at submit, at approve, and at post.
- An unattributed A/R or A/P balance blocks approval until someone assigns a party.
- A carry-forward cannot be reversed (`carry_forward_not_reversible`). Correct it by generating
  a new proposal after the prior close has been reviewed.
- A first `opening` set is refused when balance-sheet journal activity already exists before its
  effective date (`opening_would_duplicate_ledger`), because posting it would double those balances.
- A posted `opening` set can be reversed only while no later entry depends on it. The reversal
  is dated the original effective date (`opening_has_dependent_postings` otherwise).

## Phase 3 — the routes, with the repo's guards

- [x] `ledger/opening-balances` (GET list, POST create), `[id]` (GET, DELETE draft), `[id]/lines`
      (PUT), `[id]/submit`, `[id]/reject`, `[id]/approve`, `[id]/post`, `[id]/reverse`,
      `carry-forward` (GET comparison, POST generate)
- [x] `ledger/vouchers` (GET register), `gaps`, `[id]` (GET audit), `[id]/renumber`,
      `[id]/reference`
- [x] Opening sets: read `ledger.view`; propose (create, edit lines, submit, generate
      carry-forward) `ledger.propose`; approve, reject and reverse `ledger.approve`; post
      `ledger.post`.
- [x] Vouchers: register, gaps and audit `ledger.view`; reference `ledger.post`.
- [x] Renumber uses **`ledger.close_period`**, the critical, reason-required, audited accounting
      authority, rather than a role check. This slice adds no new permission. Renumbering is
      privileged and audited.
- [x] `src/lib/accounting-http.ts`: one mapping from a deliberate refusal to its status (409 for
      state conflicts, 400 for bad input). Unexpected errors are rethrown, never shown as 4xx.
- [x] `api-guards.test.ts` and `authorization-contract.test.ts` pass with the new routes.

## Phase 4 — proof

- [x] `src/lib/vouchers.test.ts` (10), `src/lib/opening-balances.test.ts` (13)
- [x] `src/lib/voucher-service.test.ts`, `src/lib/opening-balance-service.test.ts` (input refusals
      that need no database)
- [x] `src/lib/accounting-http.test.ts` (error mapping)
- [x] `integration/accounting-vouchers-opening-balances.integration.test.ts` (17 tests, real
      Postgres): numbering per year and Jalali mapping, rollback leaves no gap, plain-SQL
      protection, renumber into a gap with audit and out-of-range refusal, locked-period refusal,
      reference uniqueness, Jalali year-move refusal, SQL/TS calendar agreement, opening
      create/idempotency, revenue refusal, unbalanced refusal, maker-checker, exact posting and
      post-lock edits, dependent-posting-blocked reversal, one posted per year, cross-tenant
      isolation, carry-forward gating on the prior close, the full carry-forward (party
      attribution, no revenue or expense, reconciliation, idempotent generation, approval, no
      duplicate ledger entry), and the duplicate-ledger guard.
- [x] `src/lib/ledger-source-labels.ts`: Persian labels for `opening_balance` and
      `opening_balance_reversal`

## Status

Backend slice complete: schema, pure rules, services, routes, and tests. UI, print/PDF/export,
and summary vouchers are deferred and listed above. The integration test found two real defects
that unit tests did not, and both are fixed:

1. Carry-forward posted the balance sheet again, which doubled every balance. The ledger is
   continuous, so a carry-forward is now an accepted register with no journal lines.
2. The customer directory's A/R listing ignored opening attribution, so a customer's opening
   balance vanished from the list while `getCustomerArBalance` still showed it.

### Verification on this branch

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` (heap 3 GB) | clean |
| `npx vitest run` | 9223 tests passed (baseline 9175; the new unit tests account for the difference) |
| `npm run test:db` | 198 files, 2713 tests passed, 1 skipped (includes the 17 new integration tests) |
| `npm run build` | **not verified here.** The sandbox has about 3.9 GB RAM and no swap, and the Next.js build is OOM-killed at both the default and a 3 GB heap. Run it in CI or on a larger machine before merge. |
| `npm run test:design` | not run. This slice touches no UI screen. |

### Defects found by the integration tests and fixed

- Carry-forward posted the balance sheet again (double balances). Fixed by making a carry-forward a
  reconciled register with no journal lines (see the design above).
- The customer A/R directory dropped opening attribution. Fixed in `arLines`.
- The party-merge coverage check required a disposition for `opening_balance_lines.customer_id`.
  Set to `move`, because the opening receivable belongs to the customer.
