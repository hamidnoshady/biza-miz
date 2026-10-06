import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTenantScope, runInTenantScope } from "./tenant-context";
const mock = vi.hoisted(() => ({ query: vi.fn(), cms: vi.fn(), managers: vi.fn(), wp: vi.fn(), sales: vi.fn(), pnl: vi.fn(), usage: vi.fn() }));
vi.mock("./db", async () => {
  const context = await import("./tenant-context");
  return { query: mock.query, getPool: vi.fn(), withTenant: (id: string, fn: () => unknown) => context.runInTenantScope(context.businessScope(id), fn) };
});
vi.mock("./app-availability-service", () => ({ effectiveAppAvailability: async () => Object.fromEntries(["accounting", "crm", "growth", "website"].map((a) => [a, { usable: true }])) }));
vi.mock("./deployment-mode", () => ({ readDeploymentProfile: async () => ({ profile: "cloud" }) }));
vi.mock("./features", () => ({ effectiveFeatures: async () => ({ reporting: true }) }));
vi.mock("./cms/website-service", () => ({ cmsWebsiteOverview: mock.cms }));
vi.mock("./website/managers-service", () => ({ websiteManagersState: mock.managers }));
vi.mock("./integrations/wp-manager-service", () => ({ wpOverviewStats: mock.wp }));
vi.mock("./platform-service", () => ({ businessUsage: mock.usage }));
vi.mock("./reports-service", () => ({ getBusinessOverview: mock.sales, getProfitAndLoss: mock.pnl }));
import { withBusinessReporting, platformReportSection } from "./platform-business-reporting";
const id = "8a9f9b8b-3198-4ce0-9983-7164521228a7";
beforeEach(() => { vi.clearAllMocks(); mock.query.mockResolvedValue({ rows: [{ id, industry: "food_service" }] }); });
const read = (section: string) => runInTenantScope({ kind: "bypass", reason: "platform" }, () => withBusinessReporting(id, { compare: false }, (context) => platformReportSection(context, section)));
describe("platform report orchestration", () => {
  it("re-enters tenant scope, restores bypass, and does not eagerly run app/remote reports", async () => {
    for (const fn of [mock.sales, mock.pnl, mock.usage]) fn.mockImplementation(async () => {
      expect(getTenantScope()).toMatchObject({ kind: "business", businessId: id }); return {};
    });
    await runInTenantScope({ kind: "bypass", reason: "platform" }, async () => {
      await withBusinessReporting(id, { compare: false }, (ctx) => platformReportSection(ctx, "overview"));
      expect(getTenantScope()).toEqual({ kind: "bypass", reason: "platform" });
    });
    expect(mock.sales).toHaveBeenCalledTimes(1); expect(mock.pnl).toHaveBeenCalledTimes(1);
    expect(mock.cms).not.toHaveBeenCalled(); expect(mock.wp).not.toHaveBeenCalled();
  });
  it("isolates CMS failures and never starts CMS when reading WordPress", async () => {
    mock.cms.mockRejectedValue(new Error("API secret")); mock.managers.mockRejectedValue(new Error("unreachable"));
    const cms = await read("cms");
    expect(JSON.stringify(cms)).not.toContain("API secret");
    expect(cms).toMatchObject({ overview: { error: "report_unavailable" } });
    mock.cms.mockClear(); mock.wp.mockResolvedValue({ orders: 10 });
    expect(await read("websites")).toMatchObject({ wp: { data: { orders: 10 }, error: null } });
    expect(mock.cms).not.toHaveBeenCalled();
  });
  it("preserves good overview panels when another fails", async () => {
    mock.sales.mockRejectedValue(new Error("private SQL")); mock.pnl.mockResolvedValue({ totalRevenue: 10000 }); mock.usage.mockResolvedValue({ openOrders: 3 });
    expect(await read("overview")).toMatchObject({ sales: { error: "report_unavailable" }, accounting: { data: { totalRevenue: 10000 } }, activity: { data: { openOrders: 3 } } });
  });
});
