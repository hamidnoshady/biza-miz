-- ============================================================================
-- 0211_expense_reversal_and_register.sql — issue #832 (Accounting «هزینه‌ها»)
--
-- The Expenses register was a convenience form, not a subledger: a wrong expense
-- could only be fixed by a manual correcting journal, after which the General
-- Ledger said «zero» and `/accounting/expenses` still showed and totalled the
-- original — permanently. This migration gives the register the two things an
-- auditable book needs: an explicit reversal, and a human reference per row.
--
-- Nothing here deletes or mutates posted history, and nothing here is a new
-- file store or a new people directory: `party_id` points at the platform's one
-- `parties` table (0137) and the receipt photo stays in the Media Library
-- (0177's `receipt_asset_id`).
--
-- ---------------------------------------------------------------------------
-- 1. Reversal / correction state
-- ---------------------------------------------------------------------------
-- Deliberately the same shape `journal_entries` has had since 0029, because
-- that shape is what makes a double reversal impossible:
--   * `reversed_at` / `reversed_by` on the ORIGINAL  — set once, and a second
--     reversal attempt sees it non-NULL and is refused;
--   * `reverses_expense_id` on the REVERSAL — a new, positive, separately dated
--     expense row whose journal swaps the original's debit/credit. A partial
--     UNIQUE index makes "one reversal per expense" a database fact, not a
--     service-layer promise.
-- The original row is never edited, never deleted and its journal lines are
-- never rewritten in place: the correction is a second fact beside the first,
-- which is why the register can still show both sides and why
-- `SUM(signed amount)` equals the GL's net movement on the expense accounts.
--
-- Policy (matching the manual-journal workflow, which this mirrors):
--   * an expense may be reversed once;
--   * a reversal row may not itself be reversed — CHECK below, so a
--     "reverse the reversal" loop cannot be created even by a direct writer;
--   * `ON DELETE RESTRICT`, so deleting the original can never orphan the
--     reversal that explains it.
--
-- ---------------------------------------------------------------------------
-- 2. `vat_amount` — input VAT on an operating expense
-- ---------------------------------------------------------------------------
-- An expense was always posted gross (`Dr expense / Cr payment`), so a
-- VAT-bearing invoice had to be split by hand in a manual journal — and the
-- register's own total then disagreed with the ledger by exactly that amount.
-- `amount` stays the *gross* money that left the payment account; the VAT part
-- of it is recorded here, so the posting becomes
--     Dr expense (amount - vat_amount) / Dr input VAT (vat_amount) / Cr payment (amount)
-- with the input-VAT account resolved from the tenant's own chart (see
-- `expense-service.ts`), never hard-coded. `vat_amount < amount` keeps the net
-- debit positive, which is the arithmetic guarantee the service also checks.
--
-- ---------------------------------------------------------------------------
-- 3. `party_id` — the one people directory, not a second one
-- ---------------------------------------------------------------------------
-- `vendor` stays as the free-text snapshot the operator typed (a one-off taxi
-- receipt must not require creating a person first, and the name on an
-- historical expense must not change when the party record is renamed).
-- `party_id` is the optional link to the same `parties` row the CRM, the store
-- and A/P look at. `ON DELETE SET NULL`: the expense outlives the party, while
-- the text the accountant recorded stays put.
--
-- ---------------------------------------------------------------------------
-- 4. `reference` — an accountant-facing number
-- ---------------------------------------------------------------------------
-- The register had no human identifier at all: `id` is a UUID, and every other
-- Accounting screen is read by document number. References are
-- `EXP-<Jalali year>-<00001>`, numbered per business from
-- `expense_reference_counters` — one row per business updated inside the same
-- transaction that inserts the expense, so concurrent postings cannot produce
-- the same number and a business's numbering has no gaps.
--
-- The column is nullable and is *not* back-filled: a cross-tenant UPDATE cannot
-- run inside a migration under FORCE'd RLS (the tenant context is per request),
-- and inventing retroactive numbers for rows that were recorded under a
-- different regime would be its own kind of falsification. Rows recorded before
-- this migration show «—» and keep their stable id; everything from here on is
-- numbered.
-- ============================================================================

ALTER TABLE expenses
    ADD COLUMN reversed_at          timestamptz,
    ADD COLUMN reversed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN reverses_expense_id  uuid REFERENCES expenses(id) ON DELETE RESTRICT,
    ADD COLUMN party_id             uuid REFERENCES parties(id) ON DELETE SET NULL,
    ADD COLUMN vat_amount           bigint NOT NULL DEFAULT 0,
    ADD COLUMN reference            text,
    ADD COLUMN receipt_file_name    text;

