-- ============================================================================
-- 0183_ai_gateway_hardening.sql — issue #748: correctness/security audit of
-- the /platform/ai LiteLLM administration surface.
--
-- Two independent hardening changes, both additive and safe on a fresh
-- install and on an upgraded one:
--
-- 1. Secrets at rest. `platform_ai_gateway.master_key` and
--    `ai_business_gateway.virtual_key` are live bearer credentials stored in
--    the clear. `src/lib/integrations/secrets.ts` already provides
--    AES-256-GCM envelopes for exactly this shape of platform-scope secret
--    (see `platform_cms_config.api_key_ciphertext`, migration 0139). This
--    migration adds the `*_ciphertext` twin to each table; the plaintext
--    column is deliberately NOT dropped here.
--
--    The cutover is staged on purpose:
--      a. this migration adds the nullable ciphertext column (safe: no
--         existing reader/writer even looks at it yet);
--      b. the application (ai-gateway-service.ts) is deployed to read the
--         ciphertext column first, falling back to the legacy plaintext
--         column, and to only ever WRITE the ciphertext column from here on;
--      c. an operator runs `npm run db:encrypt-ai-secrets` once to backfill
--         every existing plaintext value into its ciphertext twin;
--      d. only after (c) is verified does a follow-up migration drop the
--         plaintext columns. Dropping them in the same migration that adds
--         the ciphertext columns would brick step (b) on any deployment that
--         applies migrations and deploys code in separate steps.
--
-- 2. Business/branch referential integrity. `ai_business_gateway.location_id`
--    already has a simple FK to `locations(id)`, but nothing stopped a branch
--    key row (or a future bad write) from pointing at a location that belongs
--    to a DIFFERENT business than the row's own `business_id`. The
--    `locations_id_business_unique` + composite FK pair is the same idiom
--    already used for `employees`, `api_keys`, `tenant_roles`, … — see
--    migrations/0171_tenant_custom_roles.sql for the most recent example —
--    and turns "an invalid business/location pair cannot be persisted" from
--    an application-level promise into a database-level one.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Secrets at rest — ciphertext columns, plaintext kept for the transition.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_ai_gateway
    ADD COLUMN IF NOT EXISTS master_key_ciphertext text;

ALTER TABLE ai_business_gateway
    ADD COLUMN IF NOT EXISTS virtual_key_ciphertext text;

COMMENT ON COLUMN platform_ai_gateway.master_key IS
    'Deprecated plaintext credential, superseded by master_key_ciphertext (migration 0183). '
    'Read as a fallback only; never written by current code. Drop once db:encrypt-ai-secrets '
    'has been run against every deployment and the fallback read has been verified unused.';
COMMENT ON COLUMN ai_business_gateway.virtual_key IS
    'Deprecated plaintext credential, superseded by virtual_key_ciphertext (migration 0183). '
    'Read as a fallback only; never written by current code. Drop once db:encrypt-ai-secrets '
    'has been run against every deployment and the fallback read has been verified unused.';

-- ---------------------------------------------------------------------------
-- 2. Business/branch referential integrity.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'locations_id_business_unique'
           AND conrelid = 'locations'::regclass
    ) THEN
        ALTER TABLE locations ADD CONSTRAINT locations_id_business_unique UNIQUE (id, business_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ai_business_gateway_location_business_fk'
           AND conrelid = 'ai_business_gateway'::regclass
    ) THEN
        ALTER TABLE ai_business_gateway
            ADD CONSTRAINT ai_business_gateway_location_business_fk
                FOREIGN KEY (location_id, business_id)
                REFERENCES locations (id, business_id);
    END IF;
END $$;
