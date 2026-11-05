import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  business: vi.fn(),
  audit: vi.fn(),
  policy: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/tenant-backup-storage", () => ({ resolveTenantBackupPolicy: mocks.policy }));
vi.mock("@/lib/tenant-backup-approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-backup-approvals")>();
  return { ...actual, writeBusinessPolicyOverride: mocks.write, clearBusinessPolicyOverride: mocks.clear };
});

import { DELETE, GET, PUT } from "./route";

const context = { params: Promise.resolve({ id: "business-a" }) };
const request = new NextRequest("http://app/api/platform/businesses/business-a/backups/policy");

function put(body: unknown) {
  return PUT(
    new NextRequest("http://app/api/platform/businesses/business-a/backups/policy", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    context,
  );
}

function fleet() {
  return {
    intervalHours: 24,
    retentionDays: 30,
    maxRetentionDays: 365,
    keepCount: 30,
    protectedCopies: 1,
    source: "managed",
    managedCloud: true,
    override: false,
    requireRestoreApproval: false,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { padmin: "admin-1" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.audit.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(undefined);
  mocks.policy.mockResolvedValue(fleet());
});

it("shows the effective policy beside the fleet envelope it lives in", async () => {
  mocks.policy.mockResolvedValueOnce({ ...fleet(), retentionDays: 90, override: true });
  const body = await (await GET(request, context)).json();
  expect(body.policy).toMatchObject({ retentionDays: 90, override: true });
  expect(body.fleet).toMatchObject({ retentionDays: 30, override: false });
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.policy");
});

it("refuses a policy change without the owner-level capability", async () => {
  mocks.permission.mockResolvedValue({
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  });
  expect((await put({ intervalHours: 6 })).status).toBe(403);
  expect(mocks.write).not.toHaveBeenCalled();
});

it("refuses a cadence the scheduler cannot express, before touching SQL", async () => {
  const response = await put({ intervalHours: 7 });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "invalid_intervalHours" });
  expect(mocks.write).not.toHaveBeenCalled();
});

it("writes the override and audits the effective numbers, not the request", async () => {
  mocks.policy
    .mockResolvedValueOnce(fleet()) // before
    .mockResolvedValueOnce({ ...fleet(), retentionDays: 120, override: true }) // after
    .mockResolvedValue(fleet()); // fleet in the response

  const response = await put({ retentionDays: 120, note: "legal requirement" });
  expect(response.status).toBe(200);
  expect(mocks.write).toHaveBeenCalledWith(
    "business-a",
    expect.objectContaining({ retentionDays: 120, note: "legal requirement", updatedBy: "admin-1" }),
  );
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "tenant_backup.policy.override",
      businessId: "business-a",
      payload: expect.objectContaining({
        before: expect.objectContaining({ retentionDays: 30 }),
        after: expect.objectContaining({ retentionDays: 120 }),
      }),
    }),
  );
});

it("clears the override so the business returns to the fleet policy", async () => {
  expect((await DELETE(request, context)).status).toBe(200);
  expect(mocks.clear).toHaveBeenCalledWith("business-a");
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "tenant_backup.policy.clear" }),
  );
});

it("answers 404 for a business that does not exist", async () => {
  mocks.business.mockResolvedValue(null);
  expect((await GET(request, context)).status).toBe(404);
  expect(mocks.write).not.toHaveBeenCalled();
});
