-- ============================================================================
-- 0312_identity_phone_password.sql — #1386: a verified phone is a password
-- identifier, so a password no longer requires an email.
--
-- 0303 introduced the rule `password_hash IS NULL OR email IS NOT NULL`, on the
-- then-true premise that "no password door could ever ask for it" without an
-- email. #1386 makes phone + password the **default** cloud login, so that
-- premise is gone: a phone-only identity must be able to hold a password.
--
-- The reachability rule stays: an identity still needs at least one channel
-- (`platform_users_credential_channel`: email or verified phone). What this
-- migration removes is only the email-specific coupling of the password.
--
-- Rollback: the constraint can be restored once no `platform_users` row has a
-- password and a NULL email. No data is rewritten here.
-- ============================================================================

ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_password_needs_email;

COMMENT ON COLUMN platform_users.password_hash IS
    'bcrypt hash of the identity password, or NULL for a passwordless identity (ESH-199). #1386: a password may sit on a phone-only identity; the login door resolves email or verified phone.';
