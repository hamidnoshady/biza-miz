import { describe, expect, it } from "vitest";
import {
  loadPosBaseData,
  orderTypeForEntitlements,
  orderTypesForEntitlements,
  tableServiceEnabled,
} from "./pos-feature-policy";

describe("POS feature policy", () => {
  it("never requests /api/tables when table service is disabled", async () => {
    const paths: string[] = [];
    const request = async <T>(path: string) => {
      paths.push(path);
      return { ok: true, status: 200, data: {} as T, aborted: false };
    };

    const [, tables] = await loadPosBaseData<unknown, unknown>(request, false);
    expect(paths).toEqual(["/api/menu"]);
    expect(tables).toBeNull();

    paths.length = 0;
    await loadPosBaseData<unknown, unknown>(request, true);
    expect(paths).toEqual(["/api/menu", "/api/tables"]);
  });

  it("waits for business info before enabling table service, while supporting legacy responses", () => {
    expect(tableServiceEnabled(false, { reservations: true })).toBe(false);
    expect(tableServiceEnabled(true, { reservations: false })).toBe(false);
    expect(tableServiceEnabled(true, { reservations: true })).toBe(true);
    expect(tableServiceEnabled(true, undefined)).toBe(true);
    expect(tableServiceEnabled(true, {})).toBe(true);
  });

  it("falls back to takeaway when table service or delivery is disabled", () => {
    expect(
      orderTypeForEntitlements("dine_in", {
        tableServiceEnabled: false,
        deliveryEnabled: true,
      }),
    ).toBe("takeaway");
    expect(
      orderTypeForEntitlements("delivery", {
        tableServiceEnabled: true,
        deliveryEnabled: false,
      }),
    ).toBe("takeaway");
    expect(
      orderTypeForEntitlements("dine_in", {
        tableServiceEnabled: true,
        deliveryEnabled: true,
      }),
    ).toBe("dine_in");
  });

  it("removes disabled dine-in and delivery tabs but always leaves takeaway", () => {
    expect(
      orderTypesForEntitlements({ tableServiceEnabled: false, deliveryEnabled: true }),
    ).toEqual(["takeaway", "delivery"]);
    expect(
      orderTypesForEntitlements({ tableServiceEnabled: false, deliveryEnabled: false }),
    ).toEqual(["takeaway"]);
    expect(
      orderTypesForEntitlements({ tableServiceEnabled: true, deliveryEnabled: false }),
    ).toEqual(["dine_in", "takeaway"]);
  });
});
