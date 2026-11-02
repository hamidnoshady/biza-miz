import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), authenticate: vi.fn() }));
vi.mock("../db", () => ({
  query: mocks.query,
  withTenant: async (_: string, fn: () => unknown) => fn(),
  withoutTenantScope: async (_: string, fn: () => unknown) => fn(),
}));
vi.mock("./webhook-ingest-service", () => ({ ingestPluginEvent: vi.fn() }));
vi.mock("../media-service", () => ({
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(),
  readMediaObjectDownloadUrl: vi.fn(),
  failWordPressMediaSync: vi.fn(),
}));

import { parsePluginVersionHeader, pluginSiteMismatch, pluginPullJobs } from "./plugin-service";
import type { ConnectionRow } from "./connections-service";

describe("plugin version header (issue #1149, B2)", () => {
  it("accepts a dotted version and rejects free text", () => {
    expect(parsePluginVersionHeader("1.6.19")).toBe("1.6.19");
    expect(parsePluginVersionHeader(" 1.7.0-beta.1 ")).toBe("1.7.0-beta.1");
    expect(parsePluginVersionHeader("")).toBeNull();
    expect(parsePluginVersionHeader(null)).toBeNull();
    expect(parsePluginVersionHeader("1.0; DROP TABLE")).toBeNull();
    expect(parsePluginVersionHeader("x".repeat(80))).toBeNull();
  });
});

describe("pluginSiteMismatch (ping and handshake share it)", () => {
  const bound = { plugin_site_url: "https://shop.example/" };
  it("matches the same site however it is spelled", () => {
    expect(pluginSiteMismatch(bound, "https://shop.example")).toBeNull();
    expect(pluginSiteMismatch(bound, "HTTPS://SHOP.EXAMPLE/")).toBeNull();
  });
  it("names both addresses when a token is used on another site", () => {
    expect(pluginSiteMismatch(bound, "https://other.example")).toEqual({
      expectedSiteUrl: "https://shop.example/",
      reportedSiteUrl: "https://other.example",
    });
  });
  it("has nothing to compare before the first handshake", () => {
    expect(pluginSiteMismatch({ plugin_site_url: null }, "https://other.example")).toBeNull();
    expect(pluginSiteMismatch(bound, undefined)).toBeNull();
  });
});

describe("pluginPullJobs drops redundant stock/price jobs before leasing (C2)", () => {
  const connection = {
    id: "site",
    business_id: "tenant",
    status: "active",
    currency_unit: "toman",
    plugin_capabilities: { jobTypes: ["stock", "price"] },
  } as unknown as ConnectionRow;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("closes a stale job, then a job equal to the store's value, and records the latter as acknowledged", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("JOIN integration_mappings m")) {
        return {
          rows: [
            { id: "j-equal", entity_type: "stock", remote_id: "10", payload: { stock_quantity: 5 }, remote: { remoteManageStock: true, remoteStockQuantity: 5 } },
            { id: "j-differs", entity_type: "stock", remote_id: "11", payload: { stock_quantity: 9 }, remote: { remoteManageStock: true, remoteStockQuantity: 5 } },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await pluginPullJobs(connection);

    const stale = calls.find((c) => c.sql.includes("'stale_job'"));
    expect(stale?.params).toEqual(["site", "24"]);
    const equal = calls.filter((c) => c.sql.includes("'equal_to_remote'"));
    expect(equal.map((c) => c.params[0])).toEqual(["j-equal"]);
    // The acknowledged value lands on the mapping so the diff goes quiet.
    expect(calls.some((c) => c.sql.includes("integration_mappings") && c.params[4] === '{"stock":5}')).toBe(true);
  });
});
