# Issue #867 — Plan: Opening Balances, Fiscal Carry-Forward & Formal Voucher Numbering

## Goal (from the issue)

Turn the setup-time opening journal into an accountant-facing fiscal opening /
carry-forward / voucher-control workspace, and give every accounting document a
stable, fiscal-year-scoped voucher number — without touching the semantics of
#820 (trial balance), #821 (journal hardening), #823 (manual journal) or #834
(fiscal periods/locking). Those hardened primitives are *used*, never modified:
`postJournalEntry` / `postExactJournalEntry` stay the one posting path, the
migration-0024 period-lock trigger keeps enforcing locks, and `journal_entries`
remains the only ledger truth.

## Design decisions

### One posting truth, numbers as metadata
- Voucher numbers are **metadata on `journal_entries`** (new columns
  `voucher_number`, `voucher_sequence_no`, `voucher_reference`,
  `voucher_assigned_by/at`). No new document table stands in for a journal
  entry; a "summary voucher" is an aggregation *document that references*
  entries, never a second entry.
- Numbering happens **inside the existing posting transaction**:
  `postJournalEntry` / `postExactJournalEntry` allocate the number for the
  entry they insert (fiscal year = the Jalali year of `entry_date`, resolved to
  the defined `fiscal_years` row when one exists). A posting that cannot be
  numbered rolls back — a document without a number does not exist.
- Pre-existing entries (predating this migration) are numbered by an
  **idempotent backfill** run from the voucher register route (and a script),
  in `(entry_date, posted_at, id)` order — the order a real journal was kept in.

### Sequence model (Scope B)
- `voucher_sequences` — one row per `(business, fiscal_year_label, document_type)`;
  `last_number` advanced under `FOR UPDATE`.
- Document types (a closed catalogue in `voucher-numbering.ts`):
  `journal` (all auto-posted operational entries), `manual`, `opening`,
  `summary`. The type is derived from `journal_entries.source_type` by a rule
  (`source_type` is the entry's own fact, so a reversal of a manual entry stays
  `manual`, an opening carry-forward posting stays `opening`, …).
- Printable number: `<PREFIX>-<fiscalYear>-<6-digit sequence>` (RJ / MJ / OP /
  SV), e.g. `MJ-1404-000012`. Parsing it back answers "which book, which year,
  which sequence" without a table lookup.
- Optional accountant-supplied **reference number** (e.g. the old system's
  voucher number) is stored on `voucher_reference` — it never participates in
  the sequence.
- **Renumbering** is a service operation (permission `ledger.approve`, mandatory
  reason, writes `voucher_renumber_log`) and is also guarded at the database:
  a trigger on `journal_entries` refuses direct updates of the voucher columns
  unless the service set a transaction-local flag in the same transaction that
  writes the audit row.

### Opening balances (Scope A)
- `opening_balance_sets` + `opening_balance_lines` — a draft/review/approve/
  posted/reversed workspace. The set carries the fiscal-year identity
  (`fiscal_year_label` + optional `fiscal_year_id`), the effective opening
  date, source (`manual` | `carry_forward`), and the `journal_entry_id` it
  produced when posted.
- Lines are GL lines (account + debit XOR credit) with optional **party
  attribution** (`party_type`: customer / supplier / cheque / fixed_asset /
  inventory, `party_id`, `reference` — a cheque serial/Sayad, an asset id, …)
  — that is what "source drill-down" and "attribution survives carry-forward"
  read from.
- Lifecycle: `draft → review → approved → posted`, plus `reversed`.
  - updates only in `draft`/`review`;
  - `approved` requires the set to balance exactly (and, for carry-forward, to
    reconcile to the prior close — see below);
  - `posted` calls the *existing* `postJournalEntry` (source_type `opening`,
    source_id = set id, entry_date = effective date), so the period-lock
    trigger, RLS and every downstream report apply with no special case;
  - `reversed` posts a mirror entry through `postExactMirrorEntry` — but only
    when **no dependent postings exist** (any other entry dated after the
    effective date). Otherwise it is refused: after dependent postings exist
    there is no destructive rewrite, the books are corrected forward.
- One posted opening set per fiscal year (partial unique index), and approval
  refuses when the ledger already holds another opening posting for that year.

