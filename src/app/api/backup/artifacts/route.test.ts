import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  profile: vi.fn(),
  inventory: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("@/lib/tenant-backup-artifacts-service", () => ({ tenantBackupInventory: mocks.inventory }));

import { GET } from "./route";

const session = { businessId: "business-a", sub: "user-a" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session });
  mocks.profile.mockResolvedValue({ profile: "hybrid" });
  mocks.inventory.mockResolvedValue({
    profile: "hybrid",
    connectivity: "unknown",
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    pages: 1,
    summary: { cloudBytes: 0 },
    includedBytes: 0,
  });
});

it("requires the tenant backup capability before reading inventory", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  const response = await GET(new NextRequest("http://app/api/backup/artifacts"));
  expect(response.status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("backup.manage");
  expect(mocks.inventory).not.toHaveBeenCalled();
});

it("scopes the inventory to the session business and reports honest connectivity", async () => {
  const response = await GET(new NextRequest("http://app/api/backup/artifacts?page=2&pageSize=5&state=ready"));
  const body = await response.json();
  expect(mocks.inventory).toHaveBeenCalledWith(
    "business-a",
    expect.objectContaining({
      profile: "hybrid",
      // A Hybrid install is not claimed online: no heartbeat is available here.
      connectivity: "unknown",
      query: expect.objectContaining({ state: "ready", page: 2, pageSize: 5 }),
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.labels.state.ready).toBe("آماده");
});

it("treats a cloud profile as online and exposes only provider-neutral labels", async () => {
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  const response = await GET(new NextRequest("http://app/api/backup/artifacts"));
  const body = await response.json();
  expect(mocks.inventory).toHaveBeenCalledWith(
    "business-a",
    expect.objectContaining({ connectivity: "online" }),
  );
  const serialised = JSON.stringify(body);
  expect(serialised).not.toContain("s3");
  expect(serialised).not.toContain("bucket");
  expect(serialised).not.toContain("storageRef");
});
