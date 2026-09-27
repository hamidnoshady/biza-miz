-- Align cms_entitlement_outbox RLS with the standard tenant_isolation template.

DROP POLICY IF EXISTS tenant_isolation ON cms_entitlement_outbox;
CREATE POLICY tenant_isolation ON cms_entitlement_outbox FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
