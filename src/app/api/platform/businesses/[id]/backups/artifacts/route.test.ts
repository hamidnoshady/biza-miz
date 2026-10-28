import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  business: vi.fn(),
  profile: vi.fn(),
  inventory: vi.fn(),
  custody: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("@/lib/tenant-backup-artifacts-service", () => ({
  tenantBackupInventory: mocks.inventory,
  businessCustodySummary: mocks.custody,
}));

import { GET } from "./route";

const request = new NextRequest("http://app/api/platform/businesses/business-a/backups/artifacts");
const context = { params: Promise.resolve({ id: "business-a" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { padmin: "admin-1" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.profile.mockResolvedValue({ profile: "local" });
  mocks.inventory.mockResolvedValue({
    profile: "local",
    connectivity: "unknown",
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    pages: 1,
    summary: { cloudBytes: 0 },
    includedBytes: 0,
  });
  mocks.custody.mockResolvedValue({ scheme: "managed_envelope_v1", activeVersion: 2, versions: [], legacyArtifacts: false });
});

it("requires the per-business metadata capability before reading anything", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await GET(request, context)).status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.read");
  expect(mocks.business).not.toHaveBeenCalled();
  expect(mocks.inventory).not.toHaveBeenCalled();
});

it("returns 404 for an unknown business without querying its inventory", async () => {
  mocks.business.mockResolvedValue(null);
  expect((await GET(request, context)).status).toBe(404);
  expect(mocks.inventory).not.toHaveBeenCalled();
  expect(mocks.custody).not.toHaveBeenCalled();
});

it("scopes to the path business, audits the view and stays non-cacheable", async () => {
  const response = await GET(request, context);
  expect(mocks.inventory).toHaveBeenCalledWith(
    "business-a",
    expect.objectContaining({ profile: "local", connectivity: "unknown" }),
  );
  expect(mocks.custody).toHaveBeenCalledWith("business-a", { legacyArtifacts: false });
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      adminId: "admin-1",
      businessId: "business-a",
      action: "tenant_backup.artifacts_viewed",
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.metadataOnly).toBe(true);
  expect(body.custody.activeVersion).toBe(2);
  // Custody diagnostics must never carry wrapped key material.
  expect(JSON.stringify(body)).not.toContain("wrapped");
});
