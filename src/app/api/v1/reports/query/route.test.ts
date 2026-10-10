import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { API_SCOPES } from "@/lib/api-scopes";
import * as industryGuard from "@/lib/industry-guard";
import * as reportsService from "@/lib/reports-service";
import { GET } from "./route";

const injectedKey = vi.hoisted(() => ({
  apiKeyId: "key-a",
  businessId: "biz-a",
  locationId: "loc-a",
  scopes: ["reports.read"],
}));

vi.mock("@/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auth")>();
  return {
    ...actual,
    withApiKeyScope: (handler: (apiKey: unknown, request: unknown) => Promise<Response>) =>
      (request: unknown) => handler(injectedKey, request),
  };
});
vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, getBusinessIndustry: vi.fn(async () => "food_service") };
});
vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return { ...actual, runCustomReportQuery: vi.fn(async () => [{ marker: true }]) };
});

function request(query = "") {
  return { url: `http://localhost/api/v1/reports/query${query}` } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(injectedKey, {
    apiKeyId: "key-a",
    businessId: "biz-a",
    locationId: "loc-a",
    scopes: [API_SCOPES.reportsRead],
  });
});

describe("GET /api/v1/reports/query", () => {
  it("runs the query only in the API key's pinned branch", async () => {
    const response = await GET(request("?view=v_sales_by_day&metric=total&aggregation=sum&dimension=day"));
    expect(response.status).toBe(200);
    expect(industryGuard.getBusinessIndustry).toHaveBeenCalledWith("biz-a");
    expect(reportsService.runCustomReportQuery).toHaveBeenCalledWith(
      "biz-a",
      expect.objectContaining({ view: "v_sales_by_day" }),
      { mode: "branch", locationId: "loc-a" },
    );
  });

  it("refuses a key without a live branch instead of widening to the business", async () => {
    injectedKey.locationId = "";
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_accessible_branch" });
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });

  it("does not offer business-wide reads through a branch-pinned machine credential", async () => {
    const response = await GET(request("?scope=business-wide"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "scope_not_supported" });
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });
});
