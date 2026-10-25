/**
 * The background ticks must claim their work under the platform bypass.
 *
 * ## Why this test exists — the bug it was written for
 *
 * A background tick has no session, so it inherits no tenant scope. Every
 * table this engine owns is protected by an RLS policy keyed on
 * `app.business_id` (migration 0169), and an unset scope makes
 * `app_current_business()` NULL, which makes every policy predicate false.
 * A cross-tenant claim issued with no scope therefore matches **zero rows on
 * every business**: the import queue never drains, and no error is raised —
 * the UPDATE honestly reports that it updated nothing.
 *
 * The reason this needs a *unit* test, and could never have been caught by the
 * integration suite, is that the integration database connects as a superuser.
 * Superusers ignore RLS outright, so the unscoped claim works perfectly there
 * and fails totally in production, where `npm run db:app-role` provisions the
 * unprivileged role that `assertRlsEffective` insists on at boot. That is the
 * worst shape a defect can have: green everywhere except where it matters.
 *
 * So the property is asserted structurally instead — the claim runs inside
 * `withoutTenantScope`, and the per-business work runs inside `withTenant`.
 * Mocking the database is what makes the *scope* observable, which is the
 * thing under test; the behaviour of the queue itself is covered against a
 * real Postgres in `integration/data-transfer.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { query, withoutTenantScope, withTenant } from "../db";

/**
 * Each helper records the scope in force while its callback ran, so a
 * statement can be attributed to the scope that issued it rather than merely
 * counted.
 */
const scopes: string[] = [];
let current = "none";

vi.mock("../db", () => ({
  query: vi.fn(),
  withTenant: vi.fn(async (businessId: string, fn: () => Promise<unknown>) => {
    const previous = current;
    current = `tenant:${businessId}`;
    try {
      return await fn();
    } finally {
      current = previous;
    }
  }),
  withoutTenantScope: vi.fn(async (reason: string, fn: () => Promise<unknown>) => {
    const previous = current;
    current = `bypass:${reason}`;
    try {
      return await fn();
    } finally {
      current = previous;
    }
  }),
}));

vi.mock("./audit", () => ({ recordDataTransferAudit: vi.fn() }));

/** Every statement, tagged with the scope that was in force when it ran. */
function statements() {
  return vi.mocked(query).mock.calls.map((call, index) => ({
    sql: String(call[0]).replace(/\s+/g, " ").trim(),
    scope: scopes[index] ?? "none",
  }));
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  scopes.length = 0;
  current = "none";
  vi.mocked(query).mockImplementation(async () => {
    scopes.push(current);
    return { rows: [], rowCount: 0 } as never;
  });
});

