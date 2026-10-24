import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({
  permission: vi.fn(), business: vi.fn(), profile: vi.fn(), runs: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/backup-service", () => ({ listBackupRuns: mocks.runs }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
import { GET } from "./route";
const request = new NextRequest("http://app/api/platform/businesses/business-a/backups");
const context = { params: Promise.resolve({ id: "business-a" }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { padmin: "admin" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.profile.mockResolvedValue({ profile: "hybrid" });
  mocks.runs.mockResolvedValue([]);
});
it("requires the separate metadata capability before reading any business", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await GET(request, context)).status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.read");
  expect(mocks.business).not.toHaveBeenCalled();
  expect(mocks.runs).not.toHaveBeenCalled();
});
it("returns not found without querying backup records", async () => {
  mocks.business.mockResolvedValue(null);
  expect((await GET(request, context)).status).toBe(404);
  expect(mocks.runs).not.toHaveBeenCalled();
});
it("scopes metadata and audit to the path business, with no cache", async () => {
  const response = await GET(request, context);
  expect(mocks.runs).toHaveBeenCalledWith("business-a");
  expect(mocks.profile).toHaveBeenCalledWith("business-a");
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ businessId: "business-a", adminId: "admin" }));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).summary.deviceAvailability).toBe("unknown");
});
