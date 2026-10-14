import { afterEach, describe, expect, it, vi } from "vitest";
import { businessScope, getTenantScope, runInTenantScope } from "./tenant-context";
const mocks = vi.hoisted(() => ({ query: vi.fn(), bypass: vi.fn() }));
vi.mock("./db", async () => {
  const context = await import("./tenant-context");
  return {
    query: mocks.query,
    withTenant: (id: string, fn: () => Promise<unknown>) => context.runInTenantScope(context.businessScope(id), fn),
    withoutTenantScope: mocks.bypass,
  };
});
import { businessDesktopCompliance, desktopFleetCompliance } from "./desktop-release-service";
afterEach(() => vi.resetAllMocks());
describe("desktop compliance read boundaries", () => {
  it("reads tenant telemetry and the global release catalog without entering fleet-wide bypass", async () => {
    mocks.query.mockImplementation(async () => {
      expect(getTenantScope()).toMatchObject({ kind: "business", businessId: "selected" });
      return { rows: [] };
    });
    await runInTenantScope(businessScope("selected"), async () => {
      const result = await businessDesktopCompliance("selected");
      expect(result.devices).toEqual([]);
      expect(result.summary.installations).toBe(0);
      expect(getTenantScope()).toMatchObject({ kind: "business", businessId: "selected" });
    });
    expect(mocks.bypass).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    const telemetry = mocks.query.mock.calls.find(([sql]) => sql.includes("FROM site_devices d"));
    expect(telemetry?.[0]).toContain("WHERE d.business_id = $1");
    expect(telemetry?.[1]).toEqual(["selected"]);
  });
  it("retains the explicit fleet-wide platform wrapper for the existing update console", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.bypass.mockImplementation((_reason, fn) => fn());
    expect((await desktopFleetCompliance()).summary.installations).toBe(0);
    expect(mocks.bypass).toHaveBeenCalledWith("platform", expect.any(Function));
    const telemetry = mocks.query.mock.calls.find(([sql]) => sql.includes("FROM site_devices d"));
    expect(telemetry?.[0]).not.toContain("WHERE d.business_id = $1");
    expect(telemetry?.[1]).toEqual([]);
  });
});
