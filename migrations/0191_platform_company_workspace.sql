-- 0191_platform_company_workspace.sql
-- Protected platform-owned operating company, scoped staff access, customer
-- relationship mappings, billing -> accounting outbox and workspace links.
-- Additive only: no historical billing source is enqueued by this migration.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS ownership_kind text NOT NULL DEFAULT 'customer'
    CHECK (ownership_kind IN ('customer', 'platform_internal'));
CREATE UNIQUE INDEX IF NOT EXISTS businesses_one_platform_internal
  ON businesses (ownership_kind) WHERE ownership_kind = 'platform_internal';

CREATE TABLE platform_company_entitlements (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN ('accounting','crm','growth','website','workspace')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, capability)
);
ALTER TABLE platform_company_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_entitlements FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_industry_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_industry_check CHECK (industry IN (
  'food_service','jewelry','watch','accessories','cosmetics','wholesale',
  'tools_fittings','haberdashery','service_saas','architecture_construction'
));

-- A platform identity is mapped to a real tenant membership. The preset limits
-- business access and is independent from the identity's infrastructure role.
CREATE TABLE platform_company_members (
  platform_admin_id uuid PRIMARY KEY REFERENCES platform_admins(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_preset text NOT NULL CHECK (access_preset IN
    ('company_owner','finance','sales_success','marketing','website_editor','project_manager')),
  is_active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  granted_by uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
CREATE INDEX platform_company_members_business_active
  ON platform_company_members (business_id, is_active);
ALTER TABLE platform_company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_members FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- One-use transfer from the admin origin to the company tenant origin. Only a
-- hash is stored. This is staff access, not customer impersonation.
CREATE TABLE platform_company_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  platform_admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_company_handoffs_expiry ON platform_company_handoffs (expires_at)
  WHERE used_at IS NULL;
ALTER TABLE platform_company_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_handoffs FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- The internal CRM party is deliberately separate from the customer tenant.
-- A billing customer can own several tenant rows; tenant private data is never copied.
CREATE TABLE platform_company_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  legal_name text NOT NULL CHECK (btrim(legal_name) <> ''),
  billing_customer_key text NOT NULL,
  account_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  churn_risk text NOT NULL DEFAULT 'unknown' CHECK (churn_risk IN ('unknown','low','medium','high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, party_id),
  UNIQUE (business_id, billing_customer_key)
);
CREATE TABLE platform_company_customer_tenants (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES platform_company_customers(id) ON DELETE CASCADE,
  customer_tenant_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, customer_tenant_id),
  UNIQUE (customer_id, customer_tenant_id),
  CHECK (business_id <> customer_tenant_id)
);

-- Global transactional outbox. Source triggers only enqueue new transitions;
-- deployment does not silently backfill history.
CREATE TABLE platform_company_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN
    ('invoice_issued','invoice_payment','invoice_void','wallet_top_up','wallet_spend','wallet_refund','wallet_noncash_credit','provider_cost','adjustment')),
  source_table text NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL,
  customer_tenant_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','posted','failed','ignored')),
  last_error text,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id, source_version)
);
CREATE INDEX platform_company_billing_events_queue
  ON platform_company_billing_events (status, available_at, occurred_at)
  WHERE status IN ('pending','failed');
ALTER TABLE platform_company_billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_billing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_billing_events FOR ALL
  USING (app_rls_bypass() OR internal_business_id = app_current_business()
         OR customer_tenant_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR internal_business_id = app_current_business()
              OR customer_tenant_id = app_current_business());

CREATE TABLE platform_company_accounting_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_id uuid NOT NULL UNIQUE REFERENCES platform_company_billing_events(id) ON DELETE RESTRICT,
  source_reference text NOT NULL,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posting_rule text NOT NULL,
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source_reference)
);

-- Explicit links across company work areas. Posted actuals stay in Accounting;
-- these links carry identity, not copied balances.
ALTER TABLE ai_projects
  ADD COLUMN IF NOT EXISTS source_deal_id uuid REFERENCES crm_deals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS creation_key text,
  ADD COLUMN IF NOT EXISTS forecast_revenue_rial bigint CHECK (forecast_revenue_rial IS NULL OR forecast_revenue_rial >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS ai_projects_creation_key_unique
  ON ai_projects (business_id, creation_key) WHERE creation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_projects_source_deal ON ai_projects (business_id, source_deal_id)
  WHERE source_deal_id IS NOT NULL;

CREATE TABLE workspace_project_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
  link_kind text NOT NULL CHECK (link_kind IN ('deal','invoice','campaign','website','support_ticket','customer_tenant')),
  linked_id text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, link_kind, linked_id)
);

CREATE TABLE platform_company_web_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_key text NOT NULL,
  idempotency_key text NOT NULL,
  email_normalized text,
  phone_normalized text,
  name text NOT NULL CHECK (btrim(name) <> ''),
  message text NOT NULL DEFAULT '',
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, site_key, idempotency_key)
);
CREATE INDEX platform_company_web_leads_contact
  ON platform_company_web_leads (business_id, email_normalized, phone_normalized);

