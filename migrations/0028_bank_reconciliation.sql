-- Phase 16 — bank & cash reconciliation.
--
-- Reconciles one settlement account — صندوق 1100, بانک 1110 or کارت‌خوان در راه
-- 1120; the canonical list is `RECONCILABLE_ACCOUNTS` in
-- src/lib/bank-reconciliation.ts — against a manually-entered statement ending
-- balance (decision: manual entry first, a bank-file import format is deferred
-- — see the phase doc's resolved open questions). This file originally named
-- only 1100 and 1120, on the reasoning that nothing posted to the plain bank
-- account; Phase 30 changed that, when a cheque began clearing *into the
-- bank*. Only this comment moved: every statement below is unchanged, and the
-- schema was never account-specific.
-- A reconciliation starts 'in_progress': the candidate journal
-- lines are every posting to the account not already claimed by an earlier
-- reconciliation (via bank_reconciliation_lines), up to the statement date —
-- so "unreconciled items carry forward" falls out of the model for free,
-- with no separate carry-forward step needed. Completing it (only once the
-- opening balance from the last completed reconciliation, plus the cleared
-- lines, matches the statement balance exactly) locks those lines: they can
-- never be un-cleared or claimed by a later reconciliation.
--
-- Deliberately NOT hooked into the fiscal-period lock (migrations 0024):
-- that trigger blocks *posting* into a date range, business-wide, on every
-- account; this is a different axis entirely — marking specific lines on
-- one specific account as matched, which must keep working regardless of
-- whether the fiscal period covering their dates is open, soft-closed, or
-- locked.

CREATE TABLE bank_reconciliations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    statement_date    date NOT NULL,
    statement_balance bigint NOT NULL,
    status            text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
    completed_at      timestamptz,
    completed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bank_reconciliations_business_account ON bank_reconciliations (business_id, account_id);
-- Only one reconciliation may be in progress per account at a time.
CREATE UNIQUE INDEX idx_bank_reconciliations_one_in_progress
    ON bank_reconciliations (account_id) WHERE status = 'in_progress';

CREATE TABLE bank_reconciliation_lines (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reconciliation_id  uuid NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
    journal_line_id    bigint NOT NULL REFERENCES journal_lines(id) ON DELETE RESTRICT,
    UNIQUE (journal_line_id)
);
CREATE INDEX idx_bank_reconciliation_lines_reconciliation ON bank_reconciliation_lines (reconciliation_id);

ALTER TABLE bank_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_reconciliations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- bank_reconciliation_lines → bank_reconciliations (business_id), same shape as journal_lines → journal_entries.
ALTER TABLE bank_reconciliation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliation_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_reconciliation_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM bank_reconciliations r
         WHERE r.id = bank_reconciliation_lines.reconciliation_id
           AND r.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM bank_reconciliations r
         WHERE r.id = bank_reconciliation_lines.reconciliation_id
           AND r.business_id = app_current_business()));
