import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  business: vi.fn(),
  audit: vi.fn(),
  grant: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  owned: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/tenant-backup-artifacts-service", () => ({ resolveOwnedArtifact: mocks.owned }));
vi.mock("@/lib/tenant-backup-approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-backup-approvals")>();
  return {
    ...actual,
    grantRestoreApproval: mocks.grant,
    listRestoreApprovals: mocks.list,
    revokeRestoreApproval: mocks.revoke,
  };
});

import { DELETE, GET, POST } from "./route";

const context = { params: Promise.resolve({ id: "business-a" }) };
const request = new NextRequest("http://app/api/platform/businesses/business-a/backups/approvals");

function post(body: unknown) {
  return POST(
    new NextRequest("http://app/api/platform/businesses/business-a/backups/approvals", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    context,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { padmin: "admin-1" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.audit.mockResolvedValue(undefined);
  mocks.owned.mockResolvedValue({ storageRef: "a.dump.enc", state: "ready" });
  mocks.list.mockResolvedValue([]);
  mocks.revoke.mockResolvedValue(true);
  mocks.grant.mockResolvedValue({
    id: "approval-1",
    artifactRef: "ref-1",
    approvedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-02T00:00:00.000Z",
    consumedAt: null,
    consumedJournalId: null,
    approvedBy: "admin-1",
    note: "",
  });
});

it("requires the privileged-restore capability to read or grant consent", async () => {
  mocks.permission.mockResolvedValue({
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  });
  expect((await GET(request, context)).status).toBe(403);
  expect((await post({ ref: "ref-1" })).status).toBe(403);
  expect(mocks.grant).not.toHaveBeenCalled();
});

it("will not approve an artifact this business does not own", async () => {
  mocks.owned.mockResolvedValue(null);
  const response = await post({ ref: "foreign-ref" });
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({ error: "artifact_not_found" });
  expect(mocks.grant).not.toHaveBeenCalled();
});

it("grants named, expiring consent and audits it", async () => {
  const response = await post({ ref: "ref-1", ttlMinutes: 60, note: "owner called" });
  expect(response.status).toBe(200);
  expect(mocks.grant).toHaveBeenCalledWith(
    expect.objectContaining({
      businessId: "business-a",
      artifactRef: "ref-1",
      approvedBy: "admin-1",
      ttlMinutes: 60,
      note: "owner called",
    }),
  );
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "tenant_backup.restore.approve", businessId: "business-a" }),
  );
});

it("defaults the window when the caller does not choose one", async () => {
  await post({ ref: "ref-1" });
  expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ ttlMinutes: 24 * 60 }));
});

it("refuses an empty reference and an over-long note", async () => {
  expect((await post({})).status).toBe(400);
  expect((await post({ ref: "ref-1", note: "x".repeat(501) })).status).toBe(400);
  expect(mocks.grant).not.toHaveBeenCalled();
});

it("reports consent that can no longer be withdrawn instead of pretending", async () => {
  mocks.revoke.mockResolvedValue(false);
  const response = await DELETE(
    new NextRequest("http://app/api/platform/businesses/business-a/backups/approvals?approvalId=approval-1"),
    context,
  );
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ error: "approval_not_revocable" });
});

it("revokes an unused approval", async () => {
  const response = await DELETE(
    new NextRequest("http://app/api/platform/businesses/business-a/backups/approvals?approvalId=approval-1"),
    context,
  );
  expect(response.status).toBe(200);
  expect(mocks.revoke).toHaveBeenCalledWith("business-a", "approval-1");
});
