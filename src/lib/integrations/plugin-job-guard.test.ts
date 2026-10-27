import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../db";
import { assertPluginJobSupported, isPluginJobUnsupportedError, PluginJobUnsupportedError } from "./plugin-job-guard";
import { enqueueExport } from "./woo-ops-service";
import { enqueuePluginExport } from "./plugin-service";

vi.mock("../db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  closeDatabasePool: vi.fn(),
  withTenant: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  rlsEffective: vi.fn(),
  assertRlsEffective: vi.fn(),
}));
vi.mock("./audit", () => ({ writeIntegrationAudit: vi.fn() }));
vi.mock("./sync-service", () => ({ parentRemoteIdFor: vi.fn() }));

const BUSINESS = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const CONNECTION = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";

function connectionRow(capabilities: Record<string, unknown> | null) {
  vi.mocked(query).mockResolvedValueOnce({ rows: [{ plugin_capabilities: capabilities }] } as never);
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

/**
 * Issue #944 / OVR-08: a job type the plugin never advertised is never
 * queued, whichever producer asks — the lease query filters by capability, so
 * the row would sit `pending` forever.
 */
describe("assertPluginJobSupported", () => {
  it("passes a job the plugin advertised and scopes the read to the business", async () => {
    connectionRow({ jobTypes: ["catalogue_export", "orders_export"] });
    await expect(assertPluginJobSupported(BUSINESS, CONNECTION, "orders_export")).resolves.toBeUndefined();
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([CONNECTION, BUSINESS]);
  });

  it("refuses a job the plugin did not advertise", async () => {
    connectionRow({ jobTypes: ["stock", "price"] });
    const failure = await assertPluginJobSupported(BUSINESS, CONNECTION, "customer_export").catch((err) => err);
    expect(isPluginJobUnsupportedError(failure)).toBe(true);
    expect(failure).toBeInstanceOf(PluginJobUnsupportedError);
    expect((failure as PluginJobUnsupportedError).message).toBe("plugin_job_unsupported");
    expect((failure as PluginJobUnsupportedError).jobType).toBe("customer_export");
  });

  it("gives a plugin that predates capability reporting the legacy set only", async () => {
    connectionRow(null);
    await expect(assertPluginJobSupported(BUSINESS, CONNECTION, "catalogue_export")).resolves.toBeUndefined();
    connectionRow({});
    await expect(assertPluginJobSupported(BUSINESS, CONNECTION, "content_export")).rejects.toThrow("plugin_job_unsupported");
  });

  it("is not_found for a connection another business owns", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);
    await expect(assertPluginJobSupported(BUSINESS, CONNECTION, "orders_export")).rejects.toThrow("not_found");
  });
});

describe("the generic enqueue functions guard themselves", () => {
  it("enqueuePluginExport inserts nothing for an unsupported type", async () => {
    connectionRow({ jobTypes: ["stock"] });
    await expect(enqueuePluginExport(BUSINESS, CONNECTION, "customer_export")).rejects.toBeInstanceOf(PluginJobUnsupportedError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("enqueueExport inserts nothing for an unsupported type", async () => {
    connectionRow({ jobTypes: ["stock"] });
    await expect(enqueueExport(BUSINESS, CONNECTION, "orders_export")).rejects.toBeInstanceOf(PluginJobUnsupportedError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("both queue the job and return its id once the plugin advertised it", async () => {
    connectionRow({ jobTypes: ["customer_export", "orders_export"] });
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: "job-1" }] } as never);
    await expect(enqueuePluginExport(BUSINESS, CONNECTION, "customer_export")).resolves.toEqual({ jobId: "job-1" });
    connectionRow({ jobTypes: ["customer_export", "orders_export"] });
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: "job-2" }] } as never);
    await expect(enqueueExport(BUSINESS, CONNECTION, "orders_export", { sinceDays: 7 })).resolves.toEqual({ jobId: "job-2" });
    expect(String(vi.mocked(query).mock.calls[1][0])).toContain("INSERT INTO integration_outbox_events");
  });
});