describe("runImportQueueTick", () => {
  it("claims under the platform bypass, so RLS cannot hide the queue", async () => {
    const { runImportQueueTick } = await import("./import-service");

    const claimed = await runImportQueueTick();

    expect(claimed).toBe(0);
    const claim = statements().find((s) => s.sql.includes("SET status = 'running'"));
    expect(claim).toBeDefined();
    // The assertion that matters: not merely that a bypass was opened, but
    // that *this* statement ran inside it.
    expect(claim?.scope).toBe("bypass:platform");
    expect(vi.mocked(withoutTenantScope)).toHaveBeenCalledWith("platform", expect.any(Function));
  });

  it("leaves customer-disabled service imports queued without starving other services", async () => {
    const { runImportQueueTick } = await import("./import-service");

    await runImportQueueTick();

    const claim = vi.mocked(query).mock.calls.find((call) => String(call[0]).includes("SET status = 'running'"));
    expect(claim).toBeDefined();
    const sql = String(claim?.[0]).replace(/\\s+/g, " ");
    expect(sql).toContain("business_service_activations");
    expect(sql).toContain("activation.state = ANY($2::text[])");
    const params = claim?.[1] as [string, string[]];
    const ownership = JSON.parse(params[0]) as Array<{ entity_key: string; service_kind: string; service_key: string }>;
    expect(ownership).toContainEqual({ entity_key: "crm.customers", service_kind: "app", service_key: "crm" });
    expect(ownership).toContainEqual({ entity_key: "workspace.projects", service_kind: "workspace", service_key: "projects" });
    expect(params[1]).toContain("disabled_retained");
    expect(params[1]).toContain("purge_failed");
  });

  it("parks exhausted jobs under the same bypass rather than leaving them queued", async () => {
    const { runImportQueueTick } = await import("./import-service");

    await runImportQueueTick();

    const park = statements().find((s) => s.sql.includes("SET status = 'failed'"));
    expect(park).toBeDefined();
    expect(park?.scope).toBe("bypass:platform");
  });

  it("performs a claimed job inside its own business's scope, never the bypass", async () => {
    const { runImportQueueTick } = await import("./import-service");

    // The claim returns one job; everything after it must be tenant-scoped.
    // Keyed on the statement rather than on call order, so adding another
    // queue-level statement cannot silently turn this into a different test.
    let claimedOnce = false;
    vi.mocked(query).mockImplementation(async (sql: unknown) => {
      scopes.push(current);
      if (String(sql).includes("SET status = 'running'") && !claimedOnce) {
        claimedOnce = true;
        return {
          rows: [
            {
              id: "job-1",
              business_id: "biz-1",
              location_id: null,
              created_by: null,
              created_by_name: "مالک",
              attempts: 0,
            },
          ],
          rowCount: 1,
        } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });

    const claimed = await runImportQueueTick();

    expect(claimed).toBe(1);
    expect(vi.mocked(withTenant)).toHaveBeenCalledWith("biz-1", expect.any(Function));
    // `runImportJob` throws (the job cannot be loaded from an empty mock), and
    // the tick's own error path records that against the job — inside the
    // business's scope, because it is a write to that business's row.
    const all = statements();
    const afterClaim = all.slice(all.findIndex((s) => s.sql.includes("SET status = 'running'")) + 1);
    expect(afterClaim.length).toBeGreaterThan(0);
    for (const statement of afterClaim) {
      expect(statement.scope).toBe("tenant:biz-1");
    }
  });

  it("never lets one business's failure escape and stop the tick", async () => {
    const { runImportQueueTick } = await import("./import-service");

    // Everything after the claim fails, including the error path's own
    // recovery write — the realistic shape of "the database went away", and
    // the case where the handler runs straight into the same wall it is
    // handling.
    let claimed = false;
    vi.mocked(query).mockImplementation(async (sql: unknown) => {
      scopes.push(current);
      if (String(sql).includes("SET status = 'running'") && !claimed) {
        claimed = true;
        return {
          rows: [
            {
              id: "job-1",
              business_id: "biz-1",
              location_id: null,
              created_by: null,
              created_by_name: "مالک",
              attempts: 0,
            },
          ],
          rowCount: 1,
        } as never;
      }
      if (!claimed) return { rows: [], rowCount: 0 } as never;
      throw new Error("database is on fire");
    });

    // A throwing tick would be retried forever by the scheduler and would take
    // every *other* business's queued job down with it.
    await expect(runImportQueueTick()).resolves.toBe(1);
  });

  it("returns jobs abandoned mid-flight to the queue before claiming new work", async () => {
    const { runImportQueueTick } = await import("./import-service");

    await runImportQueueTick();

    const all = statements();
    const sweepIndex = all.findIndex((s) => s.sql.includes("status = 'running' AND started_at <"));
    const claimIndex = all.findIndex((s) => s.sql.includes("SET status = 'running'"));

    expect(sweepIndex).toBeGreaterThanOrEqual(0);
    // Order matters: sweeping after the claim would leave a reclaimed job
    // waiting a whole extra tick for no reason.
    expect(sweepIndex).toBeLessThan(claimIndex);
    expect(all[sweepIndex].scope).toBe("bypass:platform");
  });

  it("parks a job that has stalled its full allowance of attempts", async () => {
    const { reclaimStalledImports } = await import("./import-service");

    await reclaimStalledImports();

    const sweep = statements().find((s) => s.sql.includes("status = 'running' AND started_at <"));
    // A worker that dies on the same job every time must not cycle forever;
    // the attempt ceiling turns it into a visible failure in the history.
    expect(sweep?.sql).toContain("WHEN attempts >= 3 THEN 'failed'");
    expect(sweep?.sql).toContain("ELSE 'queued'");
  });

  it("survives a sweep that itself fails, and still claims", async () => {
    const { runImportQueueTick } = await import("./import-service");

    vi.mocked(query).mockImplementation(async (sql: unknown) => {
      scopes.push(current);
      if (String(sql).includes("started_at <")) throw new Error("sweep exploded");
      return { rows: [], rowCount: 0 } as never;
    });

    await expect(runImportQueueTick()).resolves.toBe(0);
    expect(statements().some((s) => s.sql.includes("SET status = 'running'"))).toBe(true);
  });
});

describe("runScheduledExportsTick", () => {
  it("claims due schedules under the platform bypass", async () => {
    const { runScheduledExportsTick } = await import("./schedule-service");

    await runScheduledExportsTick();

    const claim = statements().find((s) => s.sql.includes("data_scheduled_exports"));
    expect(claim).toBeDefined();
    expect(claim?.scope).toBe("bypass:platform");
  });
});

describe("pruneExpiredExports", () => {
  it("sweeps deployment-wide under the platform bypass", async () => {
    const { pruneExpiredExports } = await import("./export-service");

    await pruneExpiredExports();

    const sweep = statements().find((s) => s.sql.includes("data_export_jobs SET content = NULL"));
    expect(sweep).toBeDefined();
    expect(sweep?.scope).toBe("bypass:platform");
  });
});
