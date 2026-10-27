import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), config: vi.fn(), download: vi.fn(), ready: vi.fn(), fail: vi.fn() }));
vi.mock("../db", () => ({ query: mocks.query, withTenant: async (_: string, fn: () => unknown) => fn(), withoutTenantScope: async (_: string, fn: () => unknown) => fn() }));
vi.mock("./webhook-ingest-service", () => ({ ingestPluginEvent: vi.fn() }));
vi.mock("../media-service", () => ({ getMediaConfig: mocks.config, isMediaStorageReady: mocks.ready, readMediaObjectDownloadUrl: mocks.download, failWordPressMediaSync: mocks.fail }));
import { pluginAckJobs, pluginPullJobs } from "./plugin-service";
import type { ConnectionRow } from "./connections-service";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const connection = { id: "site", business_id: "tenant", status: "active", plugin_capabilities: { jobTypes: ["media_create"] } } as unknown as ConnectionRow;
const job = () => ({ id: "job", entity_type: "media_create", remote_id: `asset-${id}-op`, payload: { __mediaAssetId: id, __operationId: "op" }, attempts: 0, parent_remote_id: null });
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  mocks.config.mockResolvedValue({}); mocks.ready.mockReturnValue(true);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("RETURNING o.id") ? [job()] : [] }));
  mocks.download.mockImplementation(async () => ({ asset: { id }, url: `https://bucket.test/a.jpg?minted=${Date.now()}` }));
});
afterEach(() => vi.useRealTimers());
describe("#926 shared authorized media lease", () => {
  it("mints only at lease, after a 20-minute queue delay, and remints after retry expiry", async () => {
    const queuedAt = Date.now();
    vi.setSystemTime(queuedAt + 20 * 60_000);
    const first = await (await pluginPullJobs(connection)).json();
    expect(mocks.download).toHaveBeenCalledWith("tenant", id, {}, 300);
    expect(first.jobs[0].payload.url).toContain(String(Date.now()));
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain("minted=");
    vi.setSystemTime(queuedAt + 40 * 60_000);
    const second = await (await pluginPullJobs(connection)).json();
    expect(second.jobs[0].payload.url).not.toBe(first.jobs[0].payload.url);
    expect(second.jobs[0].payload.__operationId).toBe("op");
  });
  it("never resolves downloads for paused destinations", async () => {
    expect((await (await pluginPullJobs({ ...connection, status: "paused" })).json()).jobs).toEqual([]);
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("does not deliver a job for a deleted canonical asset", async () => {
    mocks.download.mockResolvedValue(null);
    expect((await (await pluginPullJobs(connection)).json()).jobs).toEqual([]);
    expect(mocks.fail).toHaveBeenCalledWith("op", "media_asset_deleted");
  });
  it("requeues without a URL if storage is temporarily unavailable", async () => {
    mocks.ready.mockReturnValue(false);
    expect((await (await pluginPullJobs(connection)).json()).jobs).toEqual([]);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("storage_not_configured"), ["job", "site"]);
  });
});

describe("#941 download URLs never outlive the request", () => {
  const SIGNED = "https://bucket.test/a.jpg?X-Amz-Expires=300&X-Amz-Signature=deadbeefcafe";

  it("mints for exactly the lease window, not longer", async () => {
    await pluginPullJobs(connection);
    expect(mocks.download).toHaveBeenCalledWith("tenant", id, {}, 300);
  });

  it("scrubs a URL echoed in a plugin failure before it is stored or audited", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("RETURNING attempts") ? [{ attempts: 1, status: "failed", entity_type: "media_create", payload: {} }] : [],
    }));
    await pluginAckJobs(connection, [{ id: "job", status: "failed", error: `cURL error 28 for ${SIGNED}` }]);
    const written = JSON.stringify(mocks.query.mock.calls);
    expect(written).toContain("cURL error 28");
    expect(written).not.toContain("deadbeefcafe");
  });

  it("scrubs a URL in a policy-skipped reason too", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("RETURNING entity_type, remote_id") ? [{ entity_type: "stock_update", remote_id: "1" }] : [],
    }));
    await pluginAckJobs(connection, [{ id: "job", status: "skipped", error: `blocked ${SIGNED}` }]);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain("deadbeefcafe");
  });
});
