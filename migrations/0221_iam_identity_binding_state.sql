-- Issue #948 P0-1/P1-6 — make the *identity binding* observable, separately
-- from "credential data arrived".
--
-- The credential plane can look converged (every hash matches) while a
-- membership is bound to the wrong local `platform_users` row: the pre-v2
-- replication minted local UUIDs the cloud never knew, and the fingerprint
-- ignored the global identity ID, so nothing noticed. These columns record
-- what the last reconciliation saw and fixed:
--
--   identity_mismatches  — bindings the payload named that are *still*
--                          wrong/missing after the pass, plus identity email
--                          conflicts left for manual review. Zero is the only
--                          value that may read green;
--   identity_rekeys      — pre-v2 local UUIDs migrated onto the canonical
--                          cloud global identity ID (contract v2);
--   identity_contract    — 'canonical' (payload names global identity IDs) or
--                          'legacy' (older cloud without them) or NULL.
--
-- "Healthy" must never be reported from credential hashes alone: the health
-- resolver reads `missing_identity_bindings` and these counts next to them.
ALTER TABLE iam_login_credential_sync_state
  ADD COLUMN IF NOT EXISTS identity_mismatches integer NOT NULL DEFAULT 0 CHECK (identity_mismatches >= 0),
  ADD COLUMN IF NOT EXISTS identity_rekeys integer NOT NULL DEFAULT 0 CHECK (identity_rekeys >= 0),
  ADD COLUMN IF NOT EXISTS identity_contract text CHECK (identity_contract IN ('canonical', 'legacy'));
