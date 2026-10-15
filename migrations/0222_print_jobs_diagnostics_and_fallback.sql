-- Durable diagnostics, attempt linkage, delivery outcome classification, and
-- immutable fallback render snapshots on print_jobs (issue #815).
--
-- Why this exists:
--   1. Delivery safety & diagnostics: every print attempt records its attempt
--      number (1 or 2), optional parent attempt (`previous_job_id`), routing
--      reason (`route_reason`), primary/fallback printer provenance
--      (`printer_name`, `fallback_from_printer_id`, `fallback_from_printer_name`),
--      exact template metadata (`template_name`, `template_paper`,
--      `template_source`), and canonical `delivery_outcome` ('pending',
--      'handed_off', 'not_delivered', 'ambiguous', 'connector_unavailable') so
--      spooler handoff is never conflated with confirmed physical paper output
--      and ambiguous deliveries are never automatically retried.
--   2. Immutable fallback: attempt 1 persists `render_snapshot` (the resolved
--      document payload, template revision, paper, and branding) so a single
--      server-validated fallback attempt (attempt 2) renders the exact same
--      inputs without silently reloading concurrently modified orders, items,
--      templates, or branding from the database.

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS attempt_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS previous_job_id uuid REFERENCES print_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS route_reason text NOT NULL DEFAULT 'rule',
  ADD COLUMN IF NOT EXISTS delivery_outcome text,
  ADD COLUMN IF NOT EXISTS printer_name text,
  ADD COLUMN IF NOT EXISTS fallback_from_printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fallback_from_printer_name text,
  ADD COLUMN IF NOT EXISTS template_name text,
  ADD COLUMN IF NOT EXISTS template_paper text,
  ADD COLUMN IF NOT EXISTS template_source text,
  ADD COLUMN IF NOT EXISTS render_snapshot jsonb;

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_attempt_number_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_attempt_number_check
  CHECK (attempt_number IN (1, 2));

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_route_reason_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_route_reason_check
  CHECK (route_reason IN ('explicit', 'rule', 'fallback', 'runtime_fallback', 'default', 'only', 'none'));

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_delivery_outcome_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_delivery_outcome_check
  CHECK (
    delivery_outcome IS NULL
    OR delivery_outcome IN ('pending', 'handed_off', 'not_delivered', 'ambiguous', 'connector_unavailable')
  );

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_template_source_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_template_source_check
  CHECK (
    template_source IS NULL
    OR template_source IN ('explicit', 'rule', 'default', 'printer', 'builtin')
  );

-- Backfill printer_name and template_name for pre-0222 rows whose referenced
-- printer or template still exists in the same location.
UPDATE print_jobs j
   SET printer_name = p.name
  FROM printers p
 WHERE j.printer_name IS NULL
   AND j.printer_id = p.id
   AND j.location_id = p.location_id;

UPDATE print_jobs j
   SET template_name = t.name
  FROM print_templates t
 WHERE j.template_name IS NULL
   AND j.template_id = t.id
   AND j.location_id = t.location_id;

-- Backfill delivery_outcome from existing status and error_code values.
UPDATE print_jobs
   SET delivery_outcome = CASE
     WHEN status = 'handed_off' THEN 'handed_off'
     WHEN status = 'failed' AND error_code IN (
       'connector_not_installed',
       'connector_outdated',
       'connector_unreachable',
       'not_in_browser'
     ) THEN 'connector_unavailable'
     WHEN status = 'failed' AND error_code IN (
       'printer_offline',
       'printer_not_found',
       'network_unreachable',
       'spooler_rejected',
       'printer_inactive',
       'reconnect_required',
       'invalid_printer',
       'incompatible_printer',
       'render_failed'
     ) THEN 'not_delivered'
     WHEN status = 'failed' THEN 'ambiguous'
     ELSE 'pending'
   END
 WHERE delivery_outcome IS NULL;

-- Link pre-0222 two-attempt sequences that shared (location_id, print_request_id).
WITH ranked AS (
  SELECT id,
         location_id,
         print_request_id,
         printer_id,
         printer_name,
         ROW_NUMBER() OVER (
           PARTITION BY location_id, print_request_id
           ORDER BY created_at ASC, id ASC
         ) AS rn,
         LAG(id) OVER (
           PARTITION BY location_id, print_request_id
           ORDER BY created_at ASC, id ASC
         ) AS prev_id,
         LAG(printer_id) OVER (
           PARTITION BY location_id, print_request_id
           ORDER BY created_at ASC, id ASC
         ) AS prev_printer_id,
         LAG(printer_name) OVER (
           PARTITION BY location_id, print_request_id
           ORDER BY created_at ASC, id ASC
         ) AS prev_printer_name
    FROM print_jobs
   WHERE print_request_id IS NOT NULL
)
UPDATE print_jobs j
   SET attempt_number = 2,
       previous_job_id = COALESCE(j.previous_job_id, ranked.prev_id),
       route_reason = CASE WHEN j.route_reason = 'rule' THEN 'runtime_fallback' ELSE j.route_reason END,
       fallback_from_printer_id = COALESCE(j.fallback_from_printer_id, ranked.prev_printer_id),
       fallback_from_printer_name = COALESCE(j.fallback_from_printer_name, ranked.prev_printer_name)
  FROM ranked
 WHERE j.id = ranked.id
   AND ranked.rn = 2
   AND j.attempt_number = 1;

-- Enforce at most one fallback attempt per primary job row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_unique_previous_job
  ON print_jobs (previous_job_id)
  WHERE previous_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_print_jobs_location_request_attempt
  ON print_jobs (location_id, print_request_id, attempt_number)
  WHERE print_request_id IS NOT NULL;
