-- ============================================================================
-- 0311_identity_audit_admin_actor.sql — ESH-199 / #1384 follow-up.
--
-- `readNationalId` (src/lib/iam/identity-profile.ts) permits exactly two
-- readers: the person themselves, and the platform-admin realm (support and
-- compliance). Migration 0303's audit table only had
-- `actor_platform_user_id`, which references `platform_users`. A platform admin
-- is a `platform_admins` row — a separate auth realm, never a `platform_users`
-- row — so an administrative read was recorded with *no actor at all*. The
-- subject could see that their national ID had been read but not by whom,
-- which defeats the point of auditing a privileged read.
--
-- This is additive and nullable: person-initiated actions keep
-- `actor_platform_user_id`, delivery actions (email verification) keep neither,
-- and existing rows are unchanged. The value is still an id — never the
-- national ID, a phone number or an email address.
--
-- Rollback: drop the column and its index. The audit rows survive; only the
-- administrative attribution of past reads is lost. Nothing about the
-- ciphertext, the blind index or the pair constraint changes.
-- ============================================================================

ALTER TABLE platform_identity_events
    ADD COLUMN IF NOT EXISTS actor_platform_admin_id uuid
        REFERENCES platform_admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_platform_identity_events_admin_actor
    ON platform_identity_events (actor_platform_admin_id, created_at DESC)
 WHERE actor_platform_admin_id IS NOT NULL;

COMMENT ON COLUMN platform_identity_events.actor_platform_admin_id IS
    'Platform-admin actor for a privileged national-ID read (ESH-199). NULL for person-initiated actions and email deliveries.';
