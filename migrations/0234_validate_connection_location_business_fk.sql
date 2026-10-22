-- #934 / #1037: 0233 starts enforcing tenant/location ownership for new
-- assignments, but an unvalidated FK makes every subsequent full backup fail
-- validateRestoredDb (restore_contains_unvalidated_foreign_keys).
-- Keep the applied 0233 checksum immutable and complete validation here.
-- Fail closed on inconsistent historical assignments: an operator must repair
-- them deliberately before retrying; never discard connections or audit rows,
-- silently change their branch, or weaken the restore integrity check.
ALTER TABLE integration_connections
  VALIDATE CONSTRAINT integration_connections_location_business_fk;
