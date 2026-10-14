import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as industryGuard from "@/lib/industry-guard";
import * as reportScope from "@/lib/report-scope-service";
import * as filterOptions from "@/lib/report-filter-options-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, getBusinessIndustry: vi.fn() };
});

vi.mock("@/lib/report-scope-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/report-scope-service")>();
  return { ...actual, authorizedReportBranchScope: vi.fn() };
});

vi.mock("@/lib/report-filter-options-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/report-filter-options-service")>();
  return { ...actual, reportFilterOptions: vi.fn() };
});

const SESSION = { businessId: "business-1", sub: "user-1", role: "manager" as const };
const BRANCH_SCOPE = {
  ok: true,
  scope: { mode: "branch", locationId: "authorized-location", location: { id: "authorized-location" } },
};

function request(url: string) {
  return new NextRequest(`http://localhost/api/reports/filter-options${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(industryGuard.getBusinessIndustry).mockResolvedValue("food_service");
  vi.mocked(reportScope.authorizedReportBranchScope).mockResolvedValue(BRANCH_SCOPE as never);
  vi.mocked(filterOptions.reportFilterOptions).mockResolvedValue({
    category: [{ value: "cat-1", label: "نوشیدنی" }],
  });
});

describe("GET /api/reports/filter-options", () => {
  it("uses the authenticated business and resolved active branch, never a query-string location", async () => {
    const response = await GET(request("?view=v_menu_item_performance&locationId=attacker-location"));
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
    expect(filterOptions.reportFilterOptions).toHaveBeenCalledWith(
      "business-1",
      "authorized-location",
      "v_menu_item_performance",
    );
    await expect(response.json()).resolves.toEqual({
      options: { category: [{ value: "cat-1", label: "نوشیدنی" }] },
    });
  });

  it("rejects missing and trade-inapplicable views before loading any choices", async () => {
    const missing = await GET(request(""));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "missing_view" });

    vi.mocked(industryGuard.getBusinessIndustry).mockResolvedValue("jewelry");
    const inapplicable = await GET(request("?view=v_menu_item_performance"));
    expect(inapplicable.status).toBe(400);
    await expect(inapplicable.json()).resolves.toEqual({ error: "unknown_report_view" });
    expect(reportScope.authorizedReportBranchScope).not.toHaveBeenCalled();
    expect(filterOptions.reportFilterOptions).not.toHaveBeenCalled();
  });

  it("fails closed when the member has no authorized active branch", async () => {
    vi.mocked(reportScope.authorizedReportBranchScope).mockResolvedValue({ ok: false, reason: "no_accessible_branch" } as never);
    const response = await GET(request("?view=v_menu_item_performance"));
    expect(response.status).toBe(403);
    expect(filterOptions.reportFilterOptions).not.toHaveBeenCalled();
  });

  it("requires reports.view", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await GET(request("?view=v_menu_item_performance"));
    expect(response.status).toBe(403);
    expect(industryGuard.getBusinessIndustry).not.toHaveBeenCalled();
  });
});
