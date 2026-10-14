import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as reportsService from "@/lib/reports-service";
import { DELETE, PATCH } from "./route";

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

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return {
    ...actual,
    deleteSavedReport: vi.fn(async () => true),
    getSavedReport: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", is_standard: false })),
    updateSavedReport: vi.fn(async () => true),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT = { params: Promise.resolve({ id: ID }) };

function patchRequest(body: unknown) {
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
  vi.mocked(reportsService.getSavedReport).mockResolvedValue({
    id: ID,
    is_standard: false,
  } as never);
  vi.mocked(reportsService.updateSavedReport).mockResolvedValue(true);
});

describe("/api/reports/saved/[id]", () => {
  it("rejects config:null rather than treating it as an omitted config", async () => {
    const response = await PATCH(patchRequest({ config: null }), CONTEXT);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_config" });
    expect(reportsService.updateSavedReport).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies and invalid configs before writing", async () => {
    expect((await PATCH(patchRequest(null), CONTEXT)).status).toBe(400);
    expect((await PATCH(patchRequest({ config: [] }), CONTEXT)).status).toBe(400);
    expect((await PATCH(patchRequest({ config: { ...CONFIG, view: "not-a-view" } }), CONTEXT)).status).toBe(400);
    expect(reportsService.updateSavedReport).not.toHaveBeenCalled();
  });

  it("updates a valid saved config only after trade-specific validation", async () => {
    const response = await PATCH(patchRequest({ config: CONFIG }), CONTEXT);
    expect(response.status).toBe(200);
    expect(reportsService.updateSavedReport).toHaveBeenCalledWith("biz-1", ID, { config: CONFIG });
  });

  it("rejects malformed names and descriptions without changing the report", async () => {
    expect((await PATCH(patchRequest({ name: 7 }), CONTEXT)).status).toBe(400);
    expect((await PATCH(patchRequest({ name: "  " }), CONTEXT)).status).toBe(400);
    expect((await PATCH(patchRequest({ description: false }), CONTEXT)).status).toBe(400);
    expect(reportsService.updateSavedReport).not.toHaveBeenCalled();
  });

  it("clears an explicitly null description and rejects malformed ids before querying", async () => {
    const response = await PATCH(patchRequest({ description: null }), CONTEXT);
    expect(response.status).toBe(200);
    expect(reportsService.updateSavedReport).toHaveBeenCalledWith("biz-1", ID, { description: null });

    vi.mocked(reportsService.getSavedReport).mockClear();
    const invalid = await PATCH(patchRequest({ name: "A" }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(invalid.status).toBe(404);
    expect(reportsService.getSavedReport).not.toHaveBeenCalled();
  });

  it("requires report-management permission for deletion", async () => {
    const response = await DELETE({} as NextRequest, CONTEXT);
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission)).toHaveBeenCalledWith("reports.manage");
    expect(reportsService.deleteSavedReport).toHaveBeenCalledWith("biz-1", ID);
  });
});
