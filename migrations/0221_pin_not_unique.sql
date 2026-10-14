-- A staff PIN is a personal secret, not an identifier.
--
-- Migration 0211 (§3) made PINs unique per business with a keyed blind index,
-- because the PIN door could still be called with a PIN alone and had to find
-- the one member it belonged to. The cost was a leak: adding or changing a
-- member's PIN to digits a colleague already used was refused with "this PIN
-- belongs to another member", which told the person choosing it what somebody
-- else's PIN is.
--
-- The door now always names the member first (the roster picker has sent
-- `employeeId` since Phase 20 Wave 2, and `/api/auth/pin-login` refuses a
-- request without one), so a PIN only ever has to match one member's bcrypt
-- hash and two members may choose the same digits. The uniqueness index and
-- the blind-index column that fed it go; `secret_hash` stays the only stored
-- form of a PIN.

DROP INDEX IF EXISTS idx_employee_credentials_pin_blind_index;

ALTER TABLE employee_credentials
    DROP COLUMN IF EXISTS pin_blind_index;
