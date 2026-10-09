-- Issue #854 (GAP 8, found by the deferred-stamp regression test) — the
-- phone-OTP door could not send at all.
--
-- `sendEmployeePhoneOtp` records every successful send in
-- `auth_login_attempts` under realm 'phone_otp' (that is what the resend
-- cooldown and the hourly/daily caps read back), but the realm CHECK
-- constraint had never been extended past the MFA challenge work, so the
-- INSERT violated `auth_login_attempts_realm_check` and every phone-OTP
-- login send surfaced as a 502 `sms_dispatch_failed` — the code had been
-- minted, then burned again, and the member could not get in by number at
-- all. The rate limiter's own SELECT proves 'phone_otp' is the intended
-- value; this aligns the constraint with it.
ALTER TABLE auth_login_attempts DROP CONSTRAINT auth_login_attempts_realm_check;
ALTER TABLE auth_login_attempts ADD CONSTRAINT auth_login_attempts_realm_check
  CHECK (realm IN ('tenant_password','platform_admin','directory','mfa_challenge','phone_otp'));
