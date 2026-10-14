import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as costDrift from "@/lib/pricing-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});
vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});
vi.mock("@/lib/pricing-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pricing-service")>();
  return { ...actual, listMenuCostDrift: vi.fn(async () => []) };
});

const SESSION = { businessId: "biz-a", sub: "user-a", role: "manager" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({
    id: "loc-b",
    name: "شعبهٔ ب",
    timezone: "Asia/Tehran",
  } as never);
});

describe("GET /api/reports/cost-drift", () => {
  it("uses the authenticated branch rather than accepting business-wide data", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(costDrift.listMenuCostDrift).toHaveBeenCalledWith("biz-a", "loc-b");
  });

  it("refuses a missing branch before touching cost data", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "no_accessible_branch" }));
    expect(costDrift.listMenuCostDrift).not.toHaveBeenCalled();
  });
});
