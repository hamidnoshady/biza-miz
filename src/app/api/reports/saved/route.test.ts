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
    ensureStandardSavedReports: vi.fn(async () => new Map()),
    listSavedReports: vi.fn(async () => []),
    createSavedReport: vi.fn(async () => "report-1"),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const CONFIG = {
  view: "v_sales_by_day",
  metric: "order_count",
  aggregation: "sum" as const,
  dimension: "day",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("/api/reports/saved", () => {
  it("reads the list on the report-view capability", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
  });

  it("creates a saved report on the manage capability, not on export (issue #819)", async () => {
    const response = await POST(postRequest({ name: "فروش روزانه", config: CONFIG }));
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.manage");
    expect(reportsService.createSavedReport).toHaveBeenCalled();
  });

  it("refuses to create when the member may only read and export", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    } as never);
    const response = await POST(postRequest({ name: "فروش روزانه", config: CONFIG }));
    expect(response.status).toBe(403);
    expect(reportsService.createSavedReport).not.toHaveBeenCalled();
  });

  it("passes an optional description through to storage, and null when absent", async () => {
    await POST(
      postRequest({ name: "فروش روزانه", description: "پرسش مدیر", config: CONFIG }),
    );
    expect(reportsService.createSavedReport).toHaveBeenLastCalledWith(
      "biz-1",
      "user-1",
      "فروش روزانه",
      CONFIG,
      "پرسش مدیر",
    );

    await POST(postRequest({ name: "بی‌توضیح", config: CONFIG }));
    expect(reportsService.createSavedReport).toHaveBeenLastCalledWith(
      "biz-1",
      "user-1",
      "بی‌توضیح",
      CONFIG,
      null,
    );
  });

  it("rejects a nameless or invalid report before writing", async () => {
    expect((await POST(postRequest({ config: CONFIG }))).status).toBe(400);
    const invalid = await POST(postRequest({ name: "x", config: { ...CONFIG, view: "nope" } }));
    expect(invalid.status).toBe(400);
    expect(reportsService.createSavedReport).not.toHaveBeenCalled();
  });
});
