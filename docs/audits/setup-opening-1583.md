# Issue #1583 — opening step: accounts, money containers, one opening posting

Status: implemented on `fix/1583-setup-opening` (pending review/merge).
Related: #1239 (parent wizard), #1316 (financial accounts), #867 (formal fiscal opening).

## 1. Why the opening step could show no accounts

Verified against `origin/main` (`17cd61392`):

1. `GET /api/setup/opening` returned a bare account list. The step's client read
   `data.accounts` and never inspected `ok`, so **any** failed read — permission,
   RLS, 5xx, transport — rendered as an empty selector. That is the reported
   symptom, and it is indistinguishable from a real empty chart.
2. The step had no vocabulary for the other real causes:
   - the chart was never created (the `accounts` step is skipped when Accounting
     is not selected, while `opening` remains in the sequence);
   - the chart exists but has no active postable leaf;
   - Accounting is not enabled for the business;
   - the caller lacks the permission.
3. The browser decided postability itself (`children === 0`). The canonical
   contract (`is_postable`, decided over the whole chart) already existed at
   `GET /api/ledger/accounts` but was not used here.
4. The wizard's ledger posting was a second writer: direct
   `INSERT journal_entries/journal_lines`, bypassing `postJournalEntry`
   (voucher numbering, fiscal-lock trigger, line validation), with duplicate
   detection that ignored `opening_balance_sets`.
5. Only code `1300` was excluded from the opening picker; a customized child of
   the inventory control stayed selectable and could double-post stock.

## 2. The contract

`src/lib/setup-opening.ts` (pure, unit-tested):

- `eligibleOpeningAccounts(accounts)` — active, no children (any child, archived
  included), whole `1300` subtree excluded.
- `resolveSetupOpeningState(...)` → `ready | chart_missing | no_eligible_leaf |
  accounting_not_enabled`, with one Persian sentence per state.
- `permission_denied | unavailable | load_failed` are the transport/API states
  the screen maps from HTTP status.

`GET /api/setup/opening` now returns:

- `state`, `message`, `accountingEnabled`, `chartAccountCount`;
- `accounts` (all rows with `isActive`/`hasChildren`/linked money container) and
  `eligibleAccounts` (the postable list, decided on the server);
- `capabilities.canManageChart`, `.canManageFinancialAccounts`,
  `.canViewSensitive`;
- `openingEntry`, `openingSets`, `inventoryItems`, `costingLocked`;
- the active financial accounts (masked identifiers) and per-kind totals;
- locations, base currency and enabled currencies;
- `financialAccountsUnavailable` so a secondary read failure is stated instead
  of shown as “no accounts”.

A thrown read is a 503 carrying `state: "unavailable"`; the page renders the
message and a retry, never an empty select.

## 3. Chart recovery

`POST /api/setup/opening/chart` (explicit «ساخت سرفصل پیشنهادی صنف»):

- requires the wizard gate + `accounts.edit` + Accounting enabled;
- refuses when **any** account row exists (`chart_exists`) — a customized chart
  is never replaced;
- places the canonical industry template through `replaceChartOfAccounts`, in one
  transaction, and verifies the cash/bank/clearing/inventory/opening-equity codes
  actually landed (`REQUIRED_OPENING_CHART_CODES`);
- writes the `accounts` progress marker only in that same transaction.

Inline GL creation uses the existing `POST /api/ledger/accounts` →
`createAccount`; it adds one validated child and never replaces the chart.

## 4. In-wizard money containers

`POST /api/setup/opening/financial-accounts` is a thin wizard door in front of
`createFinancialAccount`:

- requires `finance.accounts_manage` and an enabled Accounting app;
- branch scope from live membership, tenant checks and one-to-one GL linkage stay
  in the canonical service;
- returns the masked record for a caller without the sensitive-field capability.

The sheet reuses `GET /api/ledger/financial-accounts/eligible?kind=` for the GL
candidate list (bank / cash / petty cash / clearing), so a POS terminal can never
be linked to a bank's own GL or share another terminal's clearing GL. Multiple
terminals may settle into the same bank row.

## 5. One opening posting path

`src/lib/setup-opening-posting.ts`:

- posts through `postJournalEntry` with `source_type = 'opening'`, an idempotency
  key and `entry_date = CURRENT_DATE`;
- refuses when an `approved`/`posted` `opening_balance_sets` row exists
  (`opening_set_exists`) — the other half of `assertNoConflictingOpening`, so the
  wizard and the formal set cannot both post;
- refuses non-postable, archived, other-tenant and inventory-control accounts;
- auto-offset uses account `3900` exactly as before;
- the `opening` progress marker commits with the entry.

Opening amounts remain optional; skipping the step still finishes onboarding.

## 6. Tests

- `src/lib/setup-opening.test.ts` — eligibility, inventory subtree, state
  resolution, labels (9 tests).
- `integration/setup-opening.integration.test.ts` — real PostgreSQL:
  - missing chart / Accounting not selected / only-parents / ready;
  - real financial accounts and ledger-derived balances;
  - two POS terminals → one bank, distinct clearing GLs; shared clearing GL
    refused; cross-tenant GL refused;
  - opening posting: exact-Rial balanced entry through `postJournalEntry`
    (voucher number + idempotency key), idempotent retry, inventory-control and
    non-leaf refusal, approved formal set refusal (10 tests).
- `npm run test:design` — design + primitive lint + loading coverage.

## 7. Rollback

No schema migration. Rollback is reverting the branch: the API additions are
backward compatible, no chart is replaced unless it is empty, and no journal row
is rewritten. Existing wizard entries keep their IDs; the only change to a new
entry is that it is now numbered and posted through the canonical engine.

## 8. Not in this change

Industry-specific opening inventory beyond F&B (retail variants, jewelry/watch
serials, automotive vehicles) and the `/setup/import` reconciliation preview are
**not** implemented here. The step keeps the existing truthful pointer to each
trade's catalogue manager and hides the F&B count for other industries; the
remaining acceptance criteria for workstream D are still open.
