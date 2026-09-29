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
-- **The link alone is deliberately not enough.** There is no mail transport in
-- this system (see the note at the top of 0022), so the operator is the one who
-- carries the token — which would make the whole exercise theatre if the token
-- were sufficient on its own: the operator could redeem their own link, choose a
-- password, collect the recovery codes and keep permanent access to the tenant.
-- Redemption therefore also requires a one-time code texted to the *owner's*
-- mobile (the number the operator typed, which is a channel only the owner
-- reads). The operator can request that code; they cannot see it. So the two
-- halves have to be held by two different people, and the handover is real.
--
-- That is what `code_hash` and friends are for: an HMAC of the code with the
-- platform realm secret, its expiry and an attempt counter, on the activation
-- row itself rather than in `mfa_challenges` (which belongs to the login path
-- and is read by the login interstitial — an activation code must never be
-- presentable as a login OTP).
--
-- Only the token's sha-256 is stored — the same rule as invitations (0022) and
-- pairing codes (0048): the plaintext is shown once at creation, so a database
-- read can never yield a usable link. The code is never stored in the clear
-- either.
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
    -- The proof that the person redeeming this holds the owner's phone: an HMAC
    -- of a six-digit code, its expiry and how many tries it has had. Null until
    -- an operator (or the owner) asks for a code to be sent.
    code_hash        text,
    code_expires_at  timestamptz,
    code_attempts    integer NOT NULL DEFAULT 0,
    code_sent_at     timestamptz,
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
    'Single-use owner activation links. The plaintext token is never stored, and the link is inert without a one-time code sent to the owner''s own mobile — redemption is where the owner sets their own password and receives their own MFA material, so no platform operator can obtain a permanent credential to a tenant.';
