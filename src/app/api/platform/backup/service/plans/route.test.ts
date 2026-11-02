/**
 * Issue #903 §3 — the console's per-plan policy endpoints.
 *
 * What is pinned here is the refusal surface, because a policy route is only as
 * safe as what it declines: an unknown field is a 400 rather than a silently
 * dropped setting, a plan that does not exist is a 404 rather than a row no
 * business can ever inherit, and every successful write is audited with the
 * fields it actually asked for.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  audit: vi.fn(),
  fleet: vi.fn(),
  plans: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  query: vi.fn(),
  scope: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/db", () => ({ query: mocks.query, withoutTenantScope: mocks.scope }));
vi.mock("@/lib/tenant-backup-storage", () => ({ resolveTenantBackupPolicy: mocks.fleet }));
vi.mock("@/lib/tenant-backup-plan-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-backup-plan-policy")>();
  return {
    ...actual,
    listBackupPlanPolicies: mocks.plans,
    writeBackupPlanPolicy: mocks.write,
    clearBackupPlanPolicy: mocks.clear,
  };
});

import { DELETE, GET, PUT } from "./route";

function put(body: unknown) {
  return PUT(
    new NextRequest("http://app/api/platform/backup/service/plans", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { padmin: "admin-1" } });
  mocks.audit.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(undefined);
  mocks.plans.mockResolvedValue({});
  mocks.fleet.mockResolvedValue({ intervalHours: 24, alertFailureStreak: 1, drillIntervalHours: 24 });
  mocks.scope.mockImplementation(async (_tag: string, fn: () => Promise<unknown>) => fn());
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM billing_plans WHERE key")) {
      const exists = params?.[0] === "pro" || params?.[0] === "base";
      return { rows: exists ? [{ key: params?.[0] as string }] : [], rowCount: exists ? 1 : 0 };
    }
    if (sql.includes("FROM billing_plans")) {
      return { rows: [{ key: "base", name: "پایه" }, { key: "pro", name: "حرفه‌ای" }], rowCount: 2 };
    }
    return { rows: [], rowCount: 0 };
  });
});

it("lists every plan in the catalogue, including the ones that never decided anything", async () => {
  mocks.plans.mockResolvedValue({
    pro: {
      intervalHours: 6,
      retentionDays: null,
      keepCount: null,
      protectedCopies: null,
      maxArtifactBytes: null,
      alertStaleHours: null,
      alertFailureStreak: null,
      drillIntervalHours: null,
      drRpoHours: null,
    },
  });

  const response = await GET();
  const body = (await response.json()) as {
    plans: { planKey: string; name: string; policy: unknown }[];
    fleet: unknown;
  };

  expect(response.status).toBe(200);
  // The base plan has no policy: that is an answer ("inherits everything"), and
  // hiding it would hide the question the console exists to ask.
  expect(body.plans).toEqual([
    { planKey: "base", name: "پایه", policy: null },
    { planKey: "pro", name: "حرفه‌ای", policy: expect.objectContaining({ intervalHours: 6 }) },
  ]);
  expect(body.fleet).toBeTruthy();
});

it("writes a plan policy and audits the fields the operator actually set", async () => {
  const response = await put({ planKey: "pro", intervalHours: 6, alertStaleHours: 8, note: "tier decision" });
  expect(response.status).toBe(200);

  expect(mocks.write).toHaveBeenCalledWith(
    "pro",
    expect.objectContaining({ intervalHours: 6, alertStaleHours: 8, note: "tier decision", updatedBy: "admin-1" }),
  );
  const audit = mocks.audit.mock.calls[0][0] as { action: string; payload: { planKey: string; keys: string[] } };
  expect(audit.action).toBe("tenant_backup.plan_policy.update");
  expect(audit.payload.planKey).toBe("pro");
  expect(audit.payload.keys).toEqual(expect.arrayContaining(["intervalHours", "alertStaleHours"]));
});

it("refuses a policy for a plan that does not exist, rather than creating an orphan row", async () => {
  const response = await put({ planKey: "ghost", intervalHours: 6 });
  expect(response.status).toBe(404);
  expect((await response.json()).error).toBe("unknown_plan");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("refuses an unknown or out-of-range field instead of dropping it", async () => {
  expect((await put({ planKey: "pro", intervalHour: 6 })).status).toBe(400);
  expect((await put({ planKey: "pro", intervalHours: 7 })).status).toBe(400);
  expect((await put({ planKey: "pro", alertFailureStreak: 99 })).status).toBe(400);
  expect((await put({ planKey: "" })).status).toBe(400);
  expect(mocks.write).not.toHaveBeenCalled();
});

it("needs the policy capability to write, and only the read capability to list", async () => {
  mocks.permission.mockResolvedValueOnce({ error: new Response(null, { status: 403 }) });
  expect((await GET()).status).toBe(403);

  mocks.permission.mockResolvedValueOnce({ error: new Response(null, { status: 403 }) });
  expect((await put({ planKey: "pro", intervalHours: 6 })).status).toBe(403);
  expect(mocks.write).not.toHaveBeenCalled();
});

it("clears a plan's policy on request, returning its businesses to the fleet", async () => {
  const response = await DELETE(
    new NextRequest("http://app/api/platform/backup/service/plans?planKey=pro", { method: "DELETE" }),
  );
  expect(response.status).toBe(200);
  expect(mocks.clear).toHaveBeenCalledWith("pro");
  expect((mocks.audit.mock.calls[0][0] as { action: string }).action).toBe("tenant_backup.plan_policy.clear");
});

it("refuses a clear without a plan key", async () => {
  const response = await DELETE(new NextRequest("http://app/api/platform/backup/service/plans", { method: "DELETE" }));
  expect(response.status).toBe(400);
  expect(mocks.clear).not.toHaveBeenCalled();
});
