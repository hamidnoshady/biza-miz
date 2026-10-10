import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "./permissions";
import { SYSTEM_AI_READ_PERMISSIONS } from "./ai-capabilities";

const mocks = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(
    async () => ({ rows: [] }),
  ),
  resolveActiveLocationForUser: vi.fn(),
  businessToday: vi.fn(async () => "2026-06-20"),
  locationBusinessToday: vi.fn(async () => "2026-06-20"),
  getBusinessIndustry: vi.fn(async () => "food_service"),
  runStandardReportRows: vi.fn(async () => []),
  runTradeReport: vi.fn(async () => null),
  staffCommissionReport: vi.fn(async () => []),
  getArAging: vi.fn(async () => ({ rows: [] })),
  runAccountingReview: vi.fn(async () => ({ asOfDate: null, windowDays: 30, findings: [], unavailableChecks: [] })),
  listWebsitePostsTool: vi.fn(async () => ({ ok: true, data: { posts: [], hasMore: false } })),
  listWebsiteProductsTool: vi.fn(async () => ({ ok: true, data: { products: [], hasMore: false } })),
  websiteStatusTool: vi.fn(async () => ({ connected: false, adapterKey: null, siteDomain: null })),
  listMessageTemplates: vi.fn(async () => []),
  listMessageCampaigns: vi.fn(async () => []),
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  query: mocks.query,
}));
vi.mock("./setup-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-state")>()),
  resolveActiveLocationForUser: mocks.resolveActiveLocationForUser,
}));
vi.mock("./business-day-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./business-day-service")>()),
  businessToday: mocks.businessToday,
  locationBusinessToday: mocks.locationBusinessToday,
}));
vi.mock("./industry-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./industry-guard")>()),
  getBusinessIndustry: mocks.getBusinessIndustry,
}));
vi.mock("./reports-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reports-service")>()),
  runStandardReportRows: mocks.runStandardReportRows,
}));
vi.mock("./ar-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ar-service")>()),
  getArAging: mocks.getArAging,
}));
vi.mock("./accounting-review-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounting-review-service")>()),
  runAccountingReview: mocks.runAccountingReview,
}));
vi.mock("./trade-reports-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./trade-reports-service")>()),
  runTradeReport: mocks.runTradeReport,
}));
vi.mock("./commission-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commission-service")>()),
  staffCommissionReport: mocks.staffCommissionReport,
}));
vi.mock("./website/content-service", () => ({
  listWebsitePostsTool: mocks.listWebsitePostsTool,
  listWebsiteProductsTool: mocks.listWebsiteProductsTool,
  websiteStatusTool: mocks.websiteStatusTool,
}));
vi.mock("./message-campaigns-service", () => ({
  listMessageTemplates: mocks.listMessageTemplates,
  listMessageCampaigns: mocks.listMessageCampaigns,
}));

import { runReadTool } from "./ai-tools";

const BUSINESS_ID = "business-1";
const ACTOR_ID = "manager-1";
const LOCATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LOCATION_ID = "22222222-2222-4222-8222-222222222222";
const DATES = { dateFrom: "2026-06-01", dateTo: "2026-06-20" };