### Carry-forward
- `generateCarryForwardProposal(fromYear → toYear)`:
  - requires the prior year to be fully transitioned (all twelve periods
    locked, or the year closed);
  - reads the **closing trial balance at the prior year's last day** (same
    aggregation the trial balance uses — net per account, exact BIGINT);
  - balance-sheet accounts (asset / liability / equity) become opening lines;
    **revenue/expense accounts never carry as ordinary opening balances** —
    their net is the prior year's result and is carried into the
    retained-earnings/opening-equity line;
  - A/R control (1200) is replaced by **one line per customer** with a
    non-zero attributed balance at the year-end date (the same attribution
    SQL the A/R subledger uses), party attribution preserved;
  - A/P control (2100) the mirror (one line per supplier);
  - cheques on hand / to pay: **one line per open cheque** (identity: sayad /
    serial in `reference`) when the cheque register and the control account
    agree, otherwise the control total as one line;
  - fixed assets: one line per asset (cost − accumulated depreciation,
    `party_id` = asset id, acquisition provenance in `reference`) when the
    per-asset net book values add up to the asset accounts' closing balance,
    otherwise the account total;
  - inventory: the closing 1300 balance as one line (perpetual and periodic
    alike — periodic's period-close entry has already restated 1300 to the
    ending count);
  - stored as a **draft** `carry_forward` set for the next year
    (effective date = the next year's first day). Idempotent: a unique
    `(business, source = carry_forward, carry_forward_from_year)` — a retry
    returns the existing proposal.
- `reconcileCarryForwardSet` compares the proposal, account by account,
  against the prior close and answers `matched` / a difference list. Approval
  is blocked until it matches exactly.

### Summary vouchers
- `summary_vouchers` + `summary_voucher_sources`. Generated from a **defined
  source set** (explicit entry ids, and/or source types + date cutoff) that
  must balance as a set. Every source entry is linked with a snapshot of its
  own number/date/totals; `UNIQUE (journal_entry_id)` across the table is the
  double-inclusion guard; a client idempotency key makes a retry return the
  original. The underlying journal detail is never touched.

## Files

### Migration
- `migrations/0217_fiscal_opening_vouchers.sql` — opening set/line tables,
  voucher sequences + renumber log, `journal_entries` voucher columns +
  direct-edit guard trigger, summary voucher tables. RLS on every new
  tenant table (the isolation test asserts coverage).

### Pure logic (unit-tested, no I/O)
- `src/lib/voucher-numbering.ts` — document-type catalogue,
  `voucherNumberFor` / `parseVoucherNumber`, `documentTypeForSourceType`,
  manual-reference validation, gap detection over a numbered sequence.
- `src/lib/opening-balances.ts` — opening line validation, carry-forward
  proposal builder (the accounting *rule*: which accounts carry, how the prior
  year's P&L becomes an equity line, when per-party lines are used), and the
  prior-close vs next-open reconciliation.
- `src/lib/voucher-numbering.test.ts`, `src/lib/opening-balances.test.ts`

### Services (DB-touching)
- `src/lib/voucher-numbering-service.ts` — sequence allocation, posting-time
  assignment (called from `ledger-service.ts`), backfill, register + gaps +
  renumber (audited) + renumber log, summary-voucher generation.
- `src/lib/opening-balances-service.ts` — set CRUD, lifecycle transitions,
  posting via `postJournalEntry`, controlled reversal via
  `postExactMirrorEntry`, import preview, carry-forward generation +
  reconciliation.
- `src/lib/ledger-service.ts` — the two posting entry points allocate a
  voucher number inside their existing transaction (the only change).

### API (all tenant-scoped, permission-gated like the other ledger routes)
- `GET|POST /api/ledger/opening-balances`
- `GET|PUT /api/ledger/opening-balances/[id]`
- `POST /api/ledger/opening-balances/[id]/submit | approve | post | reverse`
- `POST /api/ledger/opening-balances/import` (preview, no persist)
- `GET /api/ledger/opening-balances/[id]/export` (csv/xlsx — the opening report)
- `POST /api/ledger/carry-forward` (generate proposal, idempotent)
- `GET /api/ledger/vouchers` (register by number/date/source + export)
- `GET /api/ledger/vouchers/gaps`
- `GET|POST /api/ledger/vouchers/renumber-log`
- `POST /api/ledger/summary-vouchers`, `GET /api/ledger/summary-vouchers([id])`

### UI (Accounting app, one `[section]` route each, composed from the
approved primitives — `PageShell` / `SectionCard` / `DataTable` / `StatusBadge`
/ `JalaliDatePicker`)
- `opening-balances` section (ترازات افتتاحیه): sets list, draft editor with
  account picker + party attribution, import/preview, reconciliation panel,
  submit/approve/post/reverse actions, carry-forward tab (year pair → generate
  → reconcile), CSV export.
- `vouchers` section (اسناد و شماره‌گذاری): register by number/date/source,
  gap report, privileged renumber with reason, renumber audit log, summary
  voucher creation + detail.
- Nav: `accounting-routes.ts` keys, `accounting-nav.ts` labels + group homes,
  `accounting-icons.ts`, `accounting-headings.ts`, `accounting-manager.tsx`.

### Tests
- Unit: the two pure modules.
- Integration:
  - `integration/opening-balances.integration.test.ts` — lifecycle, posting
    through the real path, the no-dependent-postings reversal guard,
    carry-forward generation (party attribution, cheque identity, P&L-to-
    equity), reconciliation, idempotent retry.
  - `integration/voucher-numbering.integration.test.ts` — numbers on posted
    entries, backfill of pre-existing rows, renumber audit + trigger guard,
    gaps, summary voucher traceability + double-inclusion guard.

## Out of scope (deliberately)
- PDF rendering (the repo's reports ship csv/xlsx through `report-export`;
  print/PDF is the browser's job on the same data — same as the journal
  register today).
- Modifying #820/#821/#823/#834 semantics (the issue's non-overlap rule).

## Checklist
- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] `npm run test:db` (incl. tenant-isolation RLS coverage)
- [ ] `npm run build`
- [ ] `npm run test:design`
