import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { PATCH, DELETE } from "./route";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  resolveActiveLocation: vi.fn(),
  broadcast: vi.fn(),
  recordFloorAudit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/lib/db", () => ({
  query: mocks.query,
  getPool: () => ({
    connect: async () => ({
      query: mocks.query,
      release: mocks.release,
    }),
  }),
}));
vi.mock("@/lib/floor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/floor")>();
  return {
    ...actual,
    recordFloorAudit: mocks.recordFloorAudit,
  };
});
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.resolveActiveLocation }));
vi.mock("@/lib/realtime", () => ({ broadcast: mocks.broadcast }));

const session = { businessId: "business-1", sub: "waiter-1", role: "waiter" };
const table1Id = "00000000-0000-0000-0000-000000000021";
const table2Id = "00000000-0000-0000-0000-000000000022";
const ctx = { params: Promise.resolve({ id: table1Id }) };
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new NextRequest(`http://localhost/api/tables/${table1Id}`, {
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
  mocks.recordFloorAudit.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id, status FROM dining_tables")) {
      return { rows: [{ id: table1Id, status: "free" }] };
    }
    if (sql.includes("SELECT COUNT(*)::int AS active_orders")) {
      return { rows: [{ active_orders: 0 }] };
    }
    return { rows: [], rowCount: 1 };
  });
});

