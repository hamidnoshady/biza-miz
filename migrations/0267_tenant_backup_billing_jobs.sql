-- ============================================================================
-- 0267_tenant_backup_billing_jobs.sql — Issue #903 §7.
--
-- The refund reconciliation credits a wallet back for a backup pre-charge that
-- bought nothing. It is safe to re-run only if a charge cannot be refunded
-- twice, and "we checked first" is not a guarantee — two scheduler instances can
-- check at the same instant. This partial unique index makes the second refund
-- of the same ledger entry a constraint violation instead of a second credit.
--
-- The index is keyed on the ledger metadata the job itself writes
-- (`refundOf` = the id of the charge being reversed), so it constrains exactly
-- this reconciliation and nothing else in the wallet.
--
-- Forward-only and additive.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_refund_once
    ON wallet_ledger ((metadata->>'refundOf'))
    WHERE kind = 'refund' AND metadata ? 'refundOf';
