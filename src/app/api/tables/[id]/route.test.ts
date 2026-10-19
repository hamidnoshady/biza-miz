import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { PATCH, DELETE } from "./route";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  query: vi.fn(),
  resolveActiveLocation: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.resolveActiveLocation }));
vi.mock("@/lib/realtime", () => ({ broadcast: mocks.broadcast }));

const session = { businessId: "business-1", sub: "waiter-1", role: "waiter" };
const ctx = { params: Promise.resolve({ id: "table-1" }) };
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new NextRequest("http://localhost/api/tables/table-1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    ctx,
  ) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockImplementation(async (permission: string) =>
    permission === PERMISSIONS.tablesManage
      ? ({ session, error: null } as never)
      : ({ session: null, error: forbidden() } as never),
  );
  mocks.resolveActiveLocation.mockResolvedValue({ id: "location-1" });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id, status FROM dining_tables")) {
      return { rows: [{ id: "table-1", status: "free" }] };
    }
    return { rows: [], rowCount: 1 };
  });
});

describe("PATCH /api/tables/[id] access split", () => {
  it("keeps an operational status transition available with tables.manage", async () => {
    const response = await patch({ status: "out_of_service" });
    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledTimes(1);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesManage);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE dining_tables"),
      expect.any(Array),
    );
  });

  it("allows direct manual transition to seated without requiring a session or order", async () => {
    const response = await patch({ status: "seated" });
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE dining_tables"),
      ["table-1", "seated"],
    );
  });

  it("allows manual transition from seated to free and reconciles active session links", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: "table-1", status: "seated" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const response = await patch({ status: "free" });
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE dining_tables"),
      ["table-1", "free"],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE table_session_tables tst"),
      ["table-1", "location-1", "waiter-1"],
    );
  });

  it("requires tables.edit for structural mutation", async () => {
    const response = await patch({ name: "New name" });
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requires both permissions when one request mixes structure and status", async () => {
    mocks.requirePermission.mockImplementation(async (permission: string) =>
      permission === PERMISSIONS.tablesEdit
        ? ({ session, error: null } as never)
        : ({ session: null, error: forbidden() } as never),
    );
    const response = await patch({ name: "New name", status: "out_of_service" });
    expect(response.status).toBe(403);
    expect(mocks.requirePermission.mock.calls).toEqual([
      [PERMISSIONS.tablesEdit],
      [PERMISSIONS.tablesManage],
    ]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tables/[id]", () => {
  it("requires tables.edit before looking up or deactivating a table", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/tables/table-1", { method: "DELETE" }),
      ctx,
    );
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("warns with 409 table_has_future_reservations before archiving a table with future bookings", async () => {
    mocks.requirePermission.mockResolvedValue({ session, error: null } as never);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: "table-1", status: "free" }] };
      }
      if (sql.includes("AS future_reservations")) {
        return {
          rows: [{ active_sessions: 0, active_orders: 0, future_reservations: 2 }],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const blocked = await DELETE(
      new NextRequest("http://localhost/api/tables/table-1", { method: "DELETE" }),
      ctx,
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "table_has_future_reservations",
      details: { futureReservationCount: 2 },
    });

    const allowed = await DELETE(
      new NextRequest("http://localhost/api/tables/table-1?unassignFutureReservations=true", {
        method: "DELETE",
      }),
      ctx,
    );
    expect(allowed.status).toBe(200);
  });
});
