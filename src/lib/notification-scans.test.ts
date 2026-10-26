import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(),
  withTenant: vi.fn(),
}));
const industryMocks = vi.hoisted(() => ({ getBusinessIndustry: vi.fn() }));
const activationMocks = vi.hoisted(() => ({
  isAppServiceOperational: vi.fn(),
  isWorkspaceServiceOperational: vi.fn(),
}));

vi.mock("./db", () => dbMocks);
vi.mock("./industry-guard", () => industryMocks);
vi.mock("./service-activation/app-gate-service", () => activationMocks);

import { runAecOverdueScanTick } from "./notification-scans";

beforeEach(() => {
  vi.clearAllMocks();
  activationMocks.isAppServiceOperational.mockResolvedValue(true);
  activationMocks.isWorkspaceServiceOperational.mockResolvedValue(true);
  dbMocks.withoutTenantScope.mockImplementation(async (_reason: string, callback: () => Promise<unknown>) => callback());
  dbMocks.withTenant.mockImplementation(async (_businessId: string, callback: () => Promise<unknown>) => callback());
  dbMocks.query.mockResolvedValue({ rows: [{ id: "business-fails" }, { id: "business-continues" }] });
  industryMocks.getBusinessIndustry.mockImplementation(async (businessId: string) => {
    if (businessId === "business-fails") throw new Error("database password must not be logged");
    return "food_service";
  });
});

describe("AEC overdue scan tick failure isolation", () => {
  it("continues after one business has an unexpected failure and logs only structured safe context", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runAecOverdueScanTick()).resolves.toBe(0);

    expect(dbMocks.withTenant).toHaveBeenCalledTimes(2);
    expect(industryMocks.getBusinessIndustry).toHaveBeenCalledWith("business-fails");
    expect(industryMocks.getBusinessIndustry).toHaveBeenCalledWith("business-continues");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [line] = errorLog.mock.calls[0] as [string];
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      component: "aec-notification-scan",
      event: "business_scan_failed",
      businessId: "business-fails",
      operation: "scan_overdue_aec_registers",
      errorName: "Error",
      errorCode: null,
    });
    expect(line).not.toContain("database password");
    errorLog.mockRestore();
  });
});
