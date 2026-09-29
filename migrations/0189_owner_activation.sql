-- ============================================================================
-- 0189_owner_activation.sql — issue #755 §14: owner activation, not handover
--
-- Provisioning used to let the platform operator choose the tenant owner's
-- password and then print the owner's second factor and recovery codes for
-- them. That makes the operator the holder of a permanent credential to
-- somebody else's business, and hand-delivered TOTP secrets and recovery codes
-- travel through whatever channel the two people happen to share.
--
-- This table carries the replacement. A newly provisioned owner gets a
-- single-use activation link. The operator can hand the link over but cannot
-- use it: redeeming it is where the owner sets their *own* password, and where
-- the second factor and recovery codes are minted, in the owner's own browser,
-- shown only to them. The operator never sees or chooses any of it.
--
-- Only the token's sha-256 is stored — the same rule as invitations (0022) and
-- pairing codes (0048): the plaintext is shown once at creation, so a database
-- read can never yield a usable link.
--
-- No email is sent (there is still no mail transport in this system; see the
-- note at the top of 0022), so the operator copies the link. It is single-use
-- and expires, which is what makes handing it over safe.
-- ============================================================================

CREATE TABLE owner_activations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The global login identity this activation will set a password on.
    platform_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    -- The owner's membership in this business, for the audit trail and so the
    -- activation can name the business the person is being let into.
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email            citext NOT NULL,
    token_hash       text NOT NULL UNIQUE,
    expires_at       timestamptz NOT NULL,
    accepted_at      timestamptz,
    revoked_at       timestamptz,
    -- Which platform admin issued it. Kept after the fact: "who invited this
    -- owner in" is exactly the question asked when something looks wrong.
    created_by       uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_owner_activations_business
    ON owner_activations (business_id, created_at DESC);

-- At most one live activation per (business, person): re-issuing must replace
-- the pending link rather than leave two working ones, the same rule
-- invitations follow.
CREATE UNIQUE INDEX idx_owner_activations_pending
    ON owner_activations (business_id, platform_user_id)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Tenant-scoped table, so it takes the shape-1 policy in the migration that
-- creates it (CLAUDE.md). The public acceptance path runs bypassed, because
-- whoever is activating has no session and by definition no membership yet.
ALTER TABLE owner_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON owner_activations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE owner_activations IS
    'Single-use owner activation links. The plaintext token is never stored; redemption is where the owner sets their own password and receives their own MFA material, so no platform operator ever holds a permanent credential to a tenant.';
