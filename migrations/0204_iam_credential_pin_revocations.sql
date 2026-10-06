-- Issue #850: how many staff PINs a credential pass *removed*, next to how many
-- it wrote.
--
-- The login-credential plane could already say how much of the cloud's PIN
-- state it applied (`pins_applied`), but the opposite direction had no counter:
-- a PIN deleted on the cloud propagated silently, and the connection panel had
-- no way to distinguish "nothing to do" from "three staff PINs were revoked on
-- this site a moment ago". This is diagnostics only — nothing reads it to take
-- a decision — so the column is nullable-by-default like its siblings.
ALTER TABLE iam_login_credential_sync_state
  ADD COLUMN IF NOT EXISTS pins_revoked integer NOT NULL DEFAULT 0 CHECK (pins_revoked >= 0);

COMMENT ON COLUMN iam_login_credential_sync_state.pins_revoked IS
  'Staff PINs the cloud had removed and this pass revoked locally (issue #850).';
