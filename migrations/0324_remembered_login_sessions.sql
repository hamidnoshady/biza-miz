-- #1585 — persistent remembered-login authorization.
--
-- Three authorities stay separate kinds of thing, and this migration adds only
-- the third one:
--
--   A. the short-lived signed access session      (employee_sessions + the JWT)
--   B. the seven-day trusted-device MFA exemption (trusted_devices, migration 0215)
--   C. this: a server-managed, renewable remembered-login authorization.
--
-- A trust row waives a routine factor and authorises nothing; a session row is
-- the thing every request is checked against. C is neither: it is a *refresh*
-- authority whose only power is to mint a fresh A after the server re-validates
-- identity, membership, token version and risk. It can never resurrect a
-- revoked session, never raise an assurance level and never outlive its hard
-- deadline.
--
-- Two tables, because they answer different questions:
--
--   remembered_login_families   — the authorization: who, which tenant, which
--                                 device context, when it dies, whether it is
--                                 revoked. One row per remembered browser.
--   remembered_login_credentials— the rotation chain: one row per issued
--                                 secret, so a replayed (already superseded)
--                                 secret is recognisable as a replay rather
--                                 than as an unknown value. Only the HMAC of a
--                                 secret is ever stored.
--
-- A single row holding "current hash" cannot tell a stolen-token replay from a
-- garbage token, and that distinction is the whole anti-replay rule. Keeping
-- the chain is what makes it decidable.

CREATE TABLE remembered_login_families (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The tenant the authorization is bound to. A session is only ever minted
    -- for this business; the refresh path re-reads the membership before it
    -- rotates, and a family whose membership is gone is revoked.
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The membership (`users.id`) the authorization belongs to.
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The global identity behind the membership, when it has one. Platform
    -- revocation (password reset, disable, lockout) reaches a site through
    -- this, exactly as it does for trusted devices.
    platform_user_id      uuid REFERENCES platform_users(id) ON DELETE CASCADE,
    -- `platform_users.token_version` as it stood when this family was issued.
    -- A renewal re-reads the live value and refuses when it has moved: a
    -- password change, reset or global sign-out bumps it, so a family that
    -- survived an event that should have ended it still cannot mint a session.
    -- NULL for a membership with no global identity, and for rows issued before
    -- this column existed (treated as "not recorded", never as a mismatch).
    platform_token_version integer,
    -- The door that earned it. Diagnostics and the device list only.
    login_method          text,
    -- Assurance carried by the family. These are *copied* into every session
    -- this family mints and are never raised by a refresh: a renewal that
    -- silently upgraded them would make a routine SMS login into strong
    -- authentication for sensitive actions (#1386).
    mfa_verified          boolean NOT NULL DEFAULT false,
    otp_only_assurance    boolean NOT NULL DEFAULT false,
    -- The instant the human actually authenticated (the login that minted the
    -- family). A refresh must not move it: `recentAuthAt` on a renewed session
    -- stays this value, so "recent" keeps meaning "recently proved who you are"
    -- and not "recently asked the server to renew".
    authenticated_at      timestamptz NOT NULL,
    -- Privacy-minimised context. Coarse families only — never a fingerprint,
    -- never a raw user-agent, never an IP address. Used to decide whether a
    -- renewal is silent or needs a step-up; never as possession proof.
    device_label          text,
    browser_family        text,
    os_family             text,
    region_hint           text,
    issued_at             timestamptz NOT NULL DEFAULT now(),
    last_used_at          timestamptz,
    -- Both deadlines are enforced. `idle_expires_at` rolls forward on each
    -- rotation; `absolute_expires_at` never does.
    idle_expires_at       timestamptz NOT NULL,
    absolute_expires_at   timestamptz NOT NULL,
    revoked_at            timestamptz,
    revoked_reason        text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT remembered_login_families_lifetimes CHECK (
        idle_expires_at <= absolute_expires_at
    )
);

CREATE TABLE remembered_login_credentials (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id      uuid NOT NULL REFERENCES remembered_login_families(id) ON DELETE CASCADE,
    -- Denormalised so RLS protects this table directly, without a join the
    -- policy engine would have to resolve per row.
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- HMAC-SHA256 of the opaque secret. The secret itself exists only in the
    -- response that minted it and in the browser's HttpOnly cookie.
    token_hash     text NOT NULL,
    generation     integer NOT NULL DEFAULT 1,
    issued_at      timestamptz NOT NULL DEFAULT now(),
    -- Set when this credential is rotated away. A presented credential whose
    -- `superseded_at` is already set is a replay candidate: within the short
    -- concurrency grace it is a second tab of the same browser, outside it is
    -- a stolen token and the family is revoked.
    superseded_at  timestamptz,
    superseded_reason text,
    CONSTRAINT remembered_login_credentials_generation UNIQUE (family_id, generation)
);

-- One digest names exactly one credential, globally. The digest is of a
-- 256-bit secret, so a unique index cannot be used to enumerate anything.
CREATE UNIQUE INDEX idx_remembered_login_credentials_token
    ON remembered_login_credentials (token_hash);

-- Rotation walks the chain for one family.
CREATE INDEX idx_remembered_login_credentials_family
    ON remembered_login_credentials (family_id, generation DESC);

-- The device list: one member's remembered browsers in one business.
CREATE INDEX idx_remembered_login_families_member
    ON remembered_login_families (business_id, user_id, issued_at DESC);

-- Revoking everything a global identity earned, in one statement.
CREATE INDEX idx_remembered_login_families_platform_user
    ON remembered_login_families (platform_user_id)
    WHERE platform_user_id IS NOT NULL;

-- Expiry sweeps and the "is anything still renewable" cleanup query.
CREATE INDEX idx_remembered_login_families_expiry
    ON remembered_login_families (absolute_expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_remembered_login_credentials_superseded
    ON remembered_login_credentials (superseded_at)
    WHERE superseded_at IS NOT NULL;

-- Tenant isolation, in the same migration that creates the tables. Both are
-- tenant-scoped: a family belongs to one business, and its credentials carry
-- that business so the policy needs no join.
ALTER TABLE remembered_login_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE remembered_login_families FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remembered_login_families FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE remembered_login_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE remembered_login_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remembered_login_credentials FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE remembered_login_families IS
    'Issue #1585 — server-managed persistent login authorization. Not a session and not an MFA exemption.';
COMMENT ON TABLE remembered_login_credentials IS
    'Issue #1585 — rotation chain for one remembered-login family. Only the HMAC of each secret is stored.';
