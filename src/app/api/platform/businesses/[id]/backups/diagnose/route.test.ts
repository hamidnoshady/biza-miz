import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  business: vi.fn(),
  diagnose: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: vi.fn(),
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/platform-tenant-backup-ops", () => ({ diagnoseBusinessBackup: mocks.diagnose }));

import { GET } from "./route";

const request = new NextRequest("http://app/api/platform/businesses/business-a/backups/diagnose");
const context = { params: Promise.resolve({ id: "business-a" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { padmin: "admin" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.diagnose.mockResolvedValue({ businessId: "business-a", actions: [], artifacts: { total: 0 } });
});

it("needs the metadata capability and never writes", async () => {
  mocks.permission.mockResolvedValue({
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  });
  expect((await GET(request, context)).status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.read");
  expect(mocks.diagnose).not.toHaveBeenCalled();
});

it("scopes the diagnosis to the path business and does not cache it", async () => {
  const response = await GET(request, context);
  const body = await response.json();
  expect(mocks.diagnose).toHaveBeenCalledWith("business-a");
  expect(body.diagnosis.businessId).toBe("business-a");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("answers 404 for an unknown business", async () => {
  mocks.business.mockResolvedValue(null);
  expect((await GET(request, context)).status).toBe(404);
  expect(mocks.diagnose).not.toHaveBeenCalled();
});
