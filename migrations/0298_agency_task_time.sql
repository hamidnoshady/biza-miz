-- Manual actual time, not an invoice, payroll record or posted cost. No backfill.
CREATE TABLE agency_task_time (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES ai_projects(id) ON DELETE RESTRICT,
 task_id uuid NOT NULL REFERENCES ai_project_tasks(id) ON DELETE RESTRICT,
 work_date date NOT NULL,
 minutes integer NOT NULL CHECK (minutes BETWEEN 0 AND 1440),
 note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 1000),
 supersedes_id uuid UNIQUE REFERENCES agency_task_time(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by_name text NOT NULL,
 task_title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,created_by,request_id),
 CHECK (supersedes_id IS NOT NULL OR minutes > 0)
);
CREATE INDEX idx_agency_task_time_project ON agency_task_time(business_id,project_id,created_at);
CREATE INDEX idx_agency_task_time_day ON agency_task_time(business_id,created_by,work_date);
ALTER TABLE agency_task_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_task_time FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_task_time FOR ALL
 USING (app_rls_bypass() OR business_id=app_current_business())
 WITH CHECK (app_rls_bypass() OR business_id=app_current_business());
CREATE FUNCTION agency_task_time_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_name text; used_minutes bigint;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'time history is immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.business_id::text||NEW.created_by::text||NEW.work_date::text,0));
 SELECT t.title INTO task_name FROM ai_project_tasks t JOIN ai_projects p ON p.id=t.project_id
 WHERE t.id=NEW.task_id AND p.id=NEW.project_id AND p.business_id=NEW.business_id FOR SHARE OF t;
 IF task_name IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND business_id=NEW.business_id) THEN
  RAISE EXCEPTION 'invalid time scope' USING ERRCODE='23514'; END IF;
 NEW.task_title := task_name;
 IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agency_task_time r WHERE r.id=NEW.supersedes_id AND r.business_id=NEW.business_id
   AND r.project_id=NEW.project_id AND r.task_id=NEW.task_id AND r.work_date=NEW.work_date AND r.created_by=NEW.created_by
   AND r.minutes>0 AND NOT EXISTS(SELECT 1 FROM agency_task_time n WHERE n.supersedes_id=r.id)
 ) THEN RAISE EXCEPTION 'stale or foreign time correction' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(r.minutes),0) INTO used_minutes FROM agency_task_time r
 WHERE r.business_id=NEW.business_id AND r.created_by=NEW.created_by AND r.work_date=NEW.work_date
 AND r.id IS DISTINCT FROM NEW.supersedes_id AND NOT EXISTS(SELECT 1 FROM agency_task_time n WHERE n.supersedes_id=r.id);
 IF used_minutes+NEW.minutes>1440 THEN RAISE EXCEPTION 'daily time exceeds 1440 minutes' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_agency_task_time BEFORE INSERT OR UPDATE OR DELETE ON agency_task_time
 FOR EACH ROW EXECUTE FUNCTION agency_task_time_guard();
CREATE FUNCTION agency_timed_task_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.project_id IS DISTINCT FROM OLD.project_id AND EXISTS(SELECT 1 FROM agency_task_time WHERE task_id=OLD.id) THEN
  RAISE EXCEPTION 'timed task project is frozen' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_agency_timed_task_scope BEFORE UPDATE ON ai_project_tasks
 FOR EACH ROW EXECUTE FUNCTION agency_timed_task_scope_guard();
