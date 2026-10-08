# Issue #832 — Accounting Expenses: full audit fixes — implementation plan

Working branch: `arena/396beb72-biza-miz` (from `main` at `e9d47ae`)

Baseline, verified before the first change:

- `npx tsc --noEmit` → clean
- unit suite (`npm test`) → green, and `integration/expense.integration.test.ts`
  was 14 passing tests against a real Postgres
- The 22 findings were read from the issue body itself, not from a summary; the
  first draft of this plan had three findings mapped to the wrong sections and
  was corrected against the text.

## Phase 1 — the accounting correctness that decides everything else

- [x] §1 reversal/correction model — no hard delete, mirrored journal, register states, GL parity
- [x] §2 payment-account eligibility — one shared cash/bank rule, server-authoritative
- [x] §11 input VAT — `Dr expense (net) / Dr input VAT / Cr payment (gross)`, integer Rial
- [x] §12 `party_id` onto the canonical `parties` table, `vendor` kept as a snapshot
- [x] §21 a human document number per business, `EXP-<jalali-year>-<seq>`

## Phase 2 — the API boundary those rules are enforced at

- [x] §5 one date rule (business timezone, future refused, garbage never a 500) on every channel
- [x] §6 branch/location returned, filterable, ownership-validated, never inferred when reading history
- [x] §9 real keyset pagination (`expense_date DESC, created_at DESC, id DESC`) with totals over the whole filtered set
- [x] §10 `paymentAccountId` exposed as a filter with the same eligibility rule as the write
- [x] §3 permission-aware routes: reads on `ledger.view`, writes on `finance.expenses_manage`
- [x] §20 one submit contract between the button, its comment and the tests

## Phase 3 — the surfaces that must agree with the API

- [x] §3 read-only register for a viewer: no form, no picker, no upload, no OCR, no reversal
- [x] §7 receipt evidence usable after posting (indicator, preview, Media link, explicit «removed»)
- [x] §8 detail drawer with identity, journal, reversal state, source channel and audit metadata
- [x] §22 the same facts on the desktop table and the mobile cards
- [x] §13 the OCR classifies from the tenant's own active expense accounts — no hard-coded F&B codes

## Phase 4 — the neighbouring channels

