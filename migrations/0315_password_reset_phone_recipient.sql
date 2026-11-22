-- ============================================================================
-- 0313_password_reset_phone_recipient.sql — #1386: a phone-only identity can
-- receive a password-reset link too.
--
-- `auth_password_resets.email` was NOT NULL because the only delivery channel
-- was email. The reset itself is delivered by SMS to the account holder's
-- verified phone, so the address is display/metadata, not the recipient. A
-- phone-only identity has no address at all.
--
-- `phone_e164` records the canonical global number the link was sent to, so the
-- reset preview can name a recipient without exposing the full number and the
-- lockout reset can use the same identifier the password door uses.
--
-- Rollback: drop `phone_e164` and restore NOT NULL once no row has a NULL
-- email. No data is rewritten.
-- ============================================================================

ALTER TABLE auth_password_resets
    ALTER COLUMN email DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS phone_e164 text;

COMMENT ON COLUMN auth_password_resets.email IS
    'Account email at issue time, or NULL for a phone-only identity (#1386). The reset link is delivered by SMS to phone_e164.';
COMMENT ON COLUMN auth_password_resets.phone_e164 IS
    'Canonical verified phone the reset link was delivered to (#1386). Never rendered in full by the public preview.';
