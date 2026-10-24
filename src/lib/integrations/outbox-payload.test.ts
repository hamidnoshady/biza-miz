import { describe, expect, it, vi } from "vitest";

/**
 * Issue #942 (F03): the mapping's last-pushed value must be derived from the
 * payload that was actually delivered — never re-read from current local
 * state (which may already hold a newer, undelivered value).
 */
vi.mock("../db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  withTenant: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("./connections-service", () => ({ getConnection: vi.fn(), wooClientFor: vi.fn() }));
vi.mock("./mapping-service", () => ({ listMappings: vi.fn(), mergeMappingMeta: vi.fn() }));
vi.mock("./audit", () => ({ writeIntegrationAudit: vi.fn() }));
vi.mock("../industry-guard", () => ({ getBusinessIndustry: vi.fn() }));

import { lastPushedFromPayload } from "./outbox-service";

describe("lastPushedFromPayload", () => {
  it("records the delivered stock quantity", () => {
    expect(lastPushedFromPayload("stock", { stock_quantity: 42, manage_stock: true }, "toman")).toEqual({ stock: 42 });
  });

  it("converts the delivered price back to Rial in the connection's unit", () => {
    // 1250.5 Toman == 12505 Rial; the mapping stores Rial as text.
    expect(lastPushedFromPayload("price", { regular_price: "1250.5" }, "toman")).toEqual({ priceRial: "12505" });
    expect(lastPushedFromPayload("price", { regular_price: "12505" }, "rial")).toEqual({ priceRial: "12505" });
    expect(lastPushedFromPayload("price", { regular_price: 900 }, "toman")).toEqual({ priceRial: "9000" });
  });

  it("records only the halves a product_update actually carried", () => {
    expect(lastPushedFromPayload("product_update", { name: "x", stock_quantity: 3 }, "toman")).toEqual({ stock: 3 });
    expect(lastPushedFromPayload("product_update", { name: "x" }, "toman")).toEqual({});
    expect(
      lastPushedFromPayload("product_update", { stock_quantity: 3, regular_price: "100" }, "toman"),
    ).toEqual({ stock: 3, priceRial: "1000" });
  });

  it("records nothing for other entity types or junk payloads (fails safe: next tick requeues)", () => {
    expect(lastPushedFromPayload("order_status", { status: "completed" }, "toman")).toEqual({});
    expect(lastPushedFromPayload("price", { regular_price: "not-a-price" }, "toman")).toEqual({});
    expect(lastPushedFromPayload("stock", null, "toman")).toEqual({});
    expect(lastPushedFromPayload("stock", undefined, "toman")).toEqual({});
  });
});
