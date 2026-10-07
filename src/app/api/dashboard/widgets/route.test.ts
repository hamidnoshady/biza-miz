import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as reportsService from "@/lib/reports-service";
import { GET, POST } from "./route";

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
  return {
    ...actual,
    getDashboardWidgets: vi.fn(async () => ({ scope: "personal", widgets: [] })),
    saveDashboardWidgets: vi.fn(async () => undefined),
    savedReportIdsInBusiness: vi.fn(async () => new Set(["report-1"])),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const WIDGET = {
  savedReportId: "report-1",
  chartType: "bar" as const,
  title: "فروش",
  x: 0,
  y: 0,
  w: 4,
  h: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue(new Set(["report-1"]) as never);
});

describe("GET /api/dashboard/widgets", () => {
  it("reads on the report-view capability", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
  });
});

describe("POST /api/dashboard/widgets — personal layout", () => {
  it("needs only the read capability, and writes the caller's own layout", async () => {
    const response = await POST(postRequest({ scope: "personal", widgets: [WIDGET] }));
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls.map((c) => c[0])).toEqual(["reports.view"]);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { userId: "user-1" },
      [expect.objectContaining({ savedReportId: "report-1" })],
    );
  });

  it("refuses a report id that does not belong to this business", async () => {
    vi.mocked(reportsService.savedReportIdsInBusiness).mockResolvedValue(new Set() as never);
    const response = await POST(postRequest({ scope: "personal", widgets: [WIDGET] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "unknown_saved_report" });
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("rejects a malformed widget before touching the database", async () => {
    const response = await POST(
      postRequest({ scope: "personal", widgets: [{ ...WIDGET, chartType: "donut" }] }),
    );
    expect(response.status).toBe(400);
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/widgets — role default layout", () => {
  it("requires the elevated role-defaults capability (issue #819)", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.dashboard_defaults.manage") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);

    const response = await POST(postRequest({ scope: "role", role: "manager", widgets: [WIDGET] }));
    expect(response.status).toBe(403);
    expect(reportsService.saveDashboardWidgets).not.toHaveBeenCalled();
  });

  it("writes the role layout when the capability is held", async () => {
    const response = await POST(postRequest({ scope: "role", role: "manager", widgets: [WIDGET] }));
    expect(response.status).toBe(200);
    expect(reportsService.saveDashboardWidgets).toHaveBeenCalledWith(
      "biz-1",
      { role: "manager" },
      expect.any(Array),
    );
  });

  it("accepts every canonical role, including admin and accountant", async () => {
    // The route used to carry its own list that predated both roles, so those
    // two could never have a default layout (issue #819).
    for (const role of ["admin", "accountant", "cashier", "waiter", "kitchen"] as const) {
      const response = await POST(postRequest({ scope: "role", role, widgets: [WIDGET] }));
      expect(response.status, role).toBe(200);
    }
  });

  it("rejects an unknown role name", async () => {
    const response = await POST(postRequest({ scope: "role", role: "supervisor", widgets: [WIDGET] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_role" });
  });
});
