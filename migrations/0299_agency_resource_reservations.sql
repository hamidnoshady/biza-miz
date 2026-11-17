-- Planned resource reservations; never actual time, payroll, billing or ledger facts.
CREATE TABLE agency_resource_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES ai_projects(id) ON DELETE RESTRICT,
 task_id uuid NOT NULL REFERENCES ai_project_tasks(id) ON DELETE RESTRICT,
 worker_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('reserved','cancelled')),
 note text NOT NULL CHECK(char_length(btrim(note)) BETWEEN 1 AND 1000),
 supersedes_id uuid UNIQUE REFERENCES agency_resource_reservations(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by_name text NOT NULL,worker_name text NOT NULL,task_title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,created_by,request_id),
 CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '24 hours'),
 CHECK(EXTRACT(SECOND FROM starts_at AT TIME ZONE 'UTC')=0 AND EXTRACT(SECOND FROM ends_at AT TIME ZONE 'UTC')=0),
 CHECK(supersedes_id IS NOT NULL OR status='reserved')
);
CREATE INDEX idx_agency_reservation_worker ON agency_resource_reservations(business_id,worker_id,starts_at,ends_at);
CREATE INDEX idx_agency_reservation_project ON agency_resource_reservations(business_id,project_id,starts_at,id);
ALTER TABLE agency_resource_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_resource_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_resource_reservations FOR ALL
 USING(app_rls_bypass() OR business_id=app_current_business())
 WITH CHECK(app_rls_bypass() OR business_id=app_current_business());
CREATE FUNCTION agency_resource_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_name text; person_name text; previous agency_resource_reservations%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'reservation history is immutable' USING ERRCODE='23514'; END IF;
 -- Whole-member lock: cross-midnight and cross-project races use the same key.
 PERFORM pg_advisory_xact_lock(hashtextextended('agency-reservation:'||NEW.business_id::text||NEW.worker_id::text,0));
 SELECT t.title INTO task_name FROM ai_project_tasks t JOIN ai_projects p ON p.id=t.project_id
 WHERE t.id=NEW.task_id AND p.id=NEW.project_id AND p.business_id=NEW.business_id FOR SHARE OF t;
 IF task_name IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND business_id=NEW.business_id) THEN
  RAISE EXCEPTION 'invalid reservation scope' USING ERRCODE='23514'; END IF;
 IF NEW.supersedes_id IS NOT NULL THEN
  SELECT * INTO previous FROM agency_resource_reservations r WHERE r.id=NEW.supersedes_id
   AND r.business_id=NEW.business_id AND r.project_id=NEW.project_id AND r.task_id=NEW.task_id AND r.worker_id=NEW.worker_id
   AND r.status='reserved' AND NOT EXISTS(SELECT 1 FROM agency_resource_reservations n WHERE n.supersedes_id=r.id);
  IF previous.id IS NULL THEN RAISE EXCEPTION 'stale or foreign reservation correction' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.status='cancelled' THEN
  IF previous.id IS NULL OR NEW.starts_at<>previous.starts_at OR NEW.ends_at<>previous.ends_at THEN
   RAISE EXCEPTION 'cancellation must retain interval' USING ERRCODE='23514'; END IF;
  NEW.worker_name:=previous.worker_name;NEW.task_title:=previous.task_title;
 ELSE
  SELECT u.full_name INTO person_name FROM users u JOIN workspace_members m ON m.user_id=u.id
   WHERE u.id=NEW.worker_id AND u.business_id=NEW.business_id AND u.is_active
   AND m.project_id=NEW.project_id AND m.role IN ('owner','manager','editor','contributor') FOR SHARE OF u,m;
  IF person_name IS NULL THEN RAISE EXCEPTION 'resource unavailable' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM agency_resource_reservations r WHERE r.business_id=NEW.business_id AND r.worker_id=NEW.worker_id
   AND r.status='reserved' AND r.id IS DISTINCT FROM NEW.supersedes_id
   AND NOT EXISTS(SELECT 1 FROM agency_resource_reservations n WHERE n.supersedes_id=r.id)
   AND r.starts_at<NEW.ends_at AND r.ends_at>NEW.starts_at) THEN
   RAISE EXCEPTION 'resource interval conflict' USING ERRCODE='23514'; END IF;
  NEW.worker_name:=person_name;NEW.task_title:=task_name;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_agency_resource_reservation BEFORE INSERT OR UPDATE OR DELETE ON agency_resource_reservations
 FOR EACH ROW EXECUTE FUNCTION agency_resource_reservation_guard();
CREATE FUNCTION agency_reserved_task_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.project_id IS DISTINCT FROM OLD.project_id AND EXISTS(SELECT 1 FROM agency_resource_reservations WHERE task_id=OLD.id) THEN
  RAISE EXCEPTION 'reserved task project is frozen' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_agency_reserved_task_scope BEFORE UPDATE ON ai_project_tasks
 FOR EACH ROW EXECUTE FUNCTION agency_reserved_task_scope_guard();
