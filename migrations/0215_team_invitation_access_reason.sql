-- Issue #854 (P2.4) — the access-change reason travels with invitations.
--
-- An invitation is a future membership: the inviter picks the role, any custom
-- role and any capability overrides at invite time, and the membership arrives
-- wearing exactly that access when the link is accepted. The required-reason
-- rule for sensitive access changes therefore applies at invitation creation,
-- and the validated text must survive to the acceptance audit row — hence it
-- is stored on the invitation itself, not re-asked at the door.
--
-- Nullable by design: a plain preset-role invite with no overrides is not a
-- sensitive access change and needs no prose. `createInvitation` enforces the
-- requirement for invitations that DO grant extra access.
ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS reason text;
