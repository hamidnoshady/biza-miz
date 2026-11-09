-- Issue #900: ordered self-service history of reports created by one member.
CREATE INDEX marketing_touchpoints_self_history
  ON marketing_touchpoints (business_id, created_by, recorded_at DESC, id DESC)
  WHERE created_by IS NOT NULL;
