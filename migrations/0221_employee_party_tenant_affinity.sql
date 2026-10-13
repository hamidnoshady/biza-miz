-- Issue #947: an Employee personnel file may only link to a membership owned by
-- the same business. RLS limits visibility, but it cannot enforce this
-- relationship invariant.
--
-- Clear impossible legacy links before adding the constraint. The personnel row
-- and all of its accounting history are retained; only the unsafe login link is
-- removed for an administrator to reconcile deliberately.
UPDATE parties p
   SET employee_user_id = NULL,
       updated_at = now()
 WHERE employee_user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM users u
      WHERE u.id = p.employee_user_id
        AND u.business_id = p.business_id
   );

ALTER TABLE parties
  DROP CONSTRAINT IF EXISTS parties_employee_user_id_fkey;

ALTER TABLE parties
  ADD CONSTRAINT parties_employee_membership_same_business_fkey
  FOREIGN KEY (business_id, employee_user_id)
  REFERENCES users (business_id, id)
  ON DELETE RESTRICT;
