import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "./permissions";
import { SYSTEM_AI_READ_PERMISSIONS } from "./ai-capabilities";

const mocks = vi.hoisted(() => ({
  runReadTool: vi.fn<
    (
      name: string,
      args: Record<string, unknown>,
      businessId: string,
      floorScope?: unknown,
      actorUserId?: string,
      permissions?: ReadonlySet<string>,
      pinnedLocationId?: string,
    ) => Promise<{ ok: boolean; data: unknown }>
  >(async () => ({ ok: true, data: { value: 1 } })),
}));
vi.mock("./ai-tools", () => ({ runReadTool: mocks.runReadTool }));

import { runSystemReadTool } from "./ai-system-read";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runReadTool.mockResolvedValue({ ok: true, data: { value: 1 } });
});

describe("trusted system read wrapper", () => {
  it("keeps the complete system-read permission set for trusted callers", async () => {
    const result = await runSystemReadTool("run_report", { key: "daily_sales_summary" }, "business-1");
    expect(result).toEqual({ ok: true, data: { value: 1 } });
    expect(mocks.runReadTool).toHaveBeenCalledWith(
      "run_report",
      { key: "daily_sales_summary" },
      "business-1",
      undefined,
      undefined,
      SYSTEM_AI_READ_PERMISSIONS,
      undefined,
    );
  });

  it("passes an explicit permission set and pinned branch without widening it", async () => {
    const permissions = new Set([PERMISSIONS.reportsView]);
    await runSystemReadTool(
      "run_report",
      { key: "daily_sales_summary" },
      "business-1",
      undefined,
      "user-1",
      permissions,
      "location-1",
    );
    expect(mocks.runReadTool).toHaveBeenCalledWith(
      "run_report",
      { key: "daily_sales_summary" },
      "business-1",
      undefined,
      "user-1",
      permissions,
      "location-1",
    );
  });
});
