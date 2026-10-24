import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  resolveActiveLocation: vi.fn(),
  listAssignableFloorStaff: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: mocks.requirePermission,
  requireAnyPermission: mocks.requireAnyPermission,
}));
vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: mocks.resolveActiveLocation,
}));
vi.mock("@/lib/floor", () => ({
  listAssignableFloorStaff: mocks.listAssignableFloorStaff,
}));

const session = { businessId: "biz-1", sub: "mgr-1", role: "manager" };
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActiveLocation.mockResolvedValue({ id: "loc-1" });
});

describe("GET /api/staff narrow assignable floor staff endpoint", () => {
  it("allows a custom-role / floor editor with tables.edit (without team.manage) and returns only narrow { id, full_name, role } fields", async () => {
    mocks.requirePermission.mockResolvedValue({ session: null, error: forbidden() } as never);
    mocks.requireAnyPermission.mockResolvedValue({ session, error: null } as never);
    mocks.listAssignableFloorStaff.mockResolvedValue([
      {
        id: "u-waiter",
        full_name: "سارا گارسون",
        role: "waiter",
        email: "secret@example.com",
        phone: "09120000000",
        salary: 50000000,
      },
      {
        id: "u-cashier",
        full_name: "امین صندوقدار",
        role: "cashier",
      },
    ]);

    const res = await (GET() as Promise<Response>);
    expect(res.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.teamManage);
    expect(mocks.requireAnyPermission).toHaveBeenCalledWith("tables.edit", "tables.manage");
    expect(mocks.listAssignableFloorStaff).toHaveBeenCalledWith("biz-1", "loc-1");

    const json = await res.json();
    expect(json).toEqual({
      staff: [
        { id: "u-waiter", full_name: "سارا گارسون", role: "waiter" },
        { id: "u-cashier", full_name: "امین صندوقدار", role: "cashier" },
      ],
      waiters: [
        { id: "u-waiter", full_name: "سارا گارسون", role: "waiter" },
        { id: "u-cashier", full_name: "امین صندوقدار", role: "cashier" },
      ],
    });
    expect(json.staff[0]).not.toHaveProperty("email");
    expect(json.staff[0]).not.toHaveProperty("phone");
    expect(json.staff[0]).not.toHaveProperty("salary");
  });

  it("rejects callers lacking team.manage, tables.edit, and tables.manage with 403", async () => {
    mocks.requirePermission.mockResolvedValue({ session: null, error: forbidden() } as never);
    mocks.requireAnyPermission.mockResolvedValue({ session: null, error: forbidden() } as never);

    const res = await (GET() as Promise<Response>);
    expect(res.status).toBe(403);
    expect(mocks.listAssignableFloorStaff).not.toHaveBeenCalled();
  });
});
