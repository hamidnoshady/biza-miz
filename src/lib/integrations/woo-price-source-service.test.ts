import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../db";
import { resolveMappedWooPrice } from "./woo-price-source-service";
vi.mock("../db", () => ({ query: vi.fn() }));
const connection = { business_id: "business", location_id: "branch", price_source: "base" as const, price_list_id: null };
describe("Woo sale price source", () => {
  beforeEach(() => vi.resetAllMocks());
  it("preserves exact integer Rial beyond JS safe-number precision", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ price: "9007199254740993" }], rowCount: 1 } as never);
    expect(await resolveMappedWooPrice("business", connection, "item")).toBe(9007199254740993n);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("s.unit_price::text");
    expect(sql).not.toContain("unit_cost");
    expect(params).toEqual(["business", "item", "branch", "base", null]);
  });
  it("does not replace a missing named-list price with base price", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ price: null }], rowCount: 1 } as never);
    expect(await resolveMappedWooPrice("business", { ...connection, price_source: "list", price_list_id: "list" }, "item")).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(["business", "item", "branch", "list", "list"]);
  });
  it("keeps an intentional zero sale price and refuses cross-tenant use before SQL", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ price: "0" }], rowCount: 1 } as never);
    expect(await resolveMappedWooPrice("business", connection, "item")).toBe(0n);
    vi.mocked(query).mockClear();
    expect(await resolveMappedWooPrice("other", connection, "item")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