-- Site-scoped, show-once credentials for public lead forms. A credential can
-- submit leads for one named site only; it grants no tenant read capability.
CREATE TABLE platform_company_site_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_key text NOT NULL CHECK (btrim(site_key) <> ''),
  provider text NOT NULL CHECK (provider IN ('eshobe','wordpress')),
  token_hash text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  requests_per_minute integer NOT NULL DEFAULT 30 CHECK (requests_per_minute BETWEEN 1 AND 300),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0),
  last_used_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,site_key,provider)
);

-- Tenant isolation for every internal-business-owned table.
ALTER TABLE platform_company_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_customers FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
ALTER TABLE platform_company_customer_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_customer_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_customer_tenants FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
ALTER TABLE platform_company_accounting_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_accounting_postings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_accounting_postings FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
ALTER TABLE workspace_project_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_project_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_project_links FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
ALTER TABLE platform_company_web_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_web_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_web_leads FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
ALTER TABLE platform_company_site_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company_site_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_company_site_credentials FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Source-side enqueue helper: if the internal company has not been provisioned,
-- the event is intentionally not generated. Setup never replays old rows.
CREATE OR REPLACE FUNCTION enqueue_platform_company_billing_event(
  p_kind text, p_table text, p_id text, p_version text, p_customer uuid,
  p_amount bigint, p_payload jsonb, p_occurred timestamptz DEFAULT now()
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  SELECT id INTO target FROM businesses WHERE ownership_kind = 'platform_internal';
  IF target IS NULL OR p_amount < 0 THEN RETURN; END IF;
  INSERT INTO platform_company_billing_events
    (internal_business_id, source_kind, source_table, source_id, source_version,
     customer_tenant_id, amount_rial, payload, occurred_at)
  VALUES (target,p_kind,p_table,p_id,p_version,p_customer,p_amount,COALESCE(p_payload,'{}'::jsonb),p_occurred)
  ON CONFLICT (source_table,source_id,source_version) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION platform_company_invoice_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    PERFORM enqueue_platform_company_billing_event('invoice_issued','billing_invoices',NEW.id::text,
      'issued:'||NEW.status,NEW.business_id,NEW.total_rial,jsonb_build_object('invoiceNumber',NEW.invoice_number),NEW.created_at);
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'draft' AND NEW.status <> 'draft' THEN
      PERFORM enqueue_platform_company_billing_event('invoice_issued','billing_invoices',NEW.id::text,
        'issued:'||NEW.status,NEW.business_id,NEW.total_rial,jsonb_build_object('invoiceNumber',NEW.invoice_number),NEW.updated_at);
    END IF;
    IF NEW.paid_rial > OLD.paid_rial THEN
      PERFORM enqueue_platform_company_billing_event('invoice_payment','billing_invoices',NEW.id::text,
        'paid:'||NEW.paid_rial::text,NEW.business_id,NEW.paid_rial-OLD.paid_rial,
        jsonb_build_object('invoiceId',NEW.id,'paidTotalRial',NEW.paid_rial),NEW.updated_at);
    END IF;
    IF NEW.status = 'void' AND OLD.status <> 'void' THEN
      PERFORM enqueue_platform_company_billing_event('invoice_void','billing_invoices',NEW.id::text,
        'void',NEW.business_id,NEW.total_rial-NEW.paid_rial,jsonb_build_object('invoiceId',NEW.id),NEW.updated_at);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_invoice_outbox ON billing_invoices;
CREATE TRIGGER platform_company_invoice_outbox AFTER INSERT OR UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION platform_company_invoice_event();

CREATE OR REPLACE FUNCTION platform_company_wallet_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
  kind := CASE
    WHEN NEW.kind = 'top_up' THEN 'wallet_top_up'
    WHEN NEW.kind IN ('admin_grant','free_promo') THEN 'wallet_noncash_credit'
    WHEN NEW.kind = 'refund' AND NEW.direction = 'credit' THEN 'wallet_refund'
    WHEN NEW.direction = 'debit' THEN 'wallet_spend'
    ELSE 'adjustment' END;
  PERFORM enqueue_platform_company_billing_event(kind,'wallet_ledger',NEW.id::text,'created',NEW.business_id,
    NEW.amount_rial,jsonb_build_object('kind',NEW.kind,'direction',NEW.direction,'paymentId',NEW.payment_id,'metadata',NEW.metadata),NEW.created_at);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_wallet_outbox ON wallet_ledger;
CREATE TRIGGER platform_company_wallet_outbox AFTER INSERT ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION platform_company_wallet_event();

CREATE OR REPLACE FUNCTION platform_company_vendor_cost_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_platform_company_billing_event('provider_cost','billing_vendor_cost_events',NEW.id::text,'created',
    NEW.business_id,NEW.amount_rial,jsonb_build_object('provider',NEW.provider,'meterKey',NEW.meter_key),NEW.occurred_at);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_vendor_cost_outbox ON billing_vendor_cost_events;
CREATE TRIGGER platform_company_vendor_cost_outbox AFTER INSERT ON billing_vendor_cost_events
  FOR EACH ROW EXECUTE FUNCTION platform_company_vendor_cost_event();