- [x] §4 import gated by `finance.expenses_manage` (plus the engine's `data.import`), not `ledger.post`
- [x] §16 safer duplicate detection with an explicit create-anyway escape
- [x] §17 one translation table for every service error code the UI can receive
- [x] §15 UI / API / import / AI / autopilot reach the same service rules
- [x] §14 one documented orphan-receipt policy, with the behaviour tested
- [x] §18 recurring expenses: documented as not implemented, and asserted where the schema can prove it
- [x] §19 indexes only where a measured plan needed them

---

# Status — complete

Delivered as draft PR #878 from `arena/396beb72-biza-miz`.

Every finding is implemented, and each has a regression test at the layer where
the bug actually lived. Findings 1–13, 15–17 and 19–22 are code; §14 and §18 are
decisions written down where a reader will hit them, plus the tests that keep the
documented behaviour true.

## What each finding changed

| § | Change | Proven by |
| --- | --- | --- |
| 1 | `reversed_at` / `reversed_by` on the original row, `reverses_expense_id` on a **new positive** row whose journal is the mirror of the original's own lines; `POST /api/ledger/expenses/[id]/reverse`; the register derives `active / reversed / reversal`; `TOTALS_SQL` signs a reversal's contribution so the register nets to the same zero the GL nets to. A partial unique index makes "reverse twice" unrepresentable, and two CHECKs make "reverse a reversal" and "annotate a reversal as reversed" schema errors. | `reverseExpense` (8 integration cases, including a rollback proof and a locked-period proof) + `[id]/route.test.ts` (11) + the register's status labels in `expense-input.test.ts` |
| 2 | `EXPENSE_PAYMENT_SOURCE_ROLES` (cash, bank, petty cash, card clearing) resolved **through the account's ancestors**, in one function (`expensePaymentSourceIds`) that the write path, the filter, the picker and the importer all call. Revenue, AR, inventory, recoverable VAT and platform-receivable accounts are refused even though some of them are assets. | `expense-accounts.test.ts` (12), `recordExpense` rejection cases, `expense-section.test.tsx`'s picker test, integration "credits cash, petty cash and card settlement — and nothing else that is an asset" |
| 3 | Reads need `ledger.view`, writes need `finance.expenses_manage`; the UI receives `canManageExpenses` and hides the whole form — including the receipt upload and the OCR button — rather than disabling it, and a member whose permission set failed to load is *not* treated as a denial. | `expense-section.test.tsx` (read-only + writable pairs), `api/ledger/expenses/route.test.ts` (guard names) |
| 4 | `ACCOUNTING_EXPENSES.importPermission` moved from `ledger.post` to `finance.expenses_manage`, so the importer is not a second, wider door to the same act. | `registry.test.ts` → "asks the owning app for permission to import, not a neighbouring right" (27 total) |
| 5 | `businessToday(businessId)` → `todayIsoDate(businesses.timezone)` is the only clock any expense date rule reads; garbage dates are `invalid_expense_date` (400), not a Postgres cast failure; the floor is `MIN_EXPENSE_ISO_DATE`. **Added on the reviewed head:** the *amount* rule of the same section, which the boundary had been breaking — `POST` wrote `Math.trunc(Number(body.amount))`, so a fraction was shortened before any rule saw it and a JSON `true` became one rial. `parseExpenseAmount` is now the single reader (whole Rial, `isWholeRial`'s tolerance for a Toman figure's float residue, digits-only strings), `validation.integral` refuses a fractional cell in the importer, and the form says the rule instead of «بیش از حد بزرگ است». | `expense-input.test.ts` (28), integration future-date + default-date cases, "rejects an impossible expense date instead of letting Postgres 500" |
| 6 | `locationId` is accepted, validated against the tenant's own `locations`, returned with `locationName`, filterable, and **never** defaulted to the caller's active branch when the register is being read. | integration branch cases (filter, label, foreign-branch refusal), `api/ledger/expenses/route.test.ts` (explicit `locationId` wins over the active-branch default) |
| 7 | The receipt is a canonical Media asset, linked by `receipt_asset_id`; the register shows «دارد / پیوست‌شده» from the row itself, «حذف شده» from the `receipt_file_name` snapshot 0177's `ON DELETE SET NULL` cannot clear, and the drawer previews the image through `/api/media/[id]/file` under `media.view`. | `expense-section.test.tsx` (upload → link → indicator), integration receipt cases, `ai-receipt.test.ts` (20) |
| 8 | `expense-detail-panel.tsx` — identity, party, branch, payment account, VAT, journal lines, reversal state and both directions of the link, source channel, who/when, and the reversal action for a writer — in the drawer pattern the Accounting app already uses. | component tests for the register rows the drawer opens; `[id]/route.test.ts` for `{expense, journalLines}` |
| 9 | Keyset cursor `{date}|{created_at}|{id}`, `LIMIT n+1` probe for `hasMore`, totals computed **before** the cursor predicate over the whole filtered set, and the client ignores a response for a request that is no longer current. | `expense-input.test.ts` cursor round-trip (which found the `+00` bug), `api/ledger/expenses/route.test.ts` `nextCursor` round-trip (which found the object-vs-string bug), integration "pages a keyset that does not shift when a row is posted mid-read" |
| 10 | `paymentAccountId` is a list filter validated by the same eligibility function. | `api/ledger/expenses/route.test.ts` filter-forwarding, `expense-input.test.ts` |
| 11 | VAT is part of the gross (`net = round(gross / (1 + rate/100))`, `vat = gross − net`), posted as a third line on the tenant's own input-VAT account, integer Rial throughout, `vat_account_missing` when the chart has no such account, and a CHECK keeps `vat_amount ≤ amount` in the database as well as in the service. | integration "posts input VAT … as three lines", "refuses VAT when the chart has no input-VAT account", "reverses input VAT on the very account it was charged to" |
| 12 | `party_id` → `parties` (`ON DELETE SET NULL`); `vendor` stays the free-text snapshot the accountant typed, so the expense outlives a rename or a deletion; a foreign party is `party_not_found`, not a silent unlink. | integration "links a party without depending on it, keeping the typed vendor" |
| 13 | The OCR prompt is built from `listExpenseCategoryAccounts` (this tenant's active expense accounts, code-sorted, capped) and the reply's code is intersected with that list; out-of-vocabulary means **no** auto-selected category, and the server re-validates everything the model proposed. | `ai-receipt.test.ts`, `ai-receipt-service.test.ts` (6), `api/ai/receipt-ocr/route.test.ts` (10), integration "exposes the tenant's expense accounts as the AI's only vocabulary, with no fallback list" |
| 14 | One policy, written into `ai-receipt.ts`'s header: OCR uploads are stored in the canonical Media Library immediately, deduplicated by SHA-256 per business, and **kept** if the operator never posts the expense. There is no temp bucket, no sweeper and no orphan deletion; `scripts/media-reconcile-orphans.mjs`'s "keep, report" stance is the same one. | `ai-receipt.test.ts` (dedup, no-prune) + the receipt-linkage integration cases |
| 15 | Every channel calls `recordExpense` / `reverseExpense` / `parseExpenseListQuery`; the importer and the AI pass the same fields through the same validators, so no surface has its own arithmetic. **Added:** the assistant's two writing actions choose their branch through `branch-service.resolveBranchRef` — an id or the exact name of one of *this* business's active branches, refused when unknown or ambiguous — instead of a private copy of «oldest active branch», and a chart with no 2100 reaches the model as `ledger_account_missing`, the route's own answer. | `ai-autopilot.integration.test.ts` (5 new cases against a real ledger), `branch-management.integration.test.ts` (4 resolution cases), `ai-service.test.ts` + `api/ai/chat/route.test.ts` (24), `expense-import.test.ts` (16), `api/ledger/expenses/route.test.ts` (21) |
| 16 | Two duplicate rules (strict default: date + amount + account + payment account + settlement + supplier + party text + memo; loose opt-in), `COALESCE` on nullable text so a blank cell does not hide a duplicate, and `duplicateStrategy: "create"` as an explicit, per-file escape. **Added:** the *import* channel reached parity with the register — VAT, party, settlement, supplier and due date are carried, resolved through the tenant's own directories (`listSupplierDirectory`, `searchParties`) and forwarded to `recordExpense`; a payment account is required only of a paid row; the settlement is read by `parseExpenseSettlement` so no default is invented for a cell that cannot be represented; and anything the channel cannot express is refused with its own reason rather than dropped. | `expense-import.test.ts` (16, including the placeholder/alias locks) and `integration/expense-import-adapter.integration.test.ts` (14, against a real Postgres) |
| 17 | `EXPENSE_ERROR_MESSAGES` / `EXPENSE_UI_ERROR_MESSAGES` / `expenseErrorStatus` are the only place an expense error code becomes text or an HTTP status; an unmapped code is a 400 with the code visible, never a 500 or a Persian sentence invented at the call site. | `expense-errors.test.ts` (12: every thrown code has a message, a 4xx, and a UI sentence) |
| 18 | **Not implemented, and the documentation no longer claims otherwise.** README said expense management ships "attachments and recurring expenses" and that manual journals have "recurring templates"; `information_schema` has no `recurring*` table and `expenses` has no cadence column. The README now says what exists and where the deferral is recorded; `docs/phases/Phase-16-Accounting-Suite.md` already carried the deferral in its decisions 14 and 16. | integration "recurring expenses remain unimplemented" asserts the absence it documents |
| 19 | Four register indexes (`(business_id, expense_date DESC, created_at DESC, id DESC)`, plus branch, category and payment-source variants) and a partial index on `party_id`, each justified by a measured plan rather than by habit: 200 000 expenses across 4 tenants and 2 branches, `EXPLAIN (ANALYZE, BUFFERS)`, before/after. `reference` and the two reversal links got unique/lookup indexes because they are uniqueness and join guarantees, not performance guesses. | `scripts/bench-expense-queries.mjs` (the numbers are quoted in the migration's own comment); verdict: all four register indexes JUSTIFIED — Sort removed and 12–27 ms → index scans with ~101–150 blocks touched |
| 20 | `disabled={busy}` only. The comment claiming the button "stays enabled to explain why" was the lie: it was disabled on an invalid form and silently swallowed the click. Now validation advice renders under the button as the reason, the button is enabled whenever a click can do something, and the comment describes that. | `expense-section.test.tsx` (invalid → advice visible, no POST; valid → one POST) |
| 21 | `expenses.reference` = `EXP-<jalali year of the expense date>-<0000n>` from `expense_reference_counters`, bumped inside the posting transaction so a rollback leaves no gap and two concurrent postings cannot share a number; unique per business; the register and the drawer print it, and no screen shows a bare UUID as the identity of a document. | integration "numbers each business's own documents, in its Jalali year, without gaps" (including per-tenant counters and cross-tenant invisibility), `expense-section.test.tsx` row assertion |
| 22 | The desktop table and the mobile cards carry the same facts — reference, date, branch (when the business has branches), category, memo, party, payment account, receipt indicator, status, amount, VAT, recorder, details action — and the same filters, totals, load-more control and read-only state. | `expense-section.test.tsx` asserts the register row's account cell **twice** (desktop `<td>` and mobile `<h3>`), which is the parity check; the read-only case runs against the shared register |

## Follow-up on the reviewed head `9356f62`

The review of this PR confirmed two bugs and one unfinished clause. All three are
now closed, and the reversal, register, permission and OCR work above was left as
it stood.

**1. The importer's duplicate lookup referenced a table alias that did not exist.**
`expenseDuplicatePredicate` emitted `e.expense_date`, `e.amount`, … while the
adapter's query is `SELECT id FROM expenses WHERE business_id = $1 AND ${sql}` —
no `e` anywhere. Every expense import row failed with `missing FROM-clause entry
for table "e"`. The columns are unqualified now, because the *caller* owns the
`FROM` clause and a fragment may not assume an alias it was never given.

The part worth writing down: `expense-import.test.ts` was green throughout, because
its assertion (`toMatch(/^e\.[a-z_]+$/)`) had been read off the same buggy code.
A shape test can only pin a shape. Three locks came out of that: no `.` may appear
in a predicate, placeholders are numbered contiguously from the caller's first and
one per bound value, and — the one that actually catches this class — a new
integration file runs the complete adapter against Postgres.

`COALESCE(supplier_id, '')` was a second, quieter bug on the way: comparing a
nullable `uuid` against text is a type error, so nullable id columns carry
`columnCast: "::text"` and the cast is stripped from the *placeholder* side.

**2. `POST /api/ledger/expenses` truncated the amount before validating it.**
`Math.trunc(Number(body.amount))` shortened ۱٬۵۰/۷۵ ریال to a posting of ۱٬۵۰۰ and
read `true` as one rial: the boundary that takes a person's money figure changed it
before any rule looked. The route now forwards `parseExpenseAmount(body.amount) ??
NaN`, so the one amount rule refuses in words what the boundary used to repair in
silence; `Number.isSafeInteger` plus `isWholeRial`'s 1e-6 tolerance is what makes
«۱۵/۷ تومان» accepted (it *is* 1507 rial) while a real fraction is not; the
importer refuses a fractional money cell through `validation.integral`, and the
form's own message states the rule.

**3. Import parity.** Documented in the §16 row above, with the one asymmetry
worth knowing before anyone touches `validateSheet`: the engine's in-file duplicate
rule signs a row only when *every* field of the rule is filled, and an expense row
always leaves one empty (a paid row has no supplier, an owed row no payment
account), so a repeat inside one file is caught by the database-side lookup during
the run and named in the row report — never silently skipped, and never guessed at
in the preview.

`src/lib/ledger-expenses-queries.ts`, listed in the issue as a duplicate query
builder to delete, does not exist in the merged tree: main's copy was superseded by
`expense-service.ts` during the merge, so there was nothing left to remove (verified
by `git ls-tree`, not by the file list).

## Decisions worth reading before reviewing

**A reversal is a positive row, not a negative one.** `amount` stays the number of
Rial that left the payment account; the sign is carried by the journal lines (the
mirror) and by `TOTALS_SQL`, which subtracts any row whose
`reverses_expense_id` is set. A negative row would make the register a place where
a correction is only a strange minus sign, and it would fight the CHECKs and every
report that reads `expenses.amount` as "spent". The invariant the issue asked for —
*the Expenses total matches GL semantics after reversal* — is the one under test.

**Reversal is gated by `finance.expenses_manage`, not `ledger.approve`.** The issue
suggests the approval right. An approval right answers "may this posting stand?"; a
reversal here is the same authoring act as a recording, in the same transaction,
and the tenant's approvers are not necessarily its bookkeepers. The route's doc
comment says so and the route test asserts the guard name, so if the product later
decides a reversal is an approval-level act there is one place to change.

**`reference` stays nullable.** Migration 0211 cannot backfill it: RLS is enforced
on `expenses`, and a migration has no `app.rls_bypass`, so a single UPDATE would
either see no rows or need a superuser escape hatch. Rows written before 0211 print
«—» in the register and keep printing the journal entry's own reference; every new
expense gets a number.

**An unread permission set is not a denial.** `canManageExpenses` is optional in
the section's props and defaults to writable, because the manager reads it from the
same session payload as everything else; a fetch that failed should not turn the
accounting screen into a read-only one. The *routes* are still the authority.

**`migrations/0030_expense_management.sql` was left exactly as it is,** including
its now-half-stale note that "attachments and recurring expenses are deferred".
`scripts/migrate.ts` verifies each applied file's checksum (its own header
documents how painful the last two checksum corrections were, and that a file is
frozen once adopted), so editing a comment in 0030 would break every existing
deployment for a wording improvement. The accurate place for that sentence is the
migration that changed the truth — 0211 — plus README and this file.

**No vocabulary means no guess.** If the tenant chart cannot be read, the OCR
proceeds with `expenseAccounts: []`, which suppresses the auto-selected category
rather than falling back to the old hard-coded food-and-beverage codes. A degrade
path that invents a category is worse than one that asks a human.

## The two red gates on the first CI run

`test.yml` ran on `558f60d`: nine jobs green (including `production build`, which
this sandbox cannot run), two red. One was a real bug in this branch, one was the
gate doing its job.

**integration tests (real database) — a genuine miss, now fixed.**
`party-merge-coverage.integration.test.ts › classifies every foreign key that
points at parties` failed. Finding 12 added `expenses.party_id → parties(id)`, and
that file compares PostgreSQL's own FK metadata against
`src/lib/party-merge-references.ts`: every column pointing at a party must carry a
merge disposition, because merging is irreversible and an unclassified reference is
exactly how a WooCommerce mapping once survived a merge pointing at an archived
customer. The registry had no opinion about expenses, so the sweep refused the
run. The new entry says **`move`** — «به این طرف حساب چقدر پرداختیم» is a live
ledger question, and leaving the link on the archived loser would answer it with a
number missing every payment the loser had — while the audit side of §12 stays
untouched: the `vendor` snapshot and the posted journal are what make an expense
independent of the directory, and neither is rewritten by a merge. The behavioural
half lives in this feature's own file
(`follows a party merge, because a merge is not a deletion`), because the coverage
sweep only seeds references it can populate generically and an expense row needs a
chart of accounts.

**visual regression — an intended pixel change awaiting a human approval.**
`docs/design/visual/accounting-expenses.png` is the committed baseline for
`/accounting/expenses`, and the register's markup is precisely what this issue
asked to change: a document-number column, the branch column, the receipt
indicator, the reversal status badge, the VAT line under the amount, the
server-side totals footer, and no form at all for a viewer. The workflow is
explicit that «a changed snapshot is reviewed as a visual diff and re-recorded
deliberately, never auto-accepted to make a red run go green», so the re-record is
a human action and not something to do from here:

    gh workflow run test.yml --ref arena/396beb72-biza-miz -f record_baselines=true

That uploads `visual-baselines` as an artifact (CI never commits images); the
reviewed PNG then lands in an ordinary commit. Only `accounting-expenses.png`
should differ — a diff on any other screen would mean this branch touched a surface
it had no business touching.

Both diagnostics came from re-running the suites here against a real Postgres, not
from CI: the runner logs live on hosts this sandbox cannot reach, and the Arena
GitHub App token is refused (`403`) on `workflow_dispatch`, so the recording has to
be started by someone with rights on the repository.

## Files

Schema `migrations/0211_expense_reversal_and_register.sql` ·
service `src/lib/expense-service.ts` · shared rules
`src/lib/expense-input.ts`, `expense-accounts.ts`, `expense-errors.ts`,
`expense-import.ts`, `account-classification.ts` · API
`src/app/api/ledger/expenses/{route.ts,[id]/route.ts,[id]/reverse/route.ts}` ·
UI `src/app/(app)/accounting/{expense-section.tsx,expense-detail-panel.tsx,expense-shared.ts}` ·
AI `src/lib/ai-receipt{,-service}.ts`, `ai-service.ts`, `ai.ts`,
`ai-autopilot{,-executors}.ts`, `api/ai/receipt-ocr/route.ts` ·
import `src/lib/data-transfer/{registry.ts,entities/accounting.ts}` ·
docs `README.md`, `docs/authorization/RECONCILIATION.md`

## Gates

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean, 0 diagnostics |
| `npm run lint` (`eslint . --max-warnings=0`) | clean, 0 problems |
| unit suite (`npm test`) | **628 files / 8048 tests passed**, 0 failed |
| `integration/expense.integration.test.ts` (real Postgres, `vitest.db.config.ts`) | **35 passed** — 14 pre-existing, 21 new for #832 |
| `integration/party-merge-coverage.integration.test.ts` | **5 passed** (was the red gate — see below) |
| `npm run test:design` | 38 passed (design lint, primitive lint, loading coverage, reference screenshots) |
| `npm run db:migrate` on a fresh cluster | 292 migrations applied, including 0211 |
| `npm run build` | **not runnable here** — see below. **Passed on CI** (`production build`, 5m26s) |

`next build` needs the repository's documented 3 GB Node heap (`CLAUDE.md`), and
this workspace is a 3.85 GB / 2-CPU sandbox with no swap: the compile phase was
OOM-killed by the kernel at `--max-old-space-size` 3072, 2560 and 2048 (exit 137,
and at the V8 default it dies inside the heap instead). Nothing in the log is a
project error — it never reached a module. The gate itself is owned by CI
(`verify-shippables.yml`), and the parts of a build a mistake in this diff could
break are covered by the two compile-level gates above plus the app-tree tests in
the unit run (module reachability, API guard contract, design/primitive lint).

## Merging audit F11 (main) into this branch

`origin/main` reached `b1dedc2` with five commits, one of them #879 — the accounting repair whose non-payroll half is audit finding **F11**: an expense may be *owed* rather than paid («پرداخت بعدی»), carrying a supplier and an optional due date, and crediting Accounts Payable (2100) instead of a till. It rewrote the same seven files this branch rewrote, so the merge was done file by file with both implementations read first. Neither side's behaviour was given up:

| File | What main wanted | What this branch wanted | The merged shape |
| --- | --- | --- | --- |
| `src/lib/expense-service.ts` | the settlement triple on the row, A/P as the credited account, an owed total | the payment-source rule, reversal, input VAT, keyset paging, server totals | one `recordExpense` that parses the **settlement first**, because it decides which account rules apply at all: `unknown_account`, `same_account` and payment-source eligibility are a paid expense's rules, an owed one needs a supplier and resolves 2100 through `accountIdsByCode` inside the transaction. `listExpenses` returns `totalPaidAmount` (cash that moved, credit excluded) beside `totalOwedAmount`. A reversal copies the settlement triple, so the mirrored debit still lands on the same supplier. |
| `src/app/api/ledger/expenses/route.ts` (+ its test) | forward `settlement`/`supplierId`/`dueDate`, 409 `ledger_account_missing` when 2100 is absent | forward the receipt/party/VAT/location fields, the cursor, the totals | both, and all three tests — main's two F11 cases plus this branch's assertion that `totalAmount`/`totalPaidAmount`/`totalOwedAmount` are carried, not folded into one another. |
| `src/app/api/ledger/accounts/route.ts` | `has_children`, `is_postable` | `parent_id` (§8) | one `SELECT`, three columns, rows returned raw so both clients keep reading what they already read. |
| `accounting-manager.tsx` | the two new fields on `AccountRow` | the permission props `ExpenseSection` now takes | both field groups on the type, this branch's call site. |
| `expense-section.tsx` | settlement chips, lazy supplier directory, conditional fields, owed total | permission-aware form, pagination, receipt OCR, VAT, branch/location, server totals | this branch's structure with F11 inside it. `expenseSettlementText` in `expense-shared.ts` is now the only place that answers «پرداخت از» for a row — desktop table, mobile cards and detail drawer all call it, so an owed row cannot be described three ways. |
| `README.md` | the `ledger.approve`/`ledger.propose` manual-journal bullet | the «no recurring expense» bullets | main's bullet verbatim; this branch's bullet extended with the A/P clause. Both remain true: recurring journal templates are still not implemented, and neither is posting an expense «پرداخت بعدی» on a schedule. |

Four consequences of reading both sides, rather than picking one:

- **The due-date rule moved into the service.** The form refused a due date earlier than the expense date; `recordExpense` did not, which is exactly the §5 shape — a rule only the browser knows. It now throws `due_date_before_expense_date`, and the settlement parser (`parseExpenseSettlement`) is what checks the *shape* of the date, so the importer and the assistant inherit both.
- **Five codes joined the central map** (§17): `invalid_settlement`, `supplier_required`, `supplier_not_found` (404), `invalid_due_date`, `due_date_before_expense_date`. `PayablesInputError` is converted to `ExpenseError` at the service boundary, so every channel translates one error type through one table.
- **The assistant stopped demanding a payment account for an owed expense.** `expense.categorize` required `paymentAccountId` unconditionally, which after F11 is not a rule but a bug: it refused the one payload the register now encourages. It reads the settlement through the same parser, requires the account only for a paid expense, and its `payloadHint` in `ai.ts` says so.
- **`chartIncomplete` narrowed to «no expense account at all».** A business with no till can still record what it owes, so the paid half of the form closes with its reason beside the disabled control instead of replacing the form. This deliberately changed one §2 expectation in `expense-section.test.tsx` — the old assertion (whole form replaced by a chart warning) is now the behaviour of the missing *expense* account only, which the file asserts separately.

Not merged: the import channel still cannot produce an owed expense, because `accounting.expenses` has no supplier column to map. That is documented in `expense-import.ts` as a registry change rather than wired halfway — a sheet that could not name who is owed would have to guess, and guessing is what this issue was about.