-- 0177's `receipt_asset_id` is `ON DELETE SET NULL` on purpose (a posted
-- financial record must never be blocked or broken by the fate of a photo), but
-- that leaves «no receipt» and «receipt purged later» looking identical in the
-- register — and an accountant deciding whether an expense is evidence-backed
-- must not have to guess which one they are looking at. The name recorded at
-- attach time is the difference, and it costs no second file store: it is a
-- string, not an asset.

-- An input-VAT amount is a part of the gross, never all of it (a 0-net expense
-- is not an expense), and never negative.
ALTER TABLE expenses
    ADD CONSTRAINT expenses_vat_within_amount CHECK (vat_amount >= 0 AND vat_amount < amount);

-- The reversal bookkeeping belongs to the row being reversed: `reversed_by`
-- without `reversed_at` would claim a reversal happened at no time.
ALTER TABLE expenses
    ADD CONSTRAINT expenses_reversed_at_required CHECK (reversed_at IS NOT NULL OR reversed_by IS NULL);

ALTER TABLE expenses
    ADD CONSTRAINT expenses_reversal_not_self CHECK (reverses_expense_id IS NULL OR reverses_expense_id <> id);

-- A reversal is never itself reversed (the manual-journal rule), and an
-- original's own VAT/amount are what its reversal mirrors, so a reversal row
-- must not be marked reversed.
ALTER TABLE expenses
    ADD CONSTRAINT expenses_reversal_is_final CHECK (reversed_at IS NULL OR reverses_expense_id IS NULL);

-- One reversal per expense, enforced in the schema.
CREATE UNIQUE INDEX idx_expenses_reverses_expense
    ON expenses (reverses_expense_id) WHERE reverses_expense_id IS NOT NULL;

CREATE INDEX idx_expenses_reversed_by ON expenses (reversed_by) WHERE reversed_at IS NOT NULL;
CREATE INDEX idx_expenses_party ON expenses (party_id) WHERE party_id IS NOT NULL;

CREATE UNIQUE INDEX idx_expenses_reference ON expenses (business_id, reference)
    WHERE reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Per-business reference counter
-- ---------------------------------------------------------------------------
-- `business_id` *is* the key, so the policy shape is 0021's "shape 1" with the
-- column renamed: a business may only ever see and bump its own row.
CREATE TABLE expense_reference_counters (
    business_id  uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    last_number  bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE expense_reference_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_reference_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_reference_counters FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Register access paths
-- ---------------------------------------------------------------------------
-- Measured, not guessed. `scripts/bench-expense-queries.mjs` (run:
-- `DATABASE_URL=… node scripts/bench-expense-queries.mjs --rows 200000`) builds a
-- disposable copy of these two tables, fills it with 200k expenses over 720 days
-- across 2 branches and 4 tenants — 2% of them sharing one `created_at`, because
-- that is what a bulk import does — and runs the register's real queries under
-- `EXPLAIN (ANALYZE, BUFFERS)` once per candidate index. Against `0030`'s lone
-- `idx_expenses_business`, every one of them was a `Parallel Seq Scan on expenses`
-- (≈6.6k shared blocks, the whole tenant) plus an explicit `Sort`, and the
-- numbers were: first page 26.7 ms · keyset page 28.7 ms · 60-day totals 15.4 ms ·
-- date window 14.2 ms · category filter 14.0 ms · payment filter 12.1 ms ·
-- branch filter 14.1 ms · reversed-state filter 23.7 ms. With all four indexes
-- below: 2.1 · 1.8 · 7.0 · 0.1 · 0.3 · 0.2 · 0.2 · 0.1 ms, on 101–150 blocks, and
-- the `Sort` node is gone from every read except the two that return a few dozen
-- rows and sort them for free. Each index is therefore justified by the plan, per
-- query, by the script's own verdict — the first by six queries, each of the other
-- three by the filter it is named for.
--
-- What stays a scan: `memo/vendor ILIKE '%…%'` (64.7 ms before, 67.4 ms after).
-- No index can help a leading-wildcard match, and the trigram extension this
-- schema does not use anywhere has to be a platform decision, not an
-- expense-only one — so the tenant-leading index is what bounds that query to one
-- business's rows, and that is all it promises.
--
-- The `id DESC` tail is load-bearing, not decoration: `expense_date` and
-- `created_at` both tie inside one bulk import, and the keyset pagination in
-- `listExpenses` needs a total order to page on.
CREATE INDEX idx_expenses_business_date_created
    ON expenses (business_id, expense_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_expenses_business_account_date
    ON expenses (business_id, account_id, expense_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_expenses_business_payment_account_date
    ON expenses (business_id, payment_account_id, expense_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_expenses_business_location_date
    ON expenses (business_id, location_id, expense_date DESC, created_at DESC, id DESC);
