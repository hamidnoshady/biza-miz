-- 0222_export_job_audience.sql
--
-- Issue #947 (TEAM-F01, revisited) — the *stored* export file and the audience it was
-- produced for.
--
-- ---------------------------------------------------------------------------
-- 1. Why the projection needs provenance, not just a rule
-- ---------------------------------------------------------------------------
-- The first pass narrowed an export at the moment it was produced, from the requesting
-- member's effective permissions. That is not enough, and the reason is structural:
--
--   - the bytes live on the job row for `EXPORT_RETENTION_DAYS` and are re-downloadable
--     from the history;
--   - a PDF or a workbook cannot be re-projected field by field — the columns are
--     positional, the headers are Persian labels, and «blank the cell» is not something
--     a narrowing pass can do to a rendered document;
--   - the permission that produced the file can be revoked afterwards, and the reader
--     who asks for it again may simply be somebody else with the same bulk keys.
--
-- So a re-download has to answer one question — «was this file produced *under* a
-- sensitivity this caller can still read?» — and it can only answer it if the row
-- remembers what the file was produced under. `party_audience` is that memory: the two
-- booleans of `PartyReadAudience` (personnel / financial), written at production time by
-- whoever produced it. NULL means «produced before this column existed, or by a producer
-- with no requesting member» — legacy and internal files. Unknown provenance is NOT
-- treated as «narrow»: a legacy file was produced by the pre-#947 engine, which returned
-- the full record, so it is recorded and read as the widest audience. That is the
-- conservative answer in the only direction that matters — it refuses more, never fewer.
--
-- ---------------------------------------------------------------------------
-- 2. Two values, not a JSON blob
-- ---------------------------------------------------------------------------
-- `party_audience` holds the audience of the *party-shaped* half of a data-transfer
-- export, because that is the half with field-level permissions in this product. A
-- domain audience (`domain_keys`, below) does not belong in the same column: it is a
-- different question with a different answer shape, and mixing them would make «what may
-- this file show» a free-form document nobody can review.
--
-- `domain_keys` is the *set of permission keys* the production of a provider workbook
-- was checked against — the Holoo scope contract (`checkHolooExportScopePermissions`).
-- Stored as the keys themselves rather than a boolean, because the check that matters at
-- re-download is «does this caller still hold every key this file was produced under»,
-- and that question is answered by comparing sets.
--
-- ---------------------------------------------------------------------------
-- 3. Backfill
-- ---------------------------------------------------------------------------
-- Existing rows: `party_audience` is left NULL (see §1 — read as the wide audience, which
-- is what those files actually contain). `domain_keys` is backfilled for Holoo provider
-- jobs from their own `provider_metadata.selectedScopes`, using the same mapping the
-- guard uses, so a file that was produced against the persons scope is refused to a
-- caller who has since lost the key that scope needs. Legacy provider rows whose scopes
-- cannot be mapped keep NULL and are treated as the full set — again the conservative
-- direction, and identical to the behaviour they already had on re-download (the route
-- has always re-checked the provider scopes; this column only stops that check from
-- being reconstructible-only-from-metadata if the metadata shape ever changes).

ALTER TABLE data_export_jobs
    ADD COLUMN IF NOT EXISTS party_audience jsonb;

-- The permission keys the production was authorized against. NULL = «not recorded»
-- (legacy rows), which the download path treats as «re-check everything the contract
-- requires today» rather than as «nothing was checked».
ALTER TABLE data_export_jobs
    ADD COLUMN IF NOT EXISTS domain_keys text[];

COMMENT ON COLUMN data_export_jobs.party_audience IS
    'Issue #947: PartyReadAudience ({personnel, financial}) the file was produced under. NULL = legacy/internal, read as the widest audience.';
COMMENT ON COLUMN data_export_jobs.domain_keys IS
    'Issue #947: permission keys the production was authorized against (provider scopes). NULL = not recorded.';

-- Keep the column honest about its shape: a JSON object with two booleans, or NULL.
ALTER TABLE data_export_jobs
    ADD CONSTRAINT data_export_jobs_party_audience_shape
    CHECK (
        party_audience IS NULL
        OR (
            jsonb_typeof(party_audience) = 'object'
            AND (party_audience ? 'personnel')
            AND (party_audience ? 'financial')
            AND jsonb_typeof(party_audience -> 'personnel') = 'boolean'
            AND jsonb_typeof(party_audience -> 'financial') = 'boolean'
        )
    );

-- ---------------------------------------------------------------------------
-- 4. Backfill the two provider scopes that carry party fields
-- ---------------------------------------------------------------------------
-- `persons` is the scope whose rows are `parties` rows plus `suppliers`; it needs
-- `parties.view` + `crm.export` + `purchases.manage` (see
-- `exportRequirementsFor` in `src/app/api/data/providers/holoo/guard.ts`). Recording the
-- two party-relevant keys is enough to make a later revocation effective, and it is
-- deliberately not attempted for scope shapes this migration cannot map — those rows
-- keep NULL.
UPDATE data_export_jobs
   SET domain_keys = ARRAY['parties.view', 'crm.export', 'purchases.manage']::text[]
 WHERE domain_keys IS NULL
   AND provider_metadata IS NOT NULL
   AND provider_metadata ->> 'provider' = 'holoo'
   AND provider_metadata -> 'selectedScopes' ? 'persons';

-- Provider jobs that never touched the persons scope have nothing party-shaped in them;
-- record the empty set explicitly so the download path can tell «checked, nothing
-- needed» apart from «not recorded».
UPDATE data_export_jobs
   SET domain_keys = ARRAY[]::text[]
 WHERE domain_keys IS NULL
   AND provider_metadata IS NOT NULL
   AND provider_metadata ->> 'provider' = 'holoo'
   AND NOT (provider_metadata -> 'selectedScopes' ? 'persons');
