-- Corrective migration for print_jobs historical provenance (issue #815).
--
-- Why this exists:
--   An earlier revision of 0222_print_jobs_diagnostics_and_fallback.sql on the
--   feature branch backfilled `attempt_number = 2`, `previous_job_id`,
--   `route_reason = 'runtime_fallback'`, and `fallback_from_printer_*` whenever
--   two rows in the same location shared `print_request_id`. Because
--   `print_request_id` is derived from the document identity (e.g.
--   `receipt:{orderId}`) and is legitimately reused for intentional manual
--   reprints, that inference falsely linked reprints as fallback attempts.
--
--   This forward corrective migration repairs any database that ran the earlier
--   0222 revision while remaining idempotent on fresh databases:
--     1. Permits `route_reason = 'unknown'` and sets `'unknown'` as the column
--        default for rows whose routing origin was not explicitly recorded.
--     2. Resets any fallback linkage (`attempt_number`, `previous_job_id`,
--        `route_reason`, `fallback_from_printer_*`) that is not backed by a
--        valid parent attempt in the same branch with matching document,
--        confirmed pre-handoff non-delivery (`not_delivered`), distinct target
--        printer, and durable `render_snapshot` on both parent and child rows.
--     3. Sets `route_reason = 'unknown'` on pre-0222 historical rows where
--        neither `render_snapshot` nor `template_source` was recorded.

ALTER TABLE print_jobs ALTER COLUMN route_reason SET DEFAULT 'unknown';

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_route_reason_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_route_reason_check
  CHECK (route_reason IN ('explicit', 'rule', 'fallback', 'runtime_fallback', 'default', 'only', 'none', 'unknown'));

-- Reset any fallback linkage that does not have proven parent attempt and
-- immutable snapshot evidence. Legitimate runtime fallback rows created by the
-- server-validated fallback reservation path (with valid parent attempt 1,
-- confirmed `not_delivered`, distinct printer, and `render_snapshot`) are
-- preserved untouched.
UPDATE print_jobs j
   SET attempt_number = 1,
       previous_job_id = NULL,
       route_reason = CASE WHEN j.render_snapshot IS NULL AND j.template_source IS NULL THEN 'unknown' ELSE 'rule' END,
       fallback_from_printer_id = NULL,
       fallback_from_printer_name = NULL
 WHERE (j.attempt_number > 1 OR j.previous_job_id IS NOT NULL OR j.route_reason = 'runtime_fallback')
   AND NOT EXISTS (
     SELECT 1
       FROM print_jobs p
      WHERE p.id = j.previous_job_id
        AND p.location_id = j.location_id
        AND p.document_type = j.document_type
        AND p.entity_id IS NOT DISTINCT FROM j.entity_id
        AND p.attempt_number = 1
        AND p.previous_job_id IS NULL
        AND p.printer_id IS NOT NULL
        AND j.printer_id IS NOT NULL
        AND p.printer_id <> j.printer_id
        AND p.status = 'failed'
        AND p.delivery_outcome = 'not_delivered'
        AND p.error_code IN (
          'printer_offline',
          'printer_not_found',
          'network_unreachable',
          'spooler_rejected',
          'printer_inactive',
          'reconnect_required',
          'invalid_printer',
          'incompatible_printer',
          'render_failed'
        )
        AND p.render_snapshot IS NOT NULL
        AND j.render_snapshot IS NOT NULL
   );

-- Pre-0222 rows that had neither `render_snapshot` nor `template_source`
-- recorded did not store their routing reason; mark their provenance `'unknown'`
-- instead of assuming `'rule'`.
UPDATE print_jobs
   SET route_reason = 'unknown'
 WHERE render_snapshot IS NULL
   AND previous_job_id IS NULL
   AND template_source IS NULL
   AND route_reason = 'rule';
