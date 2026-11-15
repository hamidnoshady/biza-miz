-- Narrow the same-branch exact-label candidate review, including archived sites.
CREATE INDEX marketing_targets_duplicate_review ON marketing_targets
  (business_id, location_id, lower(btrim(site_label)), id);
