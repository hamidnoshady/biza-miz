import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as shiftOrders from "@/lib/shift-orders-service";
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
vi.mock("@/lib/shift-orders-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shift-orders-service")>();
  return { ...actual, getShiftOrdersReport: vi.fn(async () => null) };
});

const SESSION = { businessId: "biz-a", sub: "user-a", role: "manager" };
const request = (query = "") => ({ url: `http://localhost/api/reports/shift-orders${query}` }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({
    id: "loc-b",
    name: "شعبهٔ ب",
    timezone: "Asia/Tehran",
  } as never);
});

describe("GET /api/reports/shift-orders", () => {
  it("reads the authenticated branch and its timezone", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(shiftOrders.getShiftOrdersReport).toHaveBeenCalledWith(
      "loc-b",
      expect.objectContaining({ timeZone: "Asia/Tehran", page: 1, pageSize: 25 }),
    );
  });

  it("refuses a missing branch instead of returning a success-shaped empty report", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "no_accessible_branch" }));
    expect(shiftOrders.getShiftOrdersReport).not.toHaveBeenCalled();
  });
});
