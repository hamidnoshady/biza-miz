import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { BUILTIN_PAYMENT_METHODS } from "./payment-methods";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock("./db", () => ({ query: dbMocks.query, getPool: dbMocks.getPool }));

const {
  listPaymentMethods,
  paymentMethodByCode,
  paymentMethodsByIds,
  reconcilePaymentMethodsForIndustry,
  updatePaymentMethod,
} = await import("./payment-methods-service");

function fakeClient() {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as PoolClient & { query: ReturnType<typeof vi.fn> };
}

const CASH_ROW = {
  id: "cash-id",
  code: "cash",
  name: "نقدی",
  settlement: "cash",
  sort_order: 10,
  is_active: true,
  is_builtin: true,
  opens_drawer: true,
  requires_reference: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcilePaymentMethodsForIndustry", () => {
  it("seeds missing F&B built-ins and re-enables the existing food-only built-in without duplicates", async () => {
    const client = fakeClient();
    await reconcilePaymentMethodsForIndustry(client, "business-1", "jewelry", "food_service");

    const insertCalls = client.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO payment_methods"));
    expect(insertCalls).toHaveLength(BUILTIN_PAYMENT_METHODS.length);
    expect(insertCalls.every(([sql]) => String(sql).includes("ON CONFLICT (business_id, code) DO NOTHING"))).toBe(true);
    expect(insertCalls.map(([, params]) => (params as unknown[])[1])).toEqual(
      BUILTIN_PAYMENT_METHODS.map((method) => method.code),
    );

    const activation = client.query.mock.calls.find(([sql]) => String(sql).includes("SET is_active = true"));
    expect(activation?.[1]).toEqual(["business-1", ["snappfood"]]);
    expect(client.query.mock.calls.every(([sql]) => !String(sql).startsWith("DELETE"))).toBe(true);
  });

  it("deactivates only the food-service built-in on exit, preserving its historical row", async () => {
    const client = fakeClient();
    await reconcilePaymentMethodsForIndustry(client, "business-1", "food_service", "jewelry");

    expect(client.query).toHaveBeenCalledOnce();
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toContain("SET is_active = false");
    expect(String(sql)).toContain("AND is_builtin");
    expect(String(sql)).toContain("AND code = ANY($2::text[])");
    expect(params).toEqual(["business-1", ["snappfood"]]);
    expect(String(sql)).not.toContain("DELETE");
    expect(String(sql)).not.toMatch(/SET\s+name\s*=|settlement\s*=|sort_order\s*=/i);
  });

  it("is a no-op when the industry is unchanged", async () => {
    const client = fakeClient();
    await reconcilePaymentMethodsForIndustry(client, "business-1", "food_service", "food_service");
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("industry-safe payment-method access", () => {
  it("hides food-service-only ways in active and inactive checkout/settings reads", async () => {
    dbMocks.query.mockResolvedValue({ rows: [CASH_ROW] });
    const methods = await listPaymentMethods("business-1", { includeInactive: true });

    expect(methods.map((method) => method.code)).toEqual(["cash"]);
    expect(dbMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("code <> ALL($2::text[])") as never,
      ["business-1", ["snappfood"]],
    );
  });

  it("hides food-only methods from direct tender resolution and code lookup", async () => {
    dbMocks.query.mockResolvedValue({ rows: [] });
    expect(await paymentMethodsByIds("business-1", ["snappfood-id"])).toEqual(new Map());
    expect(await paymentMethodByCode("business-1", "snappfood")).toBeNull();
    for (const [sql, params] of dbMocks.query.mock.calls) {
      expect(String(sql)).toContain("code <> ALL");
      expect(params).toContainEqual(["snappfood"]);
    }
  });

  it("cannot reactivate a food-only method through the settings service outside F&B", async () => {
    dbMocks.query.mockResolvedValue({ rows: [] });
    expect(await updatePaymentMethod("business-1", "snappfood-id", { isActive: true })).toBeNull();
    const [sql, params] = dbMocks.query.mock.calls[0];
    expect(String(sql)).toContain("code <> ALL($8::text[])");
    expect(params).toEqual(["business-1", "snappfood-id", null, null, true, null, null, ["snappfood"]]);
  });
});
