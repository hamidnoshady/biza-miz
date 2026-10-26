-- Issue #907 (F02/F03) — one live approval request per subject/revision.
--
-- The workspace approval engine is polymorphic: a contract, a document
-- revision, an estimate version, a submittal revision, a variation, a payment
-- certificate, a material request and a commitment all file their request in
-- `workspace_approvals`. Nothing stopped a subject from carrying SEVERAL
-- pending requests at once, and the first decision to land then moved the
-- subject's state while the others stayed pending and contradictory. The
-- command layer now refuses the second request (it is the index below that
-- makes that a fact rather than a read-then-write check two clients can
-- interleave), and a withdrawal reverts the subject instead of stranding it.
--
-- `subject_id` already names the exact revision for the revision-bound
-- subjects (a new document revision, estimate version or submittal revision is
-- its own row with its own id), so `(business_id, subject_type, subject_id)` is
-- the subject/revision key the audit asked for — no second column is invented
-- that would duplicate an id that is already per-revision.

-- ---------------------------------------------------------------------------
-- 1. Reconcile pre-existing duplicates before the constraint can exist.
-- ---------------------------------------------------------------------------
-- Forward-only and history-preserving: on a subject that already carries more
-- than one pending request, the NEWEST one stays pending and every older one is
-- moved to `cancelled` with a note saying why. Nothing is deleted, no decision
-- is invented and no subject is activated; what the operator sees afterwards is
-- one live request and a trail of the duplicates, which is exactly the state
-- the command layer will maintain from now on.
-- Transaction-local bypass: the runner wraps each file in its own transaction,
-- and `workspace_approvals` carries FORCE RLS, so without this the reconcile
-- below would match nothing when the runner's role is the table owner.
SELECT set_config('app.rls_bypass', 'on', true);

UPDATE workspace_approvals a
   SET status = 'cancelled',
       note = CASE
                WHEN a.note = '' THEN 'لغو خودکار تکراری هنگام یکتاسازی درخواست‌های در انتظار (مهاجرت ۰۲۵۸).'
                ELSE a.note || E'\n' || 'لغو خودکار تکراری هنگام یکتاسازی درخواست‌های در انتظار (مهاجرت ۰۲۵۸).'
              END,
       updated_at = now()
 WHERE a.status = 'pending'
   AND EXISTS (
     SELECT 1
       FROM workspace_approvals b
      WHERE b.business_id = a.business_id
        AND b.subject_type = a.subject_type
        AND b.subject_id = a.subject_id
        AND b.status = 'pending'
        AND (b.created_at, b.id) > (a.created_at, a.id)
   );

SELECT set_config('app.rls_bypass', '', true);

-- ---------------------------------------------------------------------------
-- 2. The database-backed rule.
-- ---------------------------------------------------------------------------
-- Partial on `status = 'pending'` because decided and cancelled rows are the
-- history of the subject and may be arbitrarily many; only the live request is
-- unique. Every AEC subject is covered by the same key, which is the point: the
-- rule belongs to the engine, not to the two modules that existed first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_approvals_one_pending
    ON workspace_approvals (business_id, subject_type, subject_id)
    WHERE status = 'pending';
