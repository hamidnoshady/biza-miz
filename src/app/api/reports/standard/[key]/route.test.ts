import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as industryGuard from "@/lib/industry-guard";
import * as setupState from "@/lib/setup-state";
import * as standardReports from "@/lib/standard-report-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});
vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, getBusinessIndustry: vi.fn(async () => "food_service") };
});
vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});
vi.mock("@/lib/standard-report-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/standard-report-service")>();
  return { ...actual, runStandardReport: vi.fn(async () => ({ report: { marker: true } })) };
});

const SESSION = { businessId: "biz-a", sub: "user-a", role: "manager" };
function request(query = "") {
  return { url: `http://localhost/api/reports/standard/profit_and_loss${query}` } as unknown as NextRequest;
}
const context = { params: Promise.resolve({ key: "profit_and_loss" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({
    id: "loc-b",
    name: "شعبهٔ ب",
    timezone: "Asia/Tehran",
  } as never);
});

describe("GET /api/reports/standard/[key]", () => {
  it("runs an ordinary statement against the server-resolved branch", async () => {
    const response = await GET(request("?dateFrom=2026-01-01"), context);
    expect(response.status).toBe(200);
    expect(industryGuard.getBusinessIndustry).toHaveBeenCalledWith("biz-a");
    expect(standardReports.runStandardReport).toHaveBeenCalledWith(
      "biz-a",
      "food_service",
      expect.objectContaining({ key: "profit_and_loss" }),
      expect.objectContaining({
        scope: expect.objectContaining({ mode: "branch", locationId: "loc-b" }),
        dateFrom: "2026-01-01",
      }),
    );
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
  });

  it("ignores a client location and uses only the member's current assignment", async () => {
    await GET(request("?locationId=loc-a"), context);
    const options = vi.mocked(standardReports.runStandardReport).mock.calls[0][3];
    expect(options.scope).toEqual(
      expect.objectContaining({ mode: "branch", locationId: "loc-b", location: expect.objectContaining({ id: "loc-b" }) }),
    );
  });

  it("refuses a member whose branch assignment is gone instead of widening", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "no_accessible_branch" }));
    expect(standardReports.runStandardReport).not.toHaveBeenCalled();
  });

  it("refuses direct business-wide access to a branch-only Manager", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.business_wide") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);
    const response = await GET(request("?scope=business-wide"), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "business_wide_forbidden" }));
    expect(setupState.resolveActiveLocation).not.toHaveBeenCalled();
    expect(standardReports.runStandardReport).not.toHaveBeenCalled();
  });

  it("runs the consolidated statement only on the separate elevated path", async () => {
    const response = await GET(request("?scope=business-wide"), context);
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls.map((call) => call[0])).toEqual([
      "reports.view",
      "reports.business_wide",
    ]);
    expect(setupState.resolveActiveLocation).not.toHaveBeenCalled();
    expect(standardReports.runStandardReport).toHaveBeenCalledWith(
      "biz-a",
      "food_service",
      expect.objectContaining({ key: "profit_and_loss" }),
      expect.objectContaining({ scope: { mode: "business-wide", locationId: undefined, location: null } }),
    );
  });

  it("serves food-cost variance business-wide only through the centralized allowlist", async () => {
    const response = await GET(request("?scope=business-wide"), {
      params: Promise.resolve({ key: "food_cost_variance" }),
    });
    expect(response.status).toBe(200);
    expect(standardReports.runStandardReport).toHaveBeenCalledWith(
      "biz-a",
      "food_service",
      expect.objectContaining({ key: "food_cost_variance" }),
      expect.objectContaining({ scope: { mode: "business-wide", locationId: undefined, location: null } }),
    );
  });

  it("refuses a consolidated row dump and malformed scope values", async () => {
    const rowReport = await GET(request("?scope=business-wide"), {
      params: Promise.resolve({ key: "daily_sales_summary" }),
    });
    expect(rowReport.status).toBe(400);
    expect(standardReports.runStandardReport).not.toHaveBeenCalled();

    const malformed = await GET(request("?scope=everything"), context);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_scope" });
  });
});