describe("PATCH /api/tables/[id] access split, manual transitions & legacy reserved status", () => {
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
      [table1Id, "seated"],
    );
  });

  it("allows manual transition from seated to free and reconciles active session links when no open/held orders remain", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: table1Id, status: "seated" }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS active_orders")) {
        return { rows: [{ active_orders: 0 }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const response = await patch({ status: "free" });
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE dining_tables"),
      [table1Id, "free"],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE table_session_tables tst"),
      [table1Id, "location-1", "waiter-1"],
    );
  });

  it("updates manual table status to free/cleaning without auto-completing reservations when open or held orders exist on the table", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: table1Id, status: "seated" }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS active_orders")) {
        return { rows: [{ active_orders: 2 }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await patch({ status: "cleaning" });
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE dining_tables"),
      [table1Id, "cleaning"],
    );
    // Must NOT execute the session/reservation auto-completion CTE while open/held orders exist
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).includes("completed_reservations AS")),
    ).toBe(false);
  });

  it("handles a legacy 'reserved' status row cleanly across all operational transitions", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: table1Id, status: "reserved" }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS active_orders")) {
        return { rows: [{ active_orders: 0 }] };
      }
      return { rows: [], rowCount: 1 };
    });

    for (const nextStatus of ["free", "seated", "cleaning", "out_of_service"] as const) {
      const res = await patch({ status: nextStatus });
      expect(res.status).toBe(200);
    }
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
      new NextRequest(`http://localhost/api/tables/${table1Id}`, { method: "DELETE" }),
      ctx,
    );
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns 409 table_in_use when the table has active sessions or open/held orders", async () => {
    mocks.requirePermission.mockResolvedValue({ session, error: null } as never);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: table1Id, status: "seated" }] };
      }
      if (sql.includes("AS active_sessions")) {
        return {
          rows: [{ active_sessions: 1, active_orders: 2, future_reservations: 0 }],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const blocked = await DELETE(
      new NextRequest(`http://localhost/api/tables/${table1Id}`, { method: "DELETE" }),
      ctx,
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "table_in_use",
      details: {
        activeSessionCount: 1,
        activeOrderCount: 2,
        futureReservationCount: 0,
      },
    });
  });

  it("warns with 409 table_has_future_reservations before archiving a table with future bookings", async () => {
    mocks.requirePermission.mockResolvedValue({ session, error: null } as never);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: table1Id, status: "free" }] };
      }
      if (sql.includes("AS future_reservations")) {
        return {
          rows: [{ active_sessions: 0, active_orders: 0, future_reservations: 2 }],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const blocked = await DELETE(
      new NextRequest(`http://localhost/api/tables/${table1Id}`, { method: "DELETE" }),
      ctx,
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "table_has_future_reservations",
      details: { futureReservationCount: 2 },
    });

    const allowed = await DELETE(
      new NextRequest(
        `http://localhost/api/tables/${table1Id}?unassignFutureReservations=true`,
        { method: "DELETE" },
      ),
      ctx,
    );
    expect(allowed.status).toBe(200);
  });

  it("reassigns active orders, open sessions, and future reservations to target table when reassignToTableId is provided", async () => {
    mocks.requirePermission.mockResolvedValue({ session, error: null } as never);
    const executedSql: string[] = [];
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      executedSql.push(normalized);
      if (normalized.includes("SELECT id, status FROM dining_tables")) {
        return { rows: [{ id: String(params?.[0] ?? table1Id), status: "seated" }] };
      }
      if (normalized.includes("AS future_reservations")) {
        // After reassignment, 0 active sessions, 0 active orders, 0 future reservations remain on table1
        return {
          rows: [{ active_sessions: 0, active_orders: 0, future_reservations: 0 }],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const res = await DELETE(
      new NextRequest(`http://localhost/api/tables/${table1Id}`, {
        method: "DELETE",
        body: JSON.stringify({ reassignToTableId: table2Id }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(
      executedSql.some((s) =>
        s.includes("UPDATE orders SET table_id = $1 WHERE table_id = $2"),
      ),
    ).toBe(true);
    expect(
      executedSql.some((s) =>
        s.includes("UPDATE table_sessions SET primary_table_id = $1"),
      ),
    ).toBe(true);
    expect(
      executedSql.some((s) =>
        s.includes("UPDATE reservations SET table_id = $1"),
      ),
    ).toBe(true);
    expect(
      executedSql.some((s) =>
        s.includes("UPDATE dining_tables SET is_active = false, status = 'free'"),
      ),
    ).toBe(true);
    expect(mocks.recordFloorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "table.archived",
        entity: "dining_table",
        entityId: table1Id,
      }),
    );
  });

  it("runs DELETE and PATCH isActive:false in a FOR UPDATE transaction and rolls back on a concurrent order/session/booking race", async () => {
    mocks.requirePermission.mockResolvedValue({ session, error: null } as never);
    const executedSql: string[] = [];
    let concurrentOrderInserted = false;

    mocks.query.mockImplementation(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      executedSql.push(normalized);
      if (normalized.includes("SELECT id, status FROM dining_tables") && normalized.includes("FOR UPDATE")) {
        // Simulate a concurrent order being placed just before the FOR UPDATE lock is acquired
        concurrentOrderInserted = true;
        return { rows: [{ id: table1Id, status: "free" }] };
      }
      if (normalized.includes("AS active_sessions")) {
        return {
          rows: [
            {
              active_sessions: 0,
              active_orders: concurrentOrderInserted ? 1 : 0,
              future_reservations: 0,
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const delRes = await DELETE(
      new NextRequest(`http://localhost/api/tables/${table1Id}`, { method: "DELETE" }),
      ctx,
    );
    expect(delRes.status).toBe(409);
    await expect(delRes.json()).resolves.toMatchObject({
      error: "table_in_use",
      details: { activeOrderCount: 1 },
    });
    expect(executedSql[0]).toBe("BEGIN");
    expect(
      executedSql.some(
        (s) => s.includes("SELECT id, status FROM dining_tables") && s.includes("FOR UPDATE"),
      ),
    ).toBe(true);
    expect(executedSql.at(-1)).toBe("ROLLBACK");
    expect(executedSql.some((s) => s.includes("SET is_active = false"))).toBe(false);
    expect(mocks.release).toHaveBeenCalledTimes(1);

    // Same concurrency protection on PATCH { isActive: false }
    executedSql.length = 0;
    concurrentOrderInserted = false;
    const patchArchiveRes = await patch({ isActive: false });
    expect(patchArchiveRes.status).toBe(409);
    expect(executedSql[0]).toBe("BEGIN");
    expect(executedSql.at(-1)).toBe("ROLLBACK");
    expect(executedSql.some((s) => s.includes("SET is_active = false"))).toBe(false);
  });

  it("logs audit events for manual status changes, structural layout/section edits, and table restoration", async () => {
    mocks.requirePermission.mockResolvedValue({ session, error: null } as never);

    // 1. Manual status change -> table.status_changed
    const statusRes = await patch({ status: "cleaning" });
    expect(statusRes.status).toBe(200);
    expect(mocks.recordFloorAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "table.status_changed",
        entity: "dining_table",
        entityId: table1Id,
      }),
    );

    // 2. Structural layout/geometry change -> table.updated
    const layoutRes = await patch({ posX: 120, posY: 240, width: 100, height: 100 });
    expect(layoutRes.status).toBe(200);
    expect(mocks.recordFloorAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "table.updated",
        entity: "dining_table",
        entityId: table1Id,
      }),
    );

    // 3. Reactivating/restoring an archived table -> table.restored
    const restoreRes = await patch({ isActive: true });
    expect(restoreRes.status).toBe(200);
    expect(mocks.recordFloorAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "table.restored",
        entity: "dining_table",
        entityId: table1Id,
      }),
    );
  });
});
