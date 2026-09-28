-- Issue #759 — durable dashboard AI workspace state.
-- Proposal messages point at their audit row so a reload cannot resurrect a
-- write. `processing` is a short-lived server claim; only the five product
-- states are terminal. The claim is the idempotency barrier around the existing
-- role/permission-guarded business endpoint.
ALTER TABLE ai_action_audit
    DROP CONSTRAINT IF EXISTS ai_action_audit_status_check,
    ADD CONSTRAINT ai_action_audit_status_check
      CHECK (status IN ('proposed', 'processing', 'applied', 'failed', 'dismissed', 'reverted'));

ALTER TABLE ai_action_audit
    ADD COLUMN IF NOT EXISTS conversation_id uuid NULL REFERENCES ai_conversations(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

ALTER TABLE ai_messages
    ADD COLUMN IF NOT EXISTS proposal_audit_id uuid NULL REFERENCES ai_action_audit(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_messages_proposal_audit
    ON ai_messages (proposal_audit_id) WHERE proposal_audit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_action_audit_conversation
    ON ai_action_audit (conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;

-- AI widgets are declarative, durable read-only views over the same runtime as
-- chat. The prompt is never executed by the browser; the run endpoint uses the
-- permission-aware AgentTurn and wallet/audit flow.
CREATE TABLE IF NOT EXISTS ai_widget_templates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name                text NOT NULL CHECK (btrim(name) <> ''),
    description         text NOT NULL DEFAULT '',
    industry            text NOT NULL DEFAULT 'all',
    source_app          text NOT NULL DEFAULT 'all',
    required_permissions text[] NOT NULL DEFAULT '{}',
    prompt              text NOT NULL CHECK (btrim(prompt) <> ''),
    output_format       text NOT NULL DEFAULT 'summary',
    default_width       integer NOT NULL DEFAULT 1 CHECK (default_width BETWEEN 1 AND 2),
    default_height      integer NOT NULL DEFAULT 1 CHECK (default_height BETWEEN 1 AND 2),
    enabled             boolean NOT NULL DEFAULT true,
    version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_widgets (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    actor_user_id       text NOT NULL,
    template_id         uuid NULL REFERENCES ai_widget_templates(id) ON DELETE SET NULL,
    name                text NOT NULL CHECK (btrim(name) <> ''),
    description         text NOT NULL DEFAULT '',
    source_app          text NOT NULL DEFAULT 'all',
    project_id          uuid NULL REFERENCES ai_projects(id) ON DELETE SET NULL,
    prompt              text NOT NULL CHECK (btrim(prompt) <> ''),
    output_format       text NOT NULL DEFAULT 'summary',
    required_permissions text[] NOT NULL DEFAULT '{}',
    width               integer NOT NULL DEFAULT 1 CHECK (width BETWEEN 1 AND 2),
    height              integer NOT NULL DEFAULT 1 CHECK (height BETWEEN 1 AND 2),
    sort_order          integer NOT NULL DEFAULT 0,
    pinned              boolean NOT NULL DEFAULT true,
    archived_at         timestamptz,
    last_run_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_widgets_actor
    ON ai_widgets (business_id, actor_user_id, sort_order, created_at DESC)
    WHERE archived_at IS NULL;

ALTER TABLE ai_widget_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_widget_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_widget_templates;
CREATE POLICY tenant_isolation ON ai_widget_templates FOR ALL
  USING (
    app_rls_bypass()
    OR business_id IS NULL
    OR business_id = app_current_business()
  )
  WITH CHECK (
    app_rls_bypass()
    OR business_id IS NULL
    OR business_id = app_current_business()
  );

INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
VALUES
  ('فروش امروز', 'خلاصهٔ فروش و سفارش‌های امروز', 'food_service', 'reports', ARRAY['reports.view'], 'فروش امروز را با مقایسهٔ کوتاه با روز قبل، بر اساس دادهٔ واقعی گزارش‌ها خلاصه کن.', 'metric', 1, 1, 'system'),
  ('کالاهای رو به اتمام', 'اقلامی که باید زودتر بررسی شوند', 'food_service', 'inventory', ARRAY['inventory.view'], 'کالاهای کم‌موجودی را با نام فارسی و مقدار فعلی، کوتاه و بولت‌وار بنویس.', 'bullets', 1, 1, 'system'),
  ('پیگیری‌های CRM', 'مشتریان نیازمند پیگیری', 'all', 'crm', ARRAY['crm.view'], 'مشتریان یا پیگیری‌های عقب‌افتاده را از CRM پیدا کن و حداکثر پنج مورد مهم را خلاصه کن.', 'bullets', 2, 1, 'system'),
  ('وضعیت پروژه‌ها', 'خلاصهٔ پروژه‌های فعال', 'all', 'workspace', ARRAY['workspace.view'], 'پروژه‌های فعال و کارهای عقب‌افتاده را کوتاه خلاصه کن.', 'bullets', 2, 1, 'system');

ALTER TABLE ai_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_widgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_widgets;
CREATE POLICY tenant_isolation ON ai_widgets FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