const BRANCH_READS = [
  {
    name: "get_menu_performance",
    permission: PERMISSIONS.menuView,
    args: DATES,
    expectedQueries: ["location_id = $4", "l.id = $2"],
  },
  {
    name: "get_void_pattern",
    permission: PERMISSIONS.ordersView,
    args: DATES,
    expectedQueries: ["l.id = $4", "l.id = $4", "l.id = $4"],
  },
  {
    name: "find_items",
    permission: PERMISSIONS.menuView,
    args: { query: "نان" },
    expectedQueries: ["l.id = $3", "l.id = $3"],
  },
  {
    name: "get_waste_history",
    permission: PERMISSIONS.inventoryView,
    args: {},
    expectedQueries: ["sm.location_id = $5"],
  },
  {
    name: "get_stock_valuation",
    permission: PERMISSIONS.inventoryView,
    args: {},
    expectedQueries: ["location_id = $2"],
  },
  {
    name: "get_supplier_performance",
    permission: PERMISSIONS.inventoryView,
    args: DATES,
    expectedQueries: ["p.location_id = $4"],
  },
  {
    name: "get_reservation_conflicts",
    permission: PERMISSIONS.reservationsView,
    args: {},
    expectedQueries: ["l.id = $2"],
  },
  {
    name: "get_table_turnover_rate",
    permission: PERMISSIONS.reportsView,
    args: DATES,
    expectedQueries: ["location_id = $4"],
  },
  {
    name: "get_courier_performance",
    permission: PERMISSIONS.deliveryManage,
    args: DATES,
    expectedQueries: ["location_id = $4"],
  },
  {
    name: "forecast_demand",
    permission: PERMISSIONS.inventoryView,
    args: { menuItemId: "33333333-3333-4333-8333-333333333333" },
    expectedQueries: ["location_id = $5"],
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.resolveActiveLocationForUser.mockResolvedValue({ id: LOCATION_ID, name: "شعبهٔ ب" });
  mocks.businessToday.mockResolvedValue("2026-06-20");
  mocks.locationBusinessToday.mockResolvedValue("2026-06-20");
  mocks.getBusinessIndustry.mockResolvedValue("food_service");
  mocks.runStandardReportRows.mockResolvedValue([]);
  mocks.runTradeReport.mockResolvedValue(null);
  mocks.staffCommissionReport.mockResolvedValue([]);
});

