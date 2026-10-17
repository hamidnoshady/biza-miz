-- ============================================================================
-- 0228_platform_business_id_rls.sql — protect platform-owned records that
-- carry a tenant attribution column.
--
-- `platform_audit_log` and `platform_cms_sites` are deliberately omitted from
-- per-tenant exports, but both carry `business_id` for attribution. Export
-- ownership is not an exemption from the database isolation boundary: a
-- tenant-scoped connection must not read or write another business's rows.
--
-- The platform console and CMS mirror legitimately work across businesses;
-- console requests use `withPlatformScope` and background sync uses
-- `withoutTenantScope("platform", ...)`, both of which set the documented
-- `app_rls_bypass()` escape hatch. Rows with no business attribution remain
-- visible only to those bypassed platform operations.
-- ============================================================================

ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_audit_log;
CREATE POLICY tenant_isolation ON platform_audit_log FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE platform_cms_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_cms_sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_cms_sites;
CREATE POLICY tenant_isolation ON platform_cms_sites FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
