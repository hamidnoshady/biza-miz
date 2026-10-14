import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), scope: vi.fn(), section: vi.fn(), standard: vi.fn(), custom: vi.fn() }));
vi.mock("./platform-auth", () => ({ withPlatformScope: (handler: unknown) => handler, requirePlatformCapability: mocks.guard }));
vi.mock("./platform-business-reporting", () => ({ withBusinessReporting: mocks.scope, platformReportSection: mocks.section, platformStandardReport: mocks.standard, platformCustomReport: mocks.custom }));
import { platformReportRoute } from "./platform-report-route";
const params = { params: Promise.resolve({ id: "8a9f9b8b-3198-4ce0-9983-7164521228a7", section: "overview" }) };
beforeEach(() => vi.resetAllMocks());
describe("one authoritative platform reporting guard", () => {
  it.each(["section", "standard", "query"] as const)("enforces the dedicated capability on %s before resolving a business", async (kind) => {
    mocks.guard.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    const response = await platformReportRoute(kind)(new NextRequest("http://test"), params);
    expect(response.status).toBe(403);
    expect(mocks.guard).toHaveBeenCalledWith("business.reports.read");
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("returns a generic error rather than provider secrets", async () => {
    mocks.guard.mockResolvedValue({ error: null });
    mocks.scope.mockRejectedValue(new Error("Authorization: Bearer SECRET"));
    const response = await platformReportRoute("section")(new NextRequest("http://test"), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "report_unavailable" });
  });
  it("rejects an oversized query before tenant services", async () => {
    mocks.guard.mockResolvedValue({ error: null });
    const response = await platformReportRoute("query")(new NextRequest("http://test", { method: "POST", body: "x".repeat(16385) }), params);
    expect(response.status).toBe(413); expect(mocks.scope).not.toHaveBeenCalled();
  });
});
