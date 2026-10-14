-- ============================================================================
-- 0209_ai_gateway_secret_cutover.sql — issue #757, gated plaintext-secret
-- removal after the encrypted-key backfill and production runtime verification.
--
-- This is intentionally a separate, forward-only migration from 0183. Before
-- applying it on any deployment with stored AI credentials, operators MUST:
--
--   1. run `npm run db:encrypt-ai-secrets` and then `--verify-only`;
--   2. deploy the ciphertext-only runtime with
--      `AI_GATEWAY_SECRET_CUTOVER_DEFER=true`, so the entrypoint starts the app
--      but leaves this migration pending;
--   3. verify ciphertext-backed runtime reads/probes on every deployment; and
--   4. rerun migrations with `AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true`.
--
-- The migration runner sets a session-local PostgreSQL flag only for step 4.
-- The database guard also refuses direct SQL execution without that flag when
-- any credential exists. This is an operational confirmation, not a claim that
-- SQL can prove AES-GCM decryption; the backfill's decrypt verification remains
-- required. The migration also refuses any non-empty plaintext key without a
-- ciphertext twin.
--
-- Fresh installs with no stored credentials can apply this safely without a
-- confirmation flag. The runner's defer mode refuses to proceed to later
-- migrations while this cutover is pending.
-- ============================================================================

DO $$
DECLARE
    missing_master_ciphertext bigint;
    missing_virtual_key_ciphertext bigint;
    stored_secret_count bigint;
BEGIN
    SELECT count(*)
      INTO missing_master_ciphertext
      FROM platform_ai_gateway
     WHERE NULLIF(btrim(master_key), '') IS NOT NULL
       AND NULLIF(btrim(master_key_ciphertext), '') IS NULL;

    SELECT count(*)
      INTO missing_virtual_key_ciphertext
      FROM ai_business_gateway
     WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL
       AND NULLIF(btrim(virtual_key_ciphertext), '') IS NULL;

    IF missing_master_ciphertext > 0 OR missing_virtual_key_ciphertext > 0 THEN
        RAISE EXCEPTION
          'ai_gateway_secret_backfill_required: % platform master key(s), % business virtual key(s) lack ciphertext; run npm run db:encrypt-ai-secrets and verify before retrying migration 0209',
          missing_master_ciphertext,
          missing_virtual_key_ciphertext;
    END IF;

    SELECT
       (SELECT count(*) FROM platform_ai_gateway
         WHERE NULLIF(btrim(master_key), '') IS NOT NULL
            OR NULLIF(btrim(master_key_ciphertext), '') IS NOT NULL)
       +
       (SELECT count(*) FROM ai_business_gateway
         WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL
            OR NULLIF(btrim(virtual_key_ciphertext), '') IS NOT NULL)
      INTO stored_secret_count;

    IF stored_secret_count > 0
       AND current_setting('app.ai_gateway_secret_cutover_verified', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION
          'ai_gateway_secret_runtime_verification_required: verify ciphertext-backed runtime reads on every deployment, then rerun migrations with AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true';
    END IF;
END $$;

ALTER TABLE platform_ai_gateway
    DROP COLUMN IF EXISTS master_key;

ALTER TABLE ai_business_gateway
    DROP COLUMN IF EXISTS virtual_key;
