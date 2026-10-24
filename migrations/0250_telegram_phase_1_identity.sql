-- Issue #976, Phase 1 — one centrally managed Biza Miz Telegram identity
-- link, durable webhook inbox, replay protection, and account-link challenges.
--
-- Platform identities, Telegram IDs, challenges and initData replay records
-- are global authentication artifacts. They deliberately carry no tenant
-- session cookie or business data and are visible only inside the narrow
-- telegram-identity-auth bypass (documented in src/lib/db.ts). The browser
-- challenge is tenant-owned and receives normal forced RLS in this migration.

CREATE TABLE telegram_identity_links (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_user_id    uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    telegram_user_id    bigint NOT NULL CHECK (telegram_user_id > 0),
    generation          integer NOT NULL DEFAULT 1 CHECK (generation > 0),
    linked_at           timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz,
    provenance          text NOT NULL DEFAULT 'browser_challenge'
                        CHECK (provenance = 'browser_challenge')
);

-- Historical revoked links remain for audit; only current bindings are unique.
CREATE UNIQUE INDEX telegram_identity_links_active_platform_user
    ON telegram_identity_links (platform_user_id)
    WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX telegram_identity_links_active_telegram_user
    ON telegram_identity_links (telegram_user_id)
    WHERE revoked_at IS NULL;
CREATE INDEX telegram_identity_links_platform_history
    ON telegram_identity_links (platform_user_id, linked_at DESC);

ALTER TABLE telegram_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_identity_links FORCE ROW LEVEL SECURITY;
CREATE POLICY telegram_identity_auth_only ON telegram_identity_links FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

CREATE TABLE telegram_link_challenges (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    membership_id       uuid NOT NULL,
    platform_user_id    uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    employee_session_id uuid NOT NULL REFERENCES employee_sessions(id) ON DELETE CASCADE,
    token_hash          char(64) NOT NULL UNIQUE,
    token_version       integer NOT NULL CHECK (token_version >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    consumed_at         timestamptz,
    consumed_by_link_id uuid REFERENCES telegram_identity_links(id) ON DELETE SET NULL,
    CONSTRAINT telegram_link_challenges_expiry CHECK (expires_at > created_at),
    CONSTRAINT telegram_link_challenges_membership_same_business
        FOREIGN KEY (business_id, membership_id)
        REFERENCES users (business_id, id) ON DELETE CASCADE
);
CREATE INDEX telegram_link_challenges_member_recent
    ON telegram_link_challenges (business_id, membership_id, created_at DESC);
CREATE INDEX telegram_link_challenges_expiry
    ON telegram_link_challenges (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE telegram_link_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_link_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telegram_link_challenges FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Keep hashes, not raw initData. Telegram's auth_date makes every accepted
-- payload short-lived; this unique hash makes each signed payload single-use.
CREATE TABLE telegram_init_data_replays (
    init_data_hash      char(64) PRIMARY KEY,
    telegram_user_id    bigint NOT NULL CHECK (telegram_user_id > 0),
    link_id             uuid NOT NULL REFERENCES telegram_identity_links(id) ON DELETE CASCADE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL
);
CREATE INDEX telegram_init_data_replays_expiry
    ON telegram_init_data_replays (expires_at);

ALTER TABLE telegram_init_data_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_init_data_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY telegram_identity_auth_only ON telegram_init_data_replays FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- The inbox is the webhook's durable, idempotent work queue. Processing is
-- bounded and synchronous in Phase 1; failed deliveries and expired worker
-- leases may be reclaimed when Telegram retries the same update.
CREATE TABLE telegram_webhook_updates (
    update_id               bigint PRIMARY KEY,
    status                  text NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
    attempt_count           integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    processing_started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at             timestamptz,
    last_error_code         varchar(64),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_webhook_updates_retention
    ON telegram_webhook_updates (created_at) WHERE status IN ('processed', 'failed');
CREATE INDEX telegram_webhook_updates_stuck_processing
    ON telegram_webhook_updates (processing_started_at) WHERE status = 'processing';

ALTER TABLE telegram_webhook_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_webhook_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY telegram_identity_auth_only ON telegram_webhook_updates FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- Telegram is a first-party login door, but remains a login method on the
-- existing revocable employee-session contract (never a parallel session).
ALTER TABLE employee_sessions DROP CONSTRAINT employee_sessions_login_method_check;
ALTER TABLE employee_sessions ADD CONSTRAINT employee_sessions_login_method_check
  CHECK (login_method IS NULL OR login_method IN (
    'password', 'phone_otp', 'pin', 'webauthn', 'invitation', 'impersonation',
    'business_switch', 'setup', 'desktop_handoff', 'company_handoff',
    'cloud_account', 'telegram'
  ));

-- MFA-code attempts from Telegram-primary login share the existing lockout
-- service and account identity key, with their own realm to avoid conflating
-- the password door's audit/lockout history.
ALTER TABLE auth_login_attempts DROP CONSTRAINT auth_login_attempts_realm_check;
ALTER TABLE auth_login_attempts ADD CONSTRAINT auth_login_attempts_realm_check
  CHECK (realm IN ('tenant_password','platform_admin','directory','mfa_challenge','phone_otp','tenant_telegram'));

COMMENT ON TABLE telegram_identity_links IS
    'Global link from one Telegram numeric user id to an existing platform_users identity. Access is restricted by FORCE RLS to the telegram-identity-auth service boundary.';
COMMENT ON TABLE telegram_link_challenges IS
    'Tenant-scoped, short-lived hashed browser-to-Telegram account-link state, bound to the initiating membership, global identity and live employee session.';
COMMENT ON TABLE telegram_init_data_replays IS
    'Global one-time hashes of Telegram Web App initData; raw signed payloads are never persisted.';
COMMENT ON TABLE telegram_webhook_updates IS
    'Global bounded/idempotent Telegram webhook inbox; stores update ids and safe error codes, never update bodies or message content.';
