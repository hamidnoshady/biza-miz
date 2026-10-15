-- Issue #854 follow-up (third pass) — every tenant session is now revocable.
--
-- Six doors minted a session token without an `employee_sessions` row: the
-- business switch, the three first-run doors (bootstrap, public signup,
-- desktop pairing), the desktop app's one-time cloud hand-off and the company
-- staff hand-off. With no row there was nothing to end, so «خروج» could only
-- clear the browser's cookie (`not_tracked`), and a copy of the token kept
-- anywhere else stayed valid until it expired — longer, in fact, because the
-- step-up and credential re-mints re-sign the token with a fresh expiry. Those
-- doors now open a row through the same `createSession` every sign-in door
-- uses, and the request authenticator refuses a tenant token that names
-- neither a row nor a support grant.
--
-- The rows say which door opened them, for the Profile device list and the
-- security center (P2.27). The CHECK added by 0211 only knew the sign-in
-- doors, so it is widened by exactly the four new ones. NULL stays allowed: it
-- is what the rows that predate 0211 carry.
ALTER TABLE employee_sessions DROP CONSTRAINT employee_sessions_login_method_check;
ALTER TABLE employee_sessions ADD CONSTRAINT employee_sessions_login_method_check
  CHECK (login_method IS NULL OR login_method IN (
    'password', 'phone_otp', 'pin', 'webauthn', 'invitation', 'impersonation',
    'business_switch', 'setup', 'desktop_handoff', 'company_handoff'
  ));
