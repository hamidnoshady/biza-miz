-- Issue #1296 — the cloud half of the whole-platform backup: leases, attempt
-- bookkeeping, per-artifact remote proof, and honest report of local gaps.
--
-- What went wrong in production was not one bug but three unobservable states:
--
--   * a `running` row with no deadline. The catch-up read it as "in flight" and
--     returned, so a worker that died mid-upload suppressed every later attempt
--     for the artifact — forever, and invisibly.
--   * a failure recorded only as free text ("…NetworkError"), with no attempt
--     number, no classification and no next-due time, so the console could not
--     say whether retrying was even expected to happen.
--   * no link at all between "the artifact I captured at 06:04" and "the object
--     confirmed in the bucket". An old 2.84 MB object from September kept a
--     green cloud line while the newest 319 MB artifact was local-only.
--
-- This migration adds exactly those three, next to what already exists, so old
-- rows keep working (every new column is nullable or has a default that means
-- "we never knew"). Nothing is deleted, nothing is rewritten: the historic
-- object stays where it is and simply stops being readable as "the latest".
--
-- `platform_backup_runs` is a platform-realm table (no business_id, reachable
-- only from the super-admin console), so it carries no tenant RLS policy —
-- unchanged by this file. The confirmation columns live on the *local* run row
-- because that row is the artifact's identity: one local capture, at most one
-- confirmed remote copy, and the comparison between the two is the invariant.

-- ---------------------------------------------------------------------------
-- 1. Attempt/lease bookkeeping on a run row
-- ---------------------------------------------------------------------------
ALTER TABLE platform_backup_runs
    -- 1-based: the same artifact may be attempted many times (retries, a
    -- reclaimed lease, a manual re-run). Old rows were the first attempt.
    ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1
        CHECK (attempt BETWEEN 1 AND 1000),
    -- The stage the attempt reached, as a short provider-neutral code
    -- (preparing, hashing, encrypting, uploading, verifying, pruning). Free
    -- text on purpose: it is a diagnostic breadcrumb, not an enum the code
    -- must migrate when a stage is added.
    ADD COLUMN IF NOT EXISTS attempt_phase text,
    -- While a `running` row holds this, its owner is believed alive. Renewed by
    -- the uploader's progress reports; past it another instance may reclaim the
    -- attempt. NULL on historic rows means "started_at + the default lease".
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
    -- Redacted structured diagnostics (transport code chain, HTTP status class,
    -- retry delay, whether the failure was classified as transient). Never a
    -- key, a header, a signed URL or a body — see `describeTransportFailure`.
    ADD COLUMN IF NOT EXISTS diagnostics jsonb;

-- Every cloud decision is "the latest attempt for this artifact", and every
-- recovery scan is "running rows whose lease has passed".
CREATE INDEX IF NOT EXISTS idx_platform_backup_runs_artifact
    ON platform_backup_runs (kind, artifact, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_backup_runs_running_lease
    ON platform_backup_runs (lease_expires_at)
 WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- 2. Per-artifact proof that the newest local capture is off-site
-- ---------------------------------------------------------------------------
ALTER TABLE platform_backup_runs
    -- The exact object the provider listed for this artifact. Kept separate
    -- from `cloud_key` (which the upload marks optimistically) so "we asked for
    -- this key" and "the provider showed us this key" can never be confused.
    ADD COLUMN IF NOT EXISTS cloud_verified_key text,
    ADD COLUMN IF NOT EXISTS cloud_verified_at timestamptz,
    -- 'size' = a HEAD after the upload matched the bytes we meant to send.
    -- 'sha256' = a re-download hashed and compared. There is deliberately no
    -- 'etag' mode: providers disagree about what an ETag hashes, so it is never
    -- accepted as proof.
    ADD COLUMN IF NOT EXISTS cloud_verify_mode text
        CHECK (cloud_verify_mode IS NULL OR cloud_verify_mode IN ('size', 'sha256')),
    ADD COLUMN IF NOT EXISTS cloud_verified_size bigint
        CHECK (cloud_verified_size IS NULL OR cloud_verified_size >= 0),
    ADD COLUMN IF NOT EXISTS cloud_verified_sha256 text;

-- ---------------------------------------------------------------------------
-- 3. A locally missing artifact is a fact, recorded once
-- ---------------------------------------------------------------------------
-- The issue's fourth defect: a run whose file has been pruned or lost was
-- retried on every tick with `ENOENT`, in a tight loop, telling nobody. Once the
-- file's absence has been proven this records when, so the retry loop can stop
-- and the console can say «روی دیسک نیست» instead of a permanent error.
ALTER TABLE platform_backup_runs
    ADD COLUMN IF NOT EXISTS local_missing_since timestamptz;

COMMENT ON COLUMN platform_backup_runs.attempt_phase IS
    'Issue #1296: provider-neutral stage code of the last attempt (preparing, hashing, encrypting, uploading, verifying, pruning).';
COMMENT ON COLUMN platform_backup_runs.lease_expires_at IS
    'Issue #1296: while a running row holds a future lease its owner is alive; past it the attempt is reclaimable.';
COMMENT ON COLUMN platform_backup_runs.cloud_verified_at IS
    'Issue #1296: when the provider was observed holding this artifact at cloud_verified_key. NULL means unproven, not protected.';
COMMENT ON COLUMN platform_backup_runs.local_missing_since IS
    'Issue #1296: absence of the local file was proven at this time; stop retrying it as a transient failure.';
