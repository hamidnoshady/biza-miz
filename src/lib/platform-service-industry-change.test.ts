import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  query: vi.fn(),
  seedChartOfAccounts: vi.fn(),
  disableFeatures: vi.fn(),
  reconcilePaymentMethodsForIndustry: vi.fn(),
  previousIndustry: "jewelry",
  nextIndustry: "food_service",
  readinessRow: {
    has_business: true,
    has_location: true,
    has_prefs: true,
    has_costing: false,
    has_tax: true,
    accounts: 5,
    sellable_menu_items: 0,
  },
  clientQuery: vi.fn(),
}));

vi.mock("./db", () => ({
  getPool: mocks.getPool,
  query: mocks.query,
  withoutTenantScope: async (_label: string, operation: () => Promise<unknown>) => operation(),
  withTenant: async (_businessId: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("./business-provisioning", () => ({
  disableFeatures: mocks.disableFeatures,
  seedChartOfAccounts: mocks.seedChartOfAccounts,
}));
vi.mock("./payment-methods-service", () => ({
  reconcilePaymentMethodsForIndustry: mocks.reconcilePaymentMethodsForIndustry,
}));

const { changeBusinessIndustry } = await import("./platform-service");

function readinessRow(patch: Partial<typeof mocks.readinessRow> = {}) {
  return { ...mocks.readinessRow, ...patch };
}

function businessRow(industry: string) {
  return {
    id: "business-1",
    name: "Cafe",
    slug: "cafe",
    subdomain: "cafe",
    status: "active",
    plan: "pro",
    timezone: "Asia/Tehran",
    industry,
    ownership_kind: "customer",
    created_at: "2026-01-01T00:00:00.000Z",
    suspended_at: null,
    archived_at: null,
    location_count: "1",
    member_count: "1",
    order_count: "0",
    last_activity_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.previousIndustry = "jewelry";
  mocks.nextIndustry = "food_service";
  mocks.readinessRow = readinessRow({ has_costing: false, sellable_menu_items: 0 });
  mocks.seedChartOfAccounts.mockResolvedValue([]);
  mocks.disableFeatures.mockResolvedValue(undefined);
  mocks.reconcilePaymentMethodsForIndustry.mockResolvedValue(undefined);
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT industry FROM businesses WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ industry: mocks.previousIndustry }] };
    }
    if (sql.includes("AS has_business")) return { rows: [mocks.readinessRow] };
    return { rows: [], rowCount: 1 };
  });
  mocks.getPool.mockReturnValue({
    connect: async () => ({ query: mocks.clientQuery, release: vi.fn() }),
  });
  mocks.query.mockImplementation(async (sql: string) =>
    sql.includes("FROM businesses b") ? { rows: [businessRow(mocks.nextIndustry)] } : { rows: [] },
  );
});

describe("changeBusinessIndustry setup lifecycle", () => {
  it("clears completedAt when a retail-to-F&B switch fails canonical readiness", async () => {
    const result = await changeBusinessIndustry("business-1", "food_service");

    expect(result?.business.industry).toBe("food_service");
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET value = jsonb_set"),
      ["business-1", "setup.progress"],
    );
    expect(mocks.reconcilePaymentMethodsForIndustry).toHaveBeenCalledWith(
      expect.anything(),
      "business-1",
      "jewelry",
      "food_service",
    );
  });

  it("preserves the completion marker when existing data already meets F&B readiness", async () => {
    mocks.readinessRow = readinessRow({ has_costing: true, sellable_menu_items: 1 });
    await changeBusinessIndustry("business-1", "food_service");

    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE settings"))).toBe(false);
  });

  it("does not run F&B readiness reconciliation on same-industry requests", async () => {
    mocks.previousIndustry = "food_service";
    mocks.nextIndustry = "food_service";
    await changeBusinessIndustry("business-1", "food_service");

    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("AS has_business"))).toBe(false);
    // Payment reconciliation is still called as a transaction participant;
    // its own idempotency guard returns before any SQL on an unchanged trade.
    expect(mocks.reconcilePaymentMethodsForIndustry).toHaveBeenCalledWith(
      expect.anything(),
      "business-1",
      "food_service",
      "food_service",
    );
  });

  it("does not clear the marker when switching away from food_service", async () => {
    mocks.previousIndustry = "food_service";
    mocks.nextIndustry = "jewelry";
    await changeBusinessIndustry("business-1", "jewelry");

    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE settings"))).toBe(false);
  });
});
