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
const kitchenMocks = vi.hoisted(() => ({ scanKitchenTicketAging: vi.fn() }));

vi.mock("./db", () => dbMocks);
vi.mock("./industry-guard", () => industryMocks);
vi.mock("./service-activation/app-gate-service", () => activationMocks);
vi.mock("./kitchen-alert-service", () => kitchenMocks);

import { runAecOverdueScanTick, runKitchenAgingScanTick } from "./notification-scans";

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
  kitchenMocks.scanKitchenTicketAging.mockResolvedValue(0);
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

describe("kitchen aging scan tick", () => {
  it("scans only F&B businesses and isolates one business's failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    industryMocks.getBusinessIndustry.mockImplementation(async (businessId: string) => {
      if (businessId === "business-fails") throw new Error("database password must not be logged");
      if (businessId === "business-retail") return "jewelry";
      return "food_service";
    });
    dbMocks.query.mockResolvedValue({
      rows: [{ id: "business-fails" }, { id: "business-retail" }, { id: "business-cafe" }],
    });

    await expect(runKitchenAgingScanTick()).resolves.toBe(0);

    expect(kitchenMocks.scanKitchenTicketAging).toHaveBeenCalledTimes(1);
    expect(kitchenMocks.scanKitchenTicketAging).toHaveBeenCalledWith("business-cafe");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [line] = errorLog.mock.calls[0] as [string];
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      component: "kitchen-aging-scan",
      event: "business_scan_failed",
      businessId: "business-fails",
      operation: "scan_kitchen_ticket_aging",
    });
    expect(line).not.toContain("database password");
    errorLog.mockRestore();
  });
});
