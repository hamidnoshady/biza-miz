-- Issue #764 — Growth-wide settings.
--
-- «تنظیمات رشد و بازاریابی» used to be a read-only second dashboard. It now
-- owns two app-wide decisions, each read by something real
-- (src/lib/growth-settings.ts):
--
--   attribution_window_days  how long after a message campaign starts a sale
--                            using its dedicated promotion still counts toward
--                            that campaign (NULL = no limit).
--   discount_budget_rial     the campaign discount the business is willing to
--                            give away in any rolling 30 days; a dashboard
--                            threshold, never a sale-time block (NULL = none).
--
-- One row per business, created on first save. A business without a row reads
-- the code defaults. Tenant data, so RLS'd like every other per-business table.
CREATE TABLE growth_settings (
    business_id              uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    attribution_window_days  integer CHECK (attribution_window_days BETWEEN 1 AND 365),
    discount_budget_rial     bigint CHECK (discount_budget_rial > 0),
    updated_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE growth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_settings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
