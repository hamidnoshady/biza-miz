-- ============================================================================
-- 0197_backup_architecture_hardening.sql — issue #807.
--
-- The audit of the tenant and Superadmin backup/restore systems found the
-- architecture — not just the UI — had three holes this migration gives the
-- database vocabulary to close:
--
--   1. `backup_runs` could not say *what an artifact contains*. A tenant row
--      whose artifact is a privileged whole-database `pg_dump` looks exactly
--      like one whose artifact is a tenant-only logical snapshot. `scope`
--      records it, so the console, the alerting and the restore gate can tell a
--      physical dump from a logical snapshot without parsing file names.
--      Existing rows are `physical`, which is what they are.
--
--   2. `platform_restore_runs` could not survive its own restore. The row was
--      inserted before the swap and updated after it — by which point the row
--      frequently belonged to a database snapshot that no longer existed. The
--      durable half now lives in an append-only journal *outside* the target
--      database (src/lib/restore-journal.ts); these columns tie a receipt row
--      back to that journal, record the phase the run reached, and carry an
--      actor *label* that survives the actor's row disappearing in the restored
--      snapshot.
--
--   3. Cloud restore had no explicit identity for the object being restored
--      (`platform-backups/pos-backup-….dump.enc` is not a file name, and
--      overloading it into one is how a prefix mismatch becomes a bug). The
--      object key is now modelled explicitly and validated against the
--      configured prefix server-side.
--
-- Forward-only, additive, and safe on a live deployment: every column has a
-- default, no existing row changes meaning, and nothing is dropped.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- What a tenant artifact contains: a physical whole-database dump, or a
-- logical tenant-only snapshot.
-- ---------------------------------------------------------------------------
ALTER TABLE backup_runs
    ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'physical'
        CHECK (scope IN ('physical', 'logical'));

-- The scope is the discriminator every restore/upload guard reads, so it gets
-- an index alongside the columns the history queries already use.
CREATE INDEX IF NOT EXISTS idx_backup_runs_business_scope_time
    ON backup_runs (business_id, scope, started_at DESC);

-- The run's uuid, so the artifact name (which carries its first 8 hex chars)
-- can be tied back to the row that wrote it even after the file is gone.
ALTER TABLE backup_runs
    ADD COLUMN IF NOT EXISTS run_token text;

COMMENT ON COLUMN backup_runs.scope IS
    'physical = whole-database pg_dump (site/local only); logical = tenant-only RLS-scoped snapshot (central only). Issue #807.';

-- ---------------------------------------------------------------------------
-- A second outbound-network switch for peer/URL restore. `allow_insecure_peers`
-- says "plain http is acceptable"; this one says "a LAN address is acceptable"
-- — a different decision, because the audit's SSRF finding was that a peer URL
-- pointing at 127.0.0.1 or 169.254.169.254 was validated for syntax only. Both
-- default to false: metadata/link-local are never allowed, and private targets
-- only when an operator has said so on the console.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_backup_config
    ADD COLUMN IF NOT EXISTS allow_private_peers boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN platform_backup_config.allow_private_peers IS
    'Explicitly allow peer/direct-URL restore from private (RFC1918/ULA/CGNAT) addresses. Link-local and metadata addresses stay blocked. Issue #807.';

-- ---------------------------------------------------------------------------
-- Restore receipts: the durable half lives in the journal outside the database;
-- these columns let the row in the (possibly restored) database point at it.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_restore_runs
    ADD COLUMN IF NOT EXISTS journal_id text,
    ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'verify_started',
    ADD COLUMN IF NOT EXISTS actor_label text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS object_key text;

-- The phase vocabulary is the restore state machine (src/lib/restore-journal.ts).
-- A CHECK rather than free text so a dashboard can branch on it safely.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'platform_restore_runs_phase_check'
    ) THEN
        ALTER TABLE platform_restore_runs
            ADD CONSTRAINT platform_restore_runs_phase_check
            CHECK (phase IN (
                'verify_started',
                'verify_failed',
                'verify_succeeded',
                'apply_started',
                'apply_failed_before_swap',
                'apply_rolled_back',
                'apply_succeeded',
                'post_restore_reconnect_succeeded',
                'post_restore_reconnect_failed'
            ));
    END IF;
END $$;

-- A receipt appended *after* a successful swap is written by the restored
-- database, whose `platform_admins` may no longer contain the pre-restore
-- admin. `created_by` is already nullable; the label is what the console shows.
CREATE INDEX IF NOT EXISTS idx_platform_restore_runs_journal
    ON platform_restore_runs (journal_id);

COMMENT ON COLUMN platform_restore_runs.journal_id IS
    'Id of the durable journal entry in RESTORE_JOURNAL_DIR that recorded this restore end to end. Issue #807.';
COMMENT ON COLUMN platform_restore_runs.actor_label IS
    'The operating admin as a plain label, so a post-restore receipt survives the restored snapshot no longer having that admin row.';
