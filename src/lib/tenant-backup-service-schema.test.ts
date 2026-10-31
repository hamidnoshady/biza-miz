/**
 * Issue #903 §11 — the migration contract for the service, hybrid, billing and
 * custody migrations (0265–0268).
 *
 * The DB integration slice (`npm run test:db`) proves RLS *behaviour* against a
 * real PostgreSQL, which this sandbox does not have. This file proves the *text*
 * of the DDL keeps every invariant that slice relies on: each tenant table has
 * RLS enabled, forced, and a policy with both USING and WITH CHECK; the service
 * singleton is platform-only; defaults and CHECK constraints are the ones the
 * TypeScript models assume; and every migration is additive.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(name: string): string {
  return readFileSync(join(process.cwd(), "migrations", name), "utf8");
}

/** DDL without `--` prose, so assertions test SQL and not explanations. */
function ddl(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const SERVICE = ddl(read("0265_tenant_backup_service.sql"));
const HYBRID = ddl(read("0266_tenant_backup_hybrid.sql"));
const BILLING = ddl(read("0267_tenant_backup_billing_jobs.sql"));
const CUSTODY = ddl(read("0268_tenant_backup_custody_ops.sql"));
const OVERRIDES = ddl(read("0269_tenant_backup_overrides.sql"));
const DRILLS = ddl(read("0270_tenant_backup_drills.sql"));

describe("migration 0265 — managed service and upload sessions", () => {
  it("adds a platform-only singleton service row", () => {
    expect(SERVICE).toMatch(/CREATE TABLE platform_tenant_backup_service/);
    expect(SERVICE).toMatch(/id\s+boolean PRIMARY KEY DEFAULT true CHECK \(id\)/);
    expect(SERVICE).toMatch(/CREATE POLICY platform_only ON platform_tenant_backup_service/);
  });

  it("keeps the destination defaults the models assume", () => {
    expect(SERVICE).toMatch(/key_prefix\s+text NOT NULL DEFAULT 'managed-tenant-backups\/'/);
    expect(SERVICE).toMatch(/default_retention_days\s+integer NOT NULL DEFAULT 30/);
    expect(SERVICE).toMatch(/max_retention_days\s+integer NOT NULL DEFAULT 365/);
    expect(SERVICE).toMatch(/max_artifact_bytes\s+bigint NOT NULL DEFAULT 5368709120/);
    expect(SERVICE).toMatch(/upload_chunk_bytes\s+integer NOT NULL DEFAULT 8388608/);
    expect(SERVICE).toMatch(/default_interval_hours[\s\S]*?CHECK \(default_interval_hours IN \(1, 2, 3, 4, 6, 8, 12, 24\)\)/);
  });

  it("scopes upload sessions to one business with an RLS policy", () => {
    expect(SERVICE).toMatch(/CREATE TABLE tenant_backup_upload_sessions/);
    expect(SERVICE).toMatch(/CONSTRAINT tenant_backup_upload_sessions_token UNIQUE \(business_id, session_token\)/);
    expect(SERVICE).toMatch(/state\s+text NOT NULL DEFAULT 'open' CHECK \(state IN \('open', 'complete', 'abandoned', 'expired'\)\)/);
    expect(SERVICE).toMatch(/ALTER TABLE tenant_backup_upload_sessions ENABLE ROW LEVEL SECURITY/);
    expect(SERVICE).toMatch(/ALTER TABLE tenant_backup_upload_sessions FORCE ROW LEVEL SECURITY/);
    expect(SERVICE).toMatch(
      /CREATE POLICY tenant_isolation ON tenant_backup_upload_sessions FOR ALL\s+USING \(app_rls_bypass\(\) OR business_id = app_current_business\(\)\)\s+WITH CHECK \(app_rls_bypass\(\) OR business_id = app_current_business\(\)\)/,
    );
  });

  it("is additive: no drops, no data rewrites", () => {
    for (const sql of [SERVICE, HYBRID, BILLING, CUSTODY]) {
      expect(sql).not.toMatch(/DROP TABLE/i);
      expect(sql).not.toMatch(/DROP COLUMN/i);
      expect(sql).not.toMatch(/TRUNCATE/i);
      expect(sql).not.toMatch(/DELETE FROM/i);
    }
  });
});

describe("migration 0266 — hybrid queue, heartbeat and fence", () => {
  it("queues each artifact once per business", () => {
    expect(HYBRID).toMatch(/CREATE TABLE tenant_backup_upload_queue/);
    expect(HYBRID).toMatch(/CONSTRAINT tenant_backup_upload_queue_artifact UNIQUE \(business_id, artifact_name\)/);
    expect(HYBRID).toMatch(/state\s+text NOT NULL DEFAULT 'queued'/);
    expect(HYBRID).toMatch(/'queued', 'uploading', 'done', 'dead', 'superseded'/);
    expect(HYBRID).toMatch(/next_attempt_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("records both the site generation and the generation the platform accepted", () => {
    expect(HYBRID).toMatch(/CREATE TABLE tenant_backup_site_heartbeat/);
    expect(HYBRID).toMatch(/site_generation\s+bigint NOT NULL DEFAULT 0/);
    expect(HYBRID).toMatch(/accepted_generation\s+bigint NOT NULL DEFAULT 0/);
    expect(HYBRID).toMatch(/last_seen_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("forces RLS on both new tenant tables", () => {
    for (const table of ["tenant_backup_upload_queue", "tenant_backup_site_heartbeat"]) {
      expect(HYBRID).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
      expect(HYBRID).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
      expect(HYBRID).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON ${table} FOR ALL`));
    }
  });
});

describe("migration 0267 — refund idempotency", () => {
  it("makes a second refund of the same charge a constraint violation", () => {
    expect(BILLING).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_refund_once/);
    expect(BILLING).toMatch(/\(\(metadata->>'refundOf'\)\)/);
    expect(BILLING).toMatch(/WHERE kind = 'refund' AND metadata \? 'refundOf'/);
  });
});

describe("migration 0268 — custody operations", () => {
  it("adds a superseded state without losing the existing ones", () => {
    expect(CUSTODY).toMatch(/DROP CONSTRAINT IF EXISTS tenant_backup_artifacts_state_check/);
    for (const state of ["pending_upload", "uploading", "verifying", "ready", "failed", "expired", "superseded"]) {
      expect(CUSTODY).toMatch(new RegExp(`'${state}'`));
    }
    expect(CUSTODY).toMatch(/ADD COLUMN IF NOT EXISTS superseded_by text/);
  });
});

describe("migration 0269 — per-business overrides and recovery approvals", () => {
  it("makes both new tables platform-only, so a tenant sees no rows at all", () => {
    for (const table of ["tenant_backup_business_policy", "tenant_backup_restore_approvals"]) {
      expect(OVERRIDES).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
      expect(OVERRIDES).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
      expect(OVERRIDES).toMatch(new RegExp(`CREATE POLICY platform_only ON ${table} FOR ALL`));
    }
    // Neither table grants a tenant path at all: `app_rls_bypass()` is the
    // whole rule, so there is no `app_current_business()` clause to widen.
    expect(OVERRIDES).not.toContain("app_current_business()");
  });

  it("lets an override be NULL (inherit) and bounds each number", () => {
    expect(OVERRIDES).toMatch(/interval_hours\s+integer CHECK \(interval_hours IS NULL OR interval_hours IN/);
    expect(OVERRIDES).toMatch(/retention_days\s+integer CHECK \(retention_days IS NULL OR retention_days BETWEEN 1 AND 3650\)/);
    expect(OVERRIDES).toMatch(/keep_count\s+integer CHECK \(keep_count IS NULL OR keep_count BETWEEN 1 AND 500\)/);
    expect(OVERRIDES).toMatch(/max_artifact_bytes\s+bigint\s+CHECK \(max_artifact_bytes IS NULL OR max_artifact_bytes > 0\)/);
  });

  it("defaults the approval control off, so enabling the table changes no restore", () => {
    expect(OVERRIDES).toMatch(/require_restore_approval boolean NOT NULL DEFAULT false/);
  });

  it("makes an approval named, expiring and single use", () => {
    expect(OVERRIDES).toMatch(/approved_by\s+uuid REFERENCES platform_admins\(id\)/);
    expect(OVERRIDES).toMatch(/expires_at\s+timestamptz NOT NULL/);
    expect(OVERRIDES).toMatch(/consumed_at\s+timestamptz/);
    expect(OVERRIDES).toMatch(/CHECK \(expires_at > approved_at\)/);
  });
});

describe("migration 0270 — drill history", () => {
  it("lets a business read its own drill evidence but never write it", () => {
    expect(DRILLS).toMatch(/ALTER TABLE tenant_backup_drills ENABLE ROW LEVEL SECURITY/);
    expect(DRILLS).toMatch(/ALTER TABLE tenant_backup_drills FORCE ROW LEVEL SECURITY/);
    // Read: own business, through the one permissive policy the tenancy gate
    // approves. Write: platform only, because evidence a tenant can manufacture
    // is not evidence — and subtracted with RESTRICTIVE policies so the
    // permissive read policy can never widen into a write.
    expect(DRILLS).toMatch(
      /CREATE POLICY tenant_isolation ON tenant_backup_drills FOR ALL\s+USING \(app_rls_bypass\(\) OR business_id = app_current_business\(\)\)\s+WITH CHECK \(app_rls_bypass\(\) OR business_id = app_current_business\(\)\)/,
    );
    expect(DRILLS).toMatch(/CREATE POLICY platform_write_insert ON tenant_backup_drills AS RESTRICTIVE FOR INSERT\s+WITH CHECK \(app_rls_bypass\(\)\)/);
    expect(DRILLS).toMatch(/CREATE POLICY platform_write_update ON tenant_backup_drills AS RESTRICTIVE FOR UPDATE/);
    expect(DRILLS).toMatch(/CREATE POLICY platform_write_delete ON tenant_backup_drills AS RESTRICTIVE FOR DELETE/);
    // No second permissive policy: the gate allows exactly one per table.
    const permissive = DRILLS.match(/CREATE POLICY \w+ ON tenant_backup_drills FOR (SELECT|ALL)/g) ?? [];
    expect(permissive).toEqual(["CREATE POLICY tenant_isolation ON tenant_backup_drills FOR ALL"]);
  });

  it("records what a drill could not prove, separately from whether it passed", () => {
    expect(DRILLS).toMatch(/missing_steps\s+text\[\] NOT NULL DEFAULT '\{\}'/);
    expect(DRILLS).toMatch(/ok\s+boolean NOT NULL/);
    expect(DRILLS).toMatch(/source\s+text NOT NULL DEFAULT 'schedule'\s+CHECK \(source IN \('schedule', 'manual', 'ci'\)\)/);
  });

  it("keeps the artifact reference as text, so a drill outlives the artifact it tested", () => {
    expect(DRILLS).toMatch(/artifact_ref\s+text NOT NULL/);
    expect(DRILLS).not.toMatch(/artifact_ref\s+uuid/);
    expect(DRILLS).toMatch(/CONSTRAINT tenant_backup_drills_window CHECK \(finished_at >= started_at\)/);
  });

  it("indexes the question the console and the scheduler both ask", () => {
    expect(DRILLS).toMatch(/CREATE INDEX IF NOT EXISTS tenant_backup_drills_recent\s+ON tenant_backup_drills \(business_id, finished_at DESC\)/);
  });
});