describe("AI/MCP operational read branch scope", () => {
  it("rejects impossible and reversed dates before resolving a branch or reaching PostgreSQL", async () => {
    for (const args of [
      { dateFrom: "2026-02-31" },
      { dateFrom: "2026-06-20", dateTo: "2026-06-01" },
    ]) {
      const result = await runReadTool(
        "get_menu_performance",
        args,
        BUSINESS_ID,
        undefined,
        ACTOR_ID,
        new Set([PERMISSIONS.menuView]),
      );
      expect(result).toMatchObject({ ok: false });
    }
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("treats blank optional range dates as absent and uses the branch business day", async () => {
    const result = await runReadTool(
      "get_menu_performance",
      { dateFrom: "   ", dateTo: "" },
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.menuView]),
    );

    expect(result.ok).toBe(true);
    expect(mocks.locationBusinessToday).toHaveBeenCalledWith(BUSINESS_ID, LOCATION_ID);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      BUSINESS_ID,
      "2026-05-22",
      "2026-06-20",
      LOCATION_ID,
    ]);
    expect(mocks.query.mock.calls.flatMap(([, params]) => params ?? [])).not.toContain("");
  });

  it("passes blank optional dates to report, finance, review, and commission services as omitted", async () => {
    await runReadTool(
      "run_report",
      { key: "daily_sales_summary", dateFrom: "", dateTo: "   " },
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.reportsView]),
    );
    expect(mocks.runStandardReportRows).toHaveBeenCalledWith(
      "daily_sales_summary",
      BUSINESS_ID,
      expect.objectContaining({ mode: "branch", locationId: LOCATION_ID }),
      { dateFrom: undefined, dateTo: undefined },
    );

    await runReadTool("get_ar_aging", { asOfDate: "  " }, BUSINESS_ID, undefined, undefined, SYSTEM_AI_READ_PERMISSIONS);
    expect(mocks.getArAging).toHaveBeenCalledWith(BUSINESS_ID, undefined);

    const vat = await runReadTool(
      "get_vat_liability",
      { dateFrom: "", dateTo: "   " },
      BUSINESS_ID,
      undefined,
      undefined,
      SYSTEM_AI_READ_PERMISSIONS,
    );
    expect(vat.data).toMatchObject({ periodFrom: null, periodTo: null });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.every(([, params]) => !params?.includes(""))).toBe(true);

    await runReadTool(
      "run_accounting_review",
      { asOfDate: "" },
      BUSINESS_ID,
      undefined,
      undefined,
      SYSTEM_AI_READ_PERMISSIONS,
    );
    expect(mocks.runAccountingReview).toHaveBeenCalledWith(BUSINESS_ID, { asOfDate: undefined });

    await runReadTool(
      "get_staff_commission",
      { dateFrom: "", dateTo: "  " },
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.commissionView]),
    );
    expect(mocks.staffCommissionReport).toHaveBeenCalledWith(
      BUSINESS_ID,
      { from: undefined, to: undefined },
      LOCATION_ID,
    );
  });

  it.each(BRANCH_READS)("scopes $name to the member's live branch", async ({ name, permission, args, expectedQueries }) => {
    const result = await runReadTool(
      name,
      args,
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([permission]),
    );

    expect(result.ok).toBe(true);
    expect(mocks.resolveActiveLocationForUser).toHaveBeenCalledWith(BUSINESS_ID, ACTOR_ID);
    expect(mocks.query).toHaveBeenCalledTimes(expectedQueries.length);
    for (const [index, marker] of expectedQueries.entries()) {
      expect(mocks.query.mock.calls[index]?.[0]).toContain(marker);
      expect(mocks.query.mock.calls[index]?.[1]).toContain(LOCATION_ID);
    }
  });

  it("uses the pinned connection branch for an actorless deleted-authorizer read", async () => {
    const permissions = new Set([...SYSTEM_AI_READ_PERMISSIONS].filter((permission) => permission !== PERMISSIONS.reportsBusinessWide));
    const result = await runReadTool(
      "get_stock_valuation",
      {},
      BUSINESS_ID,
      undefined,
      undefined,
      permissions,
      LOCATION_ID,
    );
    expect(result.ok).toBe(true);
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([BUSINESS_ID, LOCATION_ID]);
  });

  it("refuses a member with no accessible branch rather than running an unscoped query", async () => {
    mocks.resolveActiveLocationForUser.mockResolvedValue(null);
    const result = await runReadTool(
      "get_stock_valuation",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.inventoryView]),
    );
    expect(result).toMatchObject({ ok: false });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("keeps trusted system callers tenant-wide when no user or pinned branch is supplied", async () => {
    const result = await runReadTool(
      "get_stock_valuation",
      {},
      BUSINESS_ID,
      undefined,
      undefined,
      SYSTEM_AI_READ_PERMISSIONS,
    );
    expect(result.ok).toBe(true);
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([BUSINESS_ID, null]);
  });

  it("preserves trusted system access to business-wide standard reports", async () => {
    const result = await runReadTool(
      "run_report",
      { key: "daily_sales_summary" },
      BUSINESS_ID,
      undefined,
      undefined,
      SYSTEM_AI_READ_PERMISSIONS,
    );
    expect(result.ok).toBe(true);
    expect(mocks.runStandardReportRows).toHaveBeenCalledWith(
      "daily_sales_summary",
      BUSINESS_ID,
      { mode: "business-wide" },
      { dateFrom: undefined, dateTo: undefined },
    );
  });

  it("classifies VAT as a business-wide ledger read governed by ledger.view", async () => {
    const result = await runReadTool(
      "get_vat_liability",
      DATES,
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.ledgerView]),
    );

    expect(result.ok).toBe(true);
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ scopeNote: expect.stringContaining("همهٔ شعب") });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.every(([sql]) => !sql.includes("location_id"))).toBe(true);
  });

  it("keeps a deleted-authorizer report on its pinned branch without business-wide permission", async () => {
    const permissions = new Set([...SYSTEM_AI_READ_PERMISSIONS].filter((permission) => permission !== PERMISSIONS.reportsBusinessWide));
    const result = await runReadTool(
      "run_report",
      { key: "daily_sales_summary" },
      BUSINESS_ID,
      undefined,
      undefined,
      permissions,
      LOCATION_ID,
    );
    expect(result.ok).toBe(true);
    expect(mocks.runStandardReportRows).toHaveBeenCalledWith(
      "daily_sales_summary",
      BUSINESS_ID,
      { mode: "branch", locationId: LOCATION_ID },
      { dateFrom: undefined, dateTo: undefined },
    );
  });

  it("uses the branch's own business day for an open-ended scoped report", async () => {
    await runReadTool(
      "get_menu_performance",
      {},
      BUSINESS_ID,
      undefined,
      undefined,
      new Set([PERMISSIONS.menuView]),
      LOCATION_ID,
    );
    expect(mocks.locationBusinessToday).toHaveBeenCalledWith(BUSINESS_ID, LOCATION_ID);
  });

  it("requires commission.view rather than payroll.view for commission data", async () => {
    const result = await runReadTool(
      "get_staff_commission",
      DATES,
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.payrollView]),
    );

    expect(result).toMatchObject({ ok: false });
    expect(mocks.staffCommissionReport).not.toHaveBeenCalled();
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
  });

  it("scopes staff commission to the member's live branch", async () => {
    const result = await runReadTool(
      "get_staff_commission",
      DATES,
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.commissionView]),
    );

    expect(result.ok).toBe(true);
    expect(mocks.resolveActiveLocationForUser).toHaveBeenCalledWith(BUSINESS_ID, ACTOR_ID);
    expect(mocks.staffCommissionReport).toHaveBeenCalledWith(
      BUSINESS_ID,
      { from: DATES.dateFrom, to: DATES.dateTo },
      LOCATION_ID,
    );
  });

  it("keeps the trusted actorless unpinned commission read at its established business-wide scope", async () => {
    const result = await runReadTool(
      "get_staff_commission",
      {},
      BUSINESS_ID,
      undefined,
      undefined,
      SYSTEM_AI_READ_PERMISSIONS,
    );

    expect(result.ok).toBe(true);
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
    expect(mocks.staffCommissionReport).toHaveBeenCalledWith(
      BUSINESS_ID,
      { from: undefined, to: undefined },
      null,
    );
  });

  it("does not let a pinned actor continue reading after the authorizer loses branch access", async () => {
    mocks.resolveActiveLocationForUser.mockResolvedValue({ id: OTHER_LOCATION_ID });
    const result = await runReadTool(
      "get_stock_valuation",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.inventoryView]),
      LOCATION_ID,
    );
    expect(result).toMatchObject({ ok: false });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requires the CMS content permission before touching the website adapter", async () => {
    const result = await runReadTool(
      "list_website_posts",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.websiteView]),
    );
    expect(result).toMatchObject({ ok: false });
    expect(mocks.listWebsitePostsTool).not.toHaveBeenCalled();
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
  });

  it("labels website and messaging reads as business-wide, not branch operations", async () => {
    const websitePosts = await runReadTool(
      "list_website_posts",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.cmsView]),
    );
    expect(websitePosts).toMatchObject({
      ok: true,
      data: { posts: [], scopeNote: expect.stringContaining("کل کسب‌وکار") },
    });

    const websiteProducts = await runReadTool(
      "list_website_products",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.cmsView]),
    );
    expect(websiteProducts).toMatchObject({
      ok: true,
      data: { products: [], scopeNote: expect.stringContaining("کل کسب‌وکار") },
    });

    const websiteStatus = await runReadTool(
      "get_website_status",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.websiteView]),
    );
    expect(websiteStatus).toMatchObject({
      ok: true,
      data: { connected: false, scopeNote: expect.stringContaining("کل کسب‌وکار") },
    });

    const templates = await runReadTool(
      "list_message_templates",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.campaignsView]),
    );
    expect(templates).toMatchObject({
      ok: true,
      data: { templates: [], scopeNote: expect.stringContaining("کل کسب‌وکار") },
    });

    const campaigns = await runReadTool(
      "list_message_campaigns",
      {},
      BUSINESS_ID,
      undefined,
      ACTOR_ID,
      new Set([PERMISSIONS.campaignsView]),
    );
    expect(campaigns).toMatchObject({
      ok: true,
      data: { campaigns: [], scopeNote: expect.stringContaining("کل کسب‌وکار") },
    });
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.listWebsitePostsTool).toHaveBeenCalledWith(BUSINESS_ID, { status: undefined, limit: undefined });
    expect(mocks.listWebsiteProductsTool).toHaveBeenCalledWith(BUSINESS_ID, { limit: undefined });
    expect(mocks.websiteStatusTool).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.listMessageTemplates).toHaveBeenCalledWith(BUSINESS_ID, undefined);
    expect(mocks.listMessageCampaigns).toHaveBeenCalledWith(BUSINESS_ID);
  });
});
