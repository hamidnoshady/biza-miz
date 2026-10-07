import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as reportsService from "@/lib/reports-service";
import * as settings from "@/lib/settings";
import * as shiftOrdersService from "@/lib/shift-orders-service";
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
  return { ...actual, resolveActiveLocation: vi.fn(), getPrimaryLocation: vi.fn(async () => null) };
});

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, getSetting: vi.fn() };
});

vi.mock("@/lib/shift-orders-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shift-orders-service")>();
  return { ...actual, getShiftOrdersReport: vi.fn() };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return {
    ...actual,
    runCustomReportQuery: vi.fn(),
    getBusinessOverview: vi.fn(async () => ({ branches: [], consolidated: { subtotal: 0, discount: 0, tax: 0, total: 0, cogs: 0, wasteCost: 0, orderCount: 0 } })),
    getProfitAndLoss: vi.fn(),
    getBalanceSheet: vi.fn(),
    getCashFlow: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const MONEY_CONFIG = {
  view: "v_sales_by_day",
  metric: "total",
  aggregation: "sum" as const,
  dimension: "day",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    error: null,
    membership: null,
  } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-b" } as never);
  vi.mocked(settings.getSetting).mockResolvedValue({ currencyDisplay: "toman" } as never);
  vi.mocked(reportsService.runCustomReportQuery).mockResolvedValue([
    { dim: "2026-01-01", value: 1_250_000 },
  ] as never);
});

describe("POST /api/reports/export — chart files", () => {
  it("scopes the file to the same active branch the screen read", async () => {
    await POST(postRequest({ format: "csv", kind: "chart", config: MONEY_CONFIG }));
    expect(setupState.resolveActiveLocation).toHaveBeenCalled();
    expect(reportsService.runCustomReportQuery).toHaveBeenCalledWith("biz-1", MONEY_CONFIG, "loc-b");
  });

  it("writes money in the business's display unit and names it on the column", async () => {
    // 1,250,000 Rial is 125,000 Toman for a Toman business; the file used to
    // carry raw Rial whichever unit the business had chosen (issue #819).
    const response = await POST(
      postRequest({ format: "csv", kind: "chart", config: MONEY_CONFIG, title: "فروش" }),
    );
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(body).toContain("تومان");
    expect(body).toContain("125000");
    expect(body).not.toContain("1250000");
  });

  it("keeps a non-money measure unconverted and unlabelled", async () => {
    vi.mocked(reportsService.runCustomReportQuery).mockResolvedValue([
      { dim: "2026-01-01", value: 42 },
    ] as never);
    const response = await POST(
      postRequest({
        format: "csv",
        kind: "chart",
        config: { ...MONEY_CONFIG, metric: "order_count" },
        title: "تعداد",
      }),
    );
    const body = await response.text();
    expect(body).toContain("42");
    expect(body).not.toContain("تومان");
  });
});

describe("POST /api/reports/export — detailed shift file", () => {
  function shiftReport(page: number, pageCount: number) {
    return {
      shift: null,
      scope: "all_shifts" as const,
      shifts: [],
      orders: [
        {
          id: `o-${page}`,
          orderNumber: page,
          type: "dine_in" as const,
          status: "completed",
          tableName: null,
          guestCount: null,
          customerName: null,
          openedAt: "2026-01-01T08:00:00.000Z",
          closedAt: "2026-01-01T08:30:00.000Z",
          openedByName: null,
          closedByName: null,
          note: null,
          voidedReason: null,
          amendedAt: null,
          subtotal: 1_000_000,
          discount: 0,
          discountType: null,
          discountValue: null,
          serviceCharge: 0,
          tax: 0,
          tipAmount: 0,
          total: 1_000_000,
          addOnTotal: 0,
          lines: [],
          itemCount: 1,
          payments: [],
        },
      ],
      summary: {
        matchingCount: pageCount,
        completedCount: pageCount,
        completedAmount: 0,
        openCount: 0,
        openAmount: 0,
        heldCount: 0,
        heldAmount: 0,
        voidedCount: 0,
        voidedAmount: 0,
      },
      totalCount: pageCount,
      totalAmount: 0,
      page,
      pageSize: 100,
      pageCount,
    };
  }

  it("walks every page instead of exporting only the visible one", async () => {
    vi.mocked(shiftOrdersService.getShiftOrdersReport).mockImplementation(
      (async (_location: string, filters: { page?: number }) =>
        shiftReport(filters.page ?? 1, 3)) as never,
    );
    const response = await POST(
      postRequest({ format: "csv", kind: "shift_orders", query: "allShifts=1&page=2" }),
    );
    const body = await response.text();
    const calls = vi.mocked(shiftOrdersService.getShiftOrdersReport).mock.calls;
    expect(calls.map((call) => (call[1] as { page: number }).page)).toEqual([1, 2, 3]);
    // The requested page (2) is ignored on purpose: the file is the whole
    // filtered set, so it starts at page one.
    expect(body).toContain("شمارهٔ سفارش");
    expect((body.match(/o-\d/g) ?? []).length).toBe(0);
  });

  it("exports in the caller's display unit and refuses an invalid filter string", async () => {
    vi.mocked(shiftOrdersService.getShiftOrdersReport).mockResolvedValue(shiftReport(1, 1) as never);
    const ok = await POST(postRequest({ format: "csv", kind: "shift_orders", query: "allShifts=1" }));
    expect(await ok.text()).toContain("تومان");

    const bad = await POST(
      postRequest({ format: "csv", kind: "shift_orders", query: "status=whatever" }),
    );
    expect(bad.status).toBe(400);
  });

  it("is gated by the export capability, like every other file", async () => {
    vi.mocked(shiftOrdersService.getShiftOrdersReport).mockResolvedValue(shiftReport(1, 1) as never);
    await POST(postRequest({ format: "csv", kind: "shift_orders" }));
    const permissions = vi.mocked(auth.requirePermission).mock.calls.map((call) => call[0]);
    expect(permissions).toContain("reports.export");
  });
});

describe("POST /api/reports/export — consolidated branch file", () => {
  it("requires the business-wide capability on top of the export capability", async () => {
    await POST(postRequest({ format: "csv", kind: "business_overview" }));
    const permissions = vi.mocked(auth.requirePermission).mock.calls.map((call) => call[0]);
    expect(permissions).toContain("reports.export");
    expect(permissions).toContain("reports.business_wide");
  });

  it("refuses the consolidated file when the second capability is missing", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.business_wide") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);
    const response = await POST(postRequest({ format: "csv", kind: "business_overview" }));
    expect(response.status).toBe(403);
    expect(reportsService.getBusinessOverview).not.toHaveBeenCalled();
  });

  it("converts consolidated money for CSV, not only for PDF", async () => {
    vi.mocked(reportsService.getBusinessOverview).mockResolvedValue({
      from: null,
      to: null,
      branches: [
        {
          locationId: "loc-1",
          locationName: "شعبهٔ یک",
          isActive: true,
          orderCount: 2,
          subtotal: 10_000_000,
          discount: 0,
          tax: 0,
          total: 10_000_000,
          cogs: 4_000_000,
          wasteCost: 0,
        },
      ],
      consolidated: { orderCount: 2, subtotal: 10_000_000, discount: 0, tax: 0, total: 10_000_000, cogs: 4_000_000, wasteCost: 0 },
    } as never);
    const response = await POST(postRequest({ format: "csv", kind: "business_overview" }));
    const body = await response.text();
    expect(body).toContain("1000000"); // 10,000,000 Rial → 1,000,000 Toman
    expect(body).toContain("تومان");
  });
});
