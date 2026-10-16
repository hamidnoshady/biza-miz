-- Issue #854 follow-up — the desktop's «ورود با حساب ابری» records its door.
--
-- `/api/auth/cloud-login/callback` opens a local session after the person has
-- signed in to the CLOUD account (the cloud checked the password and any second
-- factor; this install only verifies the cloud's signed hand-back and the
-- replicated identity). It recorded no `login_method`, so Profile and the
-- security center fell back to the credential label — and none of the recorded
-- doors is true for it: not `password` (no password was checked here), not
-- `desktop_handoff` (that is the opposite direction: the desktop app opening
-- the cloud pane).
--
-- One value, `cloud_account`, is added to 0226's CHECK; every existing value
-- is kept. NULL stays allowed: it is what rows from before 0211 carry.
ALTER TABLE employee_sessions DROP CONSTRAINT employee_sessions_login_method_check;
ALTER TABLE employee_sessions ADD CONSTRAINT employee_sessions_login_method_check
  CHECK (login_method IS NULL OR login_method IN (
    'password', 'phone_otp', 'pin', 'webauthn', 'invitation', 'impersonation',
    'business_switch', 'setup', 'desktop_handoff', 'company_handoff',
    'cloud_account'
  ));
