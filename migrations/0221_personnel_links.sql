-- 0221_personnel_links.sql
--
-- Issue #947 (TEAM-F02, TEAM-F05) — the personnel link a membership owns, and the
-- durable record of a file that could not be written.
--
-- ---------------------------------------------------------------------------
-- 1. `parties.employee_user_id` becomes same-business by construction
-- ---------------------------------------------------------------------------
-- Migration 0137 linked a personnel file to its membership with a plain
-- `uuid REFERENCES users(id)`. `users.id` is globally unique, so that constraint
-- accepted a link to *any* business's membership: the app's own guard
-- (`assertLinkedPartyFollowsCanonicalIdentity`) looks the id up **inside the
-- business** and returns early when it finds nothing, which is the correct answer
-- for a link that has gone stale and the wrong one for a link being proposed.
--
-- The invariant is the pair, not the id: a personnel file of business B may only
-- point at a membership of business B. A composite foreign key
-- `(business_id, employee_user_id)` expresses exactly that, and it holds for every
-- writer — this issue's validated operations, a bulk import, a migration, a future
-- screen — rather than only for the paths that remember to ask.
--
-- `ON DELETE SET NULL (employee_user_id)` is the PG 15+ column-list form, and it is
-- load-bearing here: a bare `ON DELETE SET NULL` would null *every* referencing
-- column, `business_id` included, and the row's NOT NULL would abort the delete of
-- the member. Offboarding keeps the file (its advances and payroll history are
-- financial records), so the link is what goes, not the row.
--
-- Pre-existing invalid links: a cross-business link is unambiguously wrong — it is
-- a tenant leak and never a legitimate record — so the migration clears it and
-- writes the evidence to `audit_log` in the same statement, rather than guessing at
-- a replacement membership. The file itself is untouched: its accounting code, its
-- history and its role survive, and the Team screen shows it as a standalone
-- personnel file («بدون حساب ورود») that an owner can deliberately link again.

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_business_membership ON users (business_id, id);

-- Audit first, then clear: the order matters in a single transaction, because the
-- audit rows name the link that is about to disappear.
INSERT INTO audit_log (business_id, action, entity, entity_id, payload)
SELECT p.business_id,
       'team.personnel_link_repaired',
       'party',
       p.id::text,
       jsonb_build_object(
           'before', p.employee_user_id,
           'after', NULL,
           'reason', 'cross_business_link',
           'note', 'cleared by migration 0221; the membership is not in this business'
       )
  FROM parties p
 WHERE p.employee_user_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM users u
        WHERE u.id = p.employee_user_id AND u.business_id = p.business_id
   );

UPDATE parties p
   SET employee_user_id = NULL,
       updated_at = now()
 WHERE p.employee_user_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM users u
        WHERE u.id = p.employee_user_id AND u.business_id = p.business_id
   );

-- The single-column constraint is now redundant — the composite one is strictly
-- stronger — and two constraints on one column is how a future reader concludes
-- that the id alone is a valid target.
ALTER TABLE parties DROP CONSTRAINT IF EXISTS parties_employee_user_id_fkey;

ALTER TABLE parties
    ADD CONSTRAINT parties_employee_same_business
    FOREIGN KEY (business_id, employee_user_id)
    REFERENCES users (business_id, id)
    ON DELETE SET NULL (employee_user_id);

COMMENT ON COLUMN parties.employee_user_id IS
    'The membership this personnel file belongs to, in THIS business (composite FK with business_id, migration 0221). NULL means a standalone file: an HR record with no login account.';

-- ---------------------------------------------------------------------------
-- 2. The durable half of the membership → file guarantee
-- ---------------------------------------------------------------------------
-- Every membership writer (direct creation, the setup wizard, invitation
-- acceptance, rehire, an IAM replica applying a cloud event) calls one idempotent
-- `ensurePersonnelFileForMembership`. The write is a second statement after the
-- membership transaction, so it can fail on its own — and until now it failed
-- *silently*: a swallowed error left a member with no personnel file, and nothing
-- anywhere recorded that the platform owed one.
--
-- This table is that record. A row is written when a propagation fails, retried on
-- the next touch of the member (and by `scripts/reconcile-personnel-files.ts`), and
-- closed when the file exists with the canonical identity. It is a *drift* log, not
-- a job queue: the retry is the membership's own sync path, and the row only has to
-- survive long enough for the next one to run.
--
-- Partial unique index on the open rows only: a member may drift, be repaired and
-- drift again, and each episode is its own row — but only one of them can be open,
-- so a retry storm cannot pile up duplicates.

CREATE TABLE personnel_file_drift (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Why the last attempt failed, in the service's own words (never a secret):
    -- 'file_missing' (no party row for the membership) or 'identity_stale' (the row
    -- exists and does not carry the membership's canonical name/phone/email).
    reason          text NOT NULL CHECK (reason IN ('file_missing', 'identity_stale')),
    last_error      text,
    attempts        integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    last_attempt_at timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz
);

CREATE UNIQUE INDEX uq_personnel_file_drift_open
    ON personnel_file_drift (business_id, user_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_personnel_file_drift_open
    ON personnel_file_drift (business_id, last_attempt_at) WHERE resolved_at IS NULL;

ALTER TABLE personnel_file_drift ENABLE ROW LEVEL SECURITY;
ALTER TABLE personnel_file_drift FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON personnel_file_drift FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE personnel_file_drift IS
    'Issue #947 (TEAM-F05). One open row per membership whose personnel file could not be created or refreshed; cleared when the file matches the membership again.';
