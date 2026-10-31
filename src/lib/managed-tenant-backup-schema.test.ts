/**
 * Issue #903 — the migration contract for the managed tenant backup tables.
 *
 * The database integration suite proves RLS *behaviour* on a real PostgreSQL;
 * this file proves the *text* of migration 0264 keeps the invariants that suite
 * depends on, so a later edit that drops `FORCE ROW LEVEL SECURITY` or renames a
 * policy fails in the fast unit run instead of only in the DB slice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(process.cwd(), "migrations", "0264_managed_tenant_backup.sql"), "utf8");

/** The text of one table's section, without the prose comments around it. */
function section(marker: string): string {
  const start = SQL.indexOf(marker);
  const next = SQL.indexOf("CREATE TABLE", start + marker.length);
  const chunk = SQL.slice(start, next === -1 ? undefined : next);
  // Strip `--` comments (including continuation lines) so the assertions below
  // test the DDL, not the prose that explains it.
  return chunk
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Every tenant-scoped table this migration adds. */
const TENANT_TABLES = [
  "tenant_backup_artifacts",
  "tenant_backup_restore_jobs",
  "tenant_backup_storage_samples",
];

describe("migration 0264", () => {
  it("is additive and forward-only", () => {
    expect(SQL).not.toMatch(/DROP TABLE/i);
    expect(SQL).not.toMatch(/DROP COLUMN/i);
    expect(SQL).not.toMatch(/TRUNCATE/i);
    expect(SQL).not.toMatch(/UPDATE\s+\w+\s+SET/i);
  });

  it.each(TENANT_TABLES)("enables and forces RLS on %s with the canonical tenant policy", (table) => {
    expect(SQL).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    expect(SQL).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
    const policy = section(`CREATE TABLE ${table}`);
    expect(policy).toMatch(/CREATE POLICY tenant_isolation ON \w+ FOR ALL/);
    expect(policy).toMatch(/app_rls_bypass\(\) OR business_id = app_current_business\(\)/);
    // The integration sweep requires exactly the approved policy name; an extra
    // permissive policy would silently OR itself into the tenant check.
    expect(policy).not.toMatch(/CREATE POLICY (?!tenant_isolation)\w+ ON \w+ FOR ALL/);
  });

  it("keeps key custody platform-only and off the tenant-scoped column name", () => {
    const custody = section("CREATE TABLE backup_key_versions");
    expect(custody).not.toMatch(/\bbusiness_id\b/);
    expect(custody).toContain("subject_business_id");
    expect(custody).toMatch(/CREATE POLICY platform_only ON backup_key_versions/);
    expect(custody).toMatch(/USING \(app_rls_bypass\(\)\)/);
    // One active generation per business, enforced by the database.
    expect(custody).toMatch(/UNIQUE INDEX backup_key_versions_one_active/);
    expect(custody).toMatch(/WHERE status = 'active'/);
  });

  it("stores a mirror as one artifact id across two destinations, idempotently", () => {
    expect(SQL).toMatch(/UNIQUE \(business_id, destination, storage_ref\)/);
    expect(SQL).toMatch(/CREATE INDEX idx_tenant_backup_artifacts_artifact/);
    // A managed artifact must name a key version; a legacy one must not claim one.
    expect(SQL).toMatch(/tenant_backup_artifacts_key_version_check/);
  });

  it("keeps local bytes out of the byte-day evidence and allows one open apply", () => {
    expect(SQL).toMatch(/COMMENT ON TABLE tenant_backup_storage_samples/);
    expect(SQL).toMatch(/Local bytes are never recorded/);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX tenant_backup_restore_jobs_one_open_apply/);
    expect(SQL).toMatch(/WHERE mode = 'apply' AND phase IN \('approved', 'checkpointed', 'applying'\)/);
  });

  it("never stores a provider secret, endpoint or bucket name in tenant-facing tables", () => {
    const artifacts = section("CREATE TABLE tenant_backup_artifacts");
    expect(artifacts).not.toMatch(/access_key|secret_key|bucket|endpoint/i);
    // `legacy_passphrase_v1` is an encryption-generation label, not a stored
    // credential; no column may hold a passphrase itself.
    expect(artifacts).not.toMatch(/^\s*passphrase\s/m);
    // The storage reference is server-only and documented as such.
    expect(artifacts).toMatch(/storage_ref\s+text NOT NULL/);
    expect(artifacts).toMatch(/never serialize to a tenant/);
  });
});
