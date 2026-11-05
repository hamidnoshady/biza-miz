-- ============================================================================
-- 0268_tenant_backup_custody_ops.sql — Issue #903 §8.
--
-- One new artifact state, and the column that explains it.
--
-- When a Superadmin unlocks a legacy passphrase artifact under managed custody
-- (§8 "portable legacy passphrase unlock"), the old row is not deleted and not
-- relabelled as expired: its retention did not end, and it still opens with the
-- passphrase the Owner kept. It is *superseded* — a newer row is now the copy a
-- restore should use — and `superseded_by` names that row's storage reference so
-- an operator can follow the chain.
--
-- The billing, inventory and restore code all already refuse anything that is
-- not `ready`, so the new state is inert everywhere except the surfaces that
-- deliberately mention it.
--
-- Forward-only and additive.
-- ============================================================================

ALTER TABLE tenant_backup_artifacts
    DROP CONSTRAINT IF EXISTS tenant_backup_artifacts_state_check;

ALTER TABLE tenant_backup_artifacts
    ADD CONSTRAINT tenant_backup_artifacts_state_check CHECK (state IN (
        'pending_upload', 'uploading', 'verifying', 'ready', 'failed', 'expired', 'superseded'
    ));

ALTER TABLE tenant_backup_artifacts
    ADD COLUMN IF NOT EXISTS superseded_by text;

COMMENT ON COLUMN tenant_backup_artifacts.superseded_by IS
    'Storage reference of the artifact that replaced this one under managed custody (issue #903 §8). Server-only; never serialized.';
