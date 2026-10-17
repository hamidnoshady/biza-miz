import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  exportShareholderEventsCsv: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/lib/shareholder-read-service", () => ({
  exportShareholderEventsCsv: mocks.exportShareholderEventsCsv,
}));

const session = { businessId: "business-1", sub: "viewer-1", role: "accountant" as const };
const membership = { role: "accountant", permissions: new Set([PERMISSIONS.shareholdersView]) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ session, membership, error: null });
  mocks.exportShareholderEventsCsv.mockResolvedValue("event_id\r\n");
});

describe("GET /api/accounting/shareholders/events/export", () => {
  it("authorizes the export and forwards only the requested filters under the session tenant", async () => {
    const request = new NextRequest(
      "http://localhost/api/accounting/shareholders/events/export?dateFrom=2025-01-01&dateTo=2025-12-31&partyId=550e8400-e29b-41d4-a716-446655440000&category=ownership",
    );
    const response = await GET(request) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.shareholdersView);
    expect(mocks.exportShareholderEventsCsv).toHaveBeenCalledWith(
      session.businessId,
      expect.objectContaining({ userId: session.sub, role: session.role, permissions: membership.permissions }),
      {
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
        partyId: "550e8400-e29b-41d4-a716-446655440000",
        eventType: null,
        category: "ownership",
      },
    );
    await expect(response.text()).resolves.toBe("event_id\r\n");
  });

  it("refuses history export before invoking the exporter without shareholders.view", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    mocks.requirePermission.mockResolvedValue({ session: null, membership: null, error: denied });

    const response = await GET(new NextRequest("http://localhost/api/accounting/shareholders/events/export")) as Response;

    expect(response.status).toBe(403);
    expect(mocks.exportShareholderEventsCsv).not.toHaveBeenCalled();
  });
});
