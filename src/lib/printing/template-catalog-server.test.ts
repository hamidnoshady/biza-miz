import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import * as features from "../features";
import { loadTemplateAccessContext } from "./template-catalog-server";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, query: vi.fn() };
});
vi.mock("../features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features")>();
  return { ...actual, isFeatureEnabled: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(features.isFeatureEnabled).mockResolvedValue(true);
  vi.mocked(db.query).mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("FROM locations l")) return { rows: [{ business_id: "biz-1", industry: "food_service" }], rowCount: 1 } as never;
    if (text.includes("FROM integration_connections")) return { rows: [{ id: "woo-1" }], rowCount: 1 } as never;
    return { rows: [], rowCount: 0 } as never;
  });
});

describe("loadTemplateAccessContext", () => {
  it("resolves current business type and active Woo connection from the request-scoped branch", async () => {
    await expect(loadTemplateAccessContext("loc-1", "woo-1")).resolves.toEqual({ industry: "food_service", wooEnabled: true });
    expect(features.isFeatureEnabled).toHaveBeenCalledWith("biz-1", "integrations");
    const storeLookup = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("FROM integration_connections"));
    expect(String(storeLookup?.[0])).toContain("status = 'active'");
    expect(String(storeLookup?.[0])).toContain("id = $3::uuid");
    expect(storeLookup?.[1]).toEqual(["biz-1", "loc-1", "woo-1"]);
  });

  it("does not expose Woo templates while the integration feature is disabled", async () => {
    vi.mocked(features.isFeatureEnabled).mockResolvedValue(false);
    await expect(loadTemplateAccessContext("loc-1")).resolves.toEqual({ industry: "food_service", wooEnabled: false });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the active location has no readable business type", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(loadTemplateAccessContext("loc-1")).resolves.toBeNull();
    expect(features.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("treats inactive Woo stores as unavailable", async () => {
    vi.mocked(db.query).mockImplementation(async (sql: string) =>
      String(sql).includes("FROM locations l")
        ? { rows: [{ business_id: "biz-1", industry: "jewelry" }], rowCount: 1 } as never
        : { rows: [], rowCount: 0 } as never,
    );
    await expect(loadTemplateAccessContext("loc-1")).resolves.toEqual({ industry: "jewelry", wooEnabled: false });
  });
});
