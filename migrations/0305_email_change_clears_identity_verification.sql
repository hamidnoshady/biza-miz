-- 0305_email_change_clears_identity_verification.sql
-- ESH-199 follow-up — a verified email must not outlive the address that proved it.
--
-- `platform_users.email_verified_at` is read as assurance
-- (`identity-billing-contract.ts`): a non-null stamp means *this* address was
-- proven. Two writers change the address — the super-admin owner profile
-- (`platform-owner-profile.ts`) and cloud credential replication
-- (`iam/login-credentials-service.ts`) — and neither cleared the stamp, so a
-- newly typed address inherited the previous one's proof.
--
-- The invariant belongs in the database rather than in each writer: a third
-- writer added later cannot reintroduce the hole. Consumption already refuses
-- a token whose address changed, but an already-stamped identity never needed
-- the token again, so the stamp is the part that mattered.

CREATE OR REPLACE FUNCTION clear_identity_email_verification_on_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- The new address has not been proven. A statement that deliberately sets
    -- the stamp itself is left alone (the WHEN clause skips that case).
    NEW.email_verified_at := NULL;

    -- A support link mailed to the old address must not survive the change,
    -- even though consumption also binds the proof to the address.
    UPDATE platform_email_verifications
       SET consumed_at = now()
     WHERE platform_user_id = NEW.id
       AND consumed_at IS NULL;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_users_email_change ON platform_users;
CREATE TRIGGER trg_platform_users_email_change
    BEFORE UPDATE OF email ON platform_users
    FOR EACH ROW
    WHEN (OLD.email IS DISTINCT FROM NEW.email
          AND NEW.email_verified_at IS NOT DISTINCT FROM OLD.email_verified_at)
    EXECUTE FUNCTION clear_identity_email_verification_on_change();

COMMENT ON FUNCTION clear_identity_email_verification_on_change() IS
    'A changed platform_users.email clears email_verified_at and consumes live verification tokens (ESH-199).';
