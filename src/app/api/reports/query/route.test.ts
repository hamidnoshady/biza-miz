import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as reportsService from "@/lib/reports-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (h: (...args: unknown[]) => Promise<Response>) => h,
  };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return { ...actual, runCustomReportQuery: vi.fn() };
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
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-b" } as never);
  vi.mocked(reportsService.runCustomReportQuery).mockResolvedValue([] as never);
});

describe("POST /api/reports/query", () => {
  it("guards with the read capability, not the export capability (issue #819)", async () => {
    await POST(postRequest(CONFIG));
    const permission = vi.mocked(auth.requirePermission).mock.calls[0][0];
    expect(permission).toBe("reports.view");
  });

  it("scopes the report to the caller's resolved active branch", async () => {
    await POST(postRequest(CONFIG));
    expect(setupState.resolveActiveLocation).toHaveBeenCalledTimes(1);
    expect(reportsService.runCustomReportQuery).toHaveBeenCalledWith("biz-1", CONFIG, "loc-b");
  });

  it("never trusts a client-supplied location — the body's locationId is ignored", async () => {
    await POST(postRequest({ ...CONFIG, locationId: "loc-a" }));
    const call = vi.mocked(reportsService.runCustomReportQuery).mock.calls[0];
    expect(call[0]).toBe("biz-1");
    // The third argument — the one that reaches the SQL — is the *resolved*
    // branch, never the "loc-a" the caller put in the body.
    expect(call[2]).toBe("loc-b");
  });

  it("still runs when the member has no accessible branch (single-location legacy shape)", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    await POST(postRequest(CONFIG));
    expect(reportsService.runCustomReportQuery).toHaveBeenCalledWith("biz-1", CONFIG, undefined);
  });

  it("rejects an invalid config before any query runs", async () => {
    const response = await POST(postRequest({ ...CONFIG, metric: "no_such_metric" }));
    expect(response.status).toBe(400);
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });

  it("returns the caller's guard error without querying", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(postRequest(CONFIG));
    expect(response.status).toBe(403);
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });
});
