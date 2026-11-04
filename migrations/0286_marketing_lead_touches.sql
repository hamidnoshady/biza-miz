-- Issue #900: append-only operational marketer touches to existing CRM leads.
-- CRM retains ownership of leads, sources and consent; these are not conversions.
CREATE UNIQUE INDEX crm_leads_business_id_marketing_key ON crm_leads (business_id, id);
CREATE UNIQUE INDEX marketing_assignments_business_branch_id_key ON marketing_assignments (business_id, location_id, id);
CREATE TABLE marketing_touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_person', 'phone', 'online', 'referral', 'event', 'other')),
  source text NOT NULL CHECK (source IN ('pos','woocommerce','website_form','instagram','telegram','whatsapp','phone','walk_in','referral','campaign','event','marketplace','import','manual','other')),
  idempotency_key uuid NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id, assignment_id) REFERENCES marketing_assignments(business_id, location_id, id),
  FOREIGN KEY (business_id, lead_id) REFERENCES crm_leads(business_id, id),
  FOREIGN KEY (business_id, created_by) REFERENCES users(business_id, id),
  UNIQUE (business_id, idempotency_key)
);
CREATE INDEX marketing_touchpoints_branch_list ON marketing_touchpoints (business_id, location_id, recorded_at DESC, id);
CREATE INDEX marketing_touchpoints_lead ON marketing_touchpoints (business_id, lead_id, recorded_at);
CREATE INDEX marketing_touchpoints_creator ON marketing_touchpoints (business_id, created_by) WHERE created_by IS NOT NULL;
ALTER TABLE marketing_touchpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_touchpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_touchpoints FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Source facts are append-only. A foreign-key nulling of a deleted user is the
-- sole allowed edit; the confirmed factory-reset transaction may delete.
-- No ordinary Growth endpoint can erase history.
CREATE FUNCTION marketing_touchpoint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS NULL THEN
      RAISE EXCEPTION 'marketing_touchpoints require an actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1 AND OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
       AND NEW.id = OLD.id AND NEW.business_id = OLD.business_id AND NEW.location_id = OLD.location_id
       AND NEW.assignment_id = OLD.assignment_id AND NEW.lead_id = OLD.lead_id
       AND NEW.channel = OLD.channel AND NEW.source = OLD.source
       AND NEW.idempotency_key = OLD.idempotency_key AND NEW.recorded_at = OLD.recorded_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'marketing_touchpoints are immutable' USING ERRCODE = '55000';
  END IF;
  IF current_setting('app.factory_reset', true) = 'true' OR NOT EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'marketing_touchpoints are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER marketing_touchpoint_immutable BEFORE INSERT OR UPDATE OR DELETE ON marketing_touchpoints
  FOR EACH ROW EXECUTE FUNCTION marketing_touchpoint_immutable();
