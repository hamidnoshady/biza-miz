import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  config: vi.fn(),
  policy: vi.fn(),
  localOnly: vi.fn(),
  role: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/backup-service", () => ({ getBackupConfig: mocks.config }));
vi.mock("@/lib/tenant-backup-storage", () => ({ resolveTenantBackupPolicy: mocks.policy }));
vi.mock("@/lib/deployment-mode", () => ({ isLocalOnly: mocks.localOnly }));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: mocks.role }));

import * as route from "./route";

const session = { businessId: "business-a", sub: "user-a" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session });
  mocks.config.mockResolvedValue({
    enabled: false,
    intervalHours: 24,
    anchorTime: "03:30",
    localRetention: 14,
    directory: "/srv/backups",
    secondaryDirectory: "",
    cloud: { enabled: false },
  });
  mocks.policy.mockResolvedValue({
    intervalHours: 6,
    retentionDays: 45,
    maxRetentionDays: 365,
    keepCount: 30,
    source: "managed",
    managedCloud: true,
  });
  mocks.localOnly.mockResolvedValue(false);
  mocks.role.mockReturnValue("central");
});

/**
 * Issue #903 §3 (owner decision 2026-10-28): the tenant route may only *read*
 * the policy, and it reports the policy actually in force rather than the
 * tenant's former stored schedule.
 */
it("requires the backup capability before answering", async () => {
  mocks.permission.mockResolvedValue({
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  });
  const response = await route.GET();
  expect(response.status).toBe(403);
  expect(mocks.policy).not.toHaveBeenCalled();
});

it("reports the platform's schedule as read-only and never the stored tenant value", async () => {
  const body = await (await route.GET()).json();
  expect(body.editable).toBe(false);
  expect(body.policy).toEqual({ intervalHours: 6, retentionDays: 45, source: "managed" });
  // The stored config still says 24h; the answer must not repeat it as a plan.
  expect(body.config.intervalHours).toBe(24);
});

it("does not expose a mutation handler at all", () => {
  const handlers = route as unknown as Record<string, unknown>;
  expect(handlers.PUT).toBeUndefined();
  expect(handlers.POST).toBeUndefined();
  expect(handlers.PATCH).toBeUndefined();
  expect(handlers.DELETE).toBeUndefined();
});

it("hides local infrastructure from a central install", async () => {
  const body = await (await route.GET()).json();
  expect(body.siteInstall).toBe(false);
  expect(body.config.directory).toBeUndefined();
});
