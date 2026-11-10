-- Period-specific client campaign evidence; not an ad connector or a ledger.
-- Append-only corrections retain the old report. No legacy metrics backfill.
CREATE TABLE agency_campaign_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL REFERENCES agency_client_campaigns(id) ON DELETE RESTRICT,
 period_start date NOT NULL, period_end date NOT NULL CHECK (period_end >= period_start),
 evidence_reference text NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500),
 attribution_note text NOT NULL CHECK (char_length(btrim(attribution_note)) BETWEEN 1 AND 2000),
 attribution_confirmed boolean NOT NULL,
 spend_rial bigint NOT NULL CHECK (spend_rial BETWEEN 0 AND 9000000000000000),
 impressions bigint NOT NULL CHECK (impressions BETWEEN 0 AND 1000000000000),
 reach bigint CHECK (reach BETWEEN 0 AND impressions),
 campaign_budget_rial bigint CHECK (campaign_budget_rial BETWEEN 0 AND 9000000000000000),
 clicks bigint NOT NULL CHECK (clicks BETWEEN 0 AND impressions),
 leads_generated bigint NOT NULL CHECK (leads_generated BETWEEN 0 AND 1000000000),
 conversions bigint NOT NULL CHECK (conversions BETWEEN 0 AND 1000000000),
 revenue_rial bigint CHECK (revenue_rial BETWEEN 0 AND 9000000000000000),
 supersedes_id uuid UNIQUE REFERENCES agency_campaign_reports(id) ON DELETE RESTRICT,
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by_name text NOT NULL CHECK (char_length(created_by_name) <= 200),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_agency_campaign_report_root ON agency_campaign_reports(business_id,campaign_id,period_start,period_end) WHERE supersedes_id IS NULL;
CREATE INDEX idx_agency_campaign_reports_scope ON agency_campaign_reports(business_id,campaign_id,created_at);
ALTER TABLE agency_campaign_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_campaign_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_campaign_reports FOR ALL
 USING (app_rls_bypass() OR business_id=app_current_business())
 WITH CHECK (app_rls_bypass() OR business_id=app_current_business());

CREATE FUNCTION agency_campaign_report_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign_status text; campaign_start date; campaign_end date; campaign_budget bigint;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'campaign reports are immutable; append a correction' USING ERRCODE='23514'; END IF;
 SELECT status,start_date,end_date,budget_rial INTO campaign_status,campaign_start,campaign_end,campaign_budget FROM agency_client_campaigns WHERE id=NEW.campaign_id AND business_id=NEW.business_id FOR UPDATE;
 IF campaign_status IS NULL OR (campaign_status NOT IN ('running','paused','completed','cancelled') OR campaign_start IS NULL) THEN
  RAISE EXCEPTION 'report requires a dated, non-planned same-tenant campaign' USING ERRCODE='23514';
 END IF;
 NEW.campaign_budget_rial := campaign_budget;
 IF NEW.period_start < campaign_start OR NEW.period_end > campaign_end THEN
  RAISE EXCEPTION 'report period is outside campaign window' USING ERRCODE='23514';
 END IF;
 IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agency_campaign_reports r WHERE r.id=NEW.supersedes_id
   AND r.business_id=NEW.business_id AND r.campaign_id=NEW.campaign_id
   AND r.period_start=NEW.period_start AND r.period_end=NEW.period_end
 ) THEN RAISE EXCEPTION 'correction must retain campaign and period' USING ERRCODE='23514'; END IF;
 IF NEW.supersedes_id IS NULL AND EXISTS (
  SELECT 1 FROM agency_campaign_reports r WHERE r.business_id=NEW.business_id AND r.campaign_id=NEW.campaign_id
   AND r.period_start=NEW.period_start AND r.period_end=NEW.period_end
 ) THEN RAISE EXCEPTION 'period already reported; append a correction' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_agency_campaign_report_guard BEFORE INSERT OR UPDATE OR DELETE ON agency_campaign_reports
 FOR EACH ROW EXECUTE FUNCTION agency_campaign_report_guard();

CREATE FUNCTION agency_campaign_report_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date)
    AND EXISTS (SELECT 1 FROM agency_campaign_reports r WHERE r.business_id=OLD.business_id AND r.campaign_id=OLD.id
      AND (NEW.start_date IS NULL OR r.period_start < NEW.start_date OR r.period_end > NEW.end_date)) THEN
  RAISE EXCEPTION 'campaign window must retain reported periods' USING ERRCODE='23514';
 END IF;
 IF (NEW.project_id IS DISTINCT FROM OLD.project_id OR
    (NEW.party_id IS DISTINCT FROM OLD.party_id AND current_setting('app.ledger_party_move',true) IS DISTINCT FROM 'on'))
    AND EXISTS (SELECT 1 FROM agency_campaign_reports r WHERE r.business_id=OLD.business_id AND r.campaign_id=OLD.id) THEN
  RAISE EXCEPTION 'reported campaign client and project scope is frozen' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_agency_campaign_report_scope BEFORE UPDATE ON agency_client_campaigns
 FOR EACH ROW EXECUTE FUNCTION agency_campaign_report_scope_guard();
