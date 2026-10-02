import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { companyPresetAllows } from "./platform-company";
import { PERMISSIONS } from "./permissions";
import { APP_KEYS } from "./apps";
import { industryProfile } from "./industry-profile";

const migration = readFileSync("migrations/0191_platform_company_workspace.sql", "utf8");

describe("platform company policy", () => {
  it("keeps exactly four standalone app keys and does not turn Workspace into an app", () => {
    expect(APP_KEYS).toEqual(["accounting", "crm", "growth", "website"]);
    expect(APP_KEYS).not.toContain("workspace" as never);
  });

  it("separates business presets from infrastructure roles", () => {
    expect(companyPresetAllows("sales_success", PERMISSIONS.crmManage)).toBe(true);
    expect(companyPresetAllows("sales_success", PERMISSIONS.ledgerApprove)).toBe(false);
    expect(companyPresetAllows("finance", PERMISSIONS.ledgerApprove)).toBe(true);
    expect(companyPresetAllows("website_editor", PERMISSIONS.websiteManage)).toBe(true);
    expect(companyPresetAllows("website_editor", PERMISSIONS.teamManage)).toBe(false);
  });

  it("hides restaurant/POS modules from the service SaaS profile", () => {
    const modules = industryProfile("service_saas").modules;
    expect(modules).toContain("ledger");
    expect(modules).toContain("crm");
    expect(modules).toContain("website");
    expect(modules).not.toContain("pos");
    expect(modules).not.toContain("tables");
    expect(modules).not.toContain("inventory");
  });

  it("database-enforces singleton ownership, event and project idempotency", () => {
    expect(migration).toMatch(/businesses_one_platform_internal[\s\S]*WHERE ownership_kind = 'platform_internal'/);
    expect(migration).toMatch(/UNIQUE \(source_table, source_id, source_version\)/);
    expect(migration).toMatch(/ai_projects_creation_key_unique/);
    expect(migration).toMatch(/ON CONFLICT \(source_table,source_id,source_version\) DO NOTHING/);
  });

  it("RLS-protects every new internal-business-owned table", () => {
    for (const table of [
      "platform_company_entitlements", "platform_company_members", "platform_company_handoffs",
      "platform_company_customers", "platform_company_customer_tenants",
      "platform_company_accounting_postings", "workspace_project_links", "platform_company_web_leads",
      "platform_company_site_credentials",
    ]) {
      expect(migration, table).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
  });

  it("does not silently backfill history", () => {
    expect(migration).not.toMatch(/INSERT INTO platform_company_billing_events[\s\S]*SELECT[\s\S]*FROM billing_invoices/);
  });
});
