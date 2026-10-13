import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as reportsService from "@/lib/reports-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (h: (...args: unknown[]) => Promise<Response>) => h,
  };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return { ...actual, getBusinessOverview: vi.fn(async () => ({ branches: [], consolidated: {} })) };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

function getRequest(qs = "") {
  return { nextUrl: new URL(`http://localhost:3000/api/reports/business-overview${qs}`) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("GET /api/reports/business-overview", () => {
  it("guards consolidated cross-branch numbers with their own elevated capability", async () => {
    // Issue #819: the route's comment claimed Owner-only while the guard was
    // plain `reports.view`, so hiding the tab was the whole boundary.
    await GET(getRequest());
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.business_wide");
    expect(reportsService.getBusinessOverview).toHaveBeenCalledWith("biz-1", {
      dateFrom: undefined,
      dateTo: undefined,
    });
  });

  it("passes the requested range through", async () => {
    await GET(getRequest("?dateFrom=2026-01-01&dateTo=2026-01-31"));
    expect(reportsService.getBusinessOverview).toHaveBeenCalledWith("biz-1", {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
  });

  it("returns the denial without reading any consolidated data", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(reportsService.getBusinessOverview).not.toHaveBeenCalled();
  });
});
