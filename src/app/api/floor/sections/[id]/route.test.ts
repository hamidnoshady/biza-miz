import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { PATCH, DELETE } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock("@/lib/floor", () => ({
  validWaiterId: vi.fn(),
  recordFloorAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));

const ctx = { params: Promise.resolve({ id: "section-1" }) };
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
const managerSession = { businessId: "biz-1", sub: "mgr-1", role: "manager" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ session: null, error: forbidden() } as never);
  vi.mocked(getPool).mockReturnValue({
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  } as never);
});

describe("/api/floor/sections/[id] structural mutations", () => {
  it.each([
    [
      "PATCH",
      () =>
        PATCH(
          new NextRequest("http://localhost/api/floor/sections/section-1", {
            method: "PATCH",
            body: JSON.stringify({ name: "New name" }),
          }),
          ctx,
        ),
    ],
    [
      "DELETE",
      () =>
        DELETE(
          new NextRequest("http://localhost/api/floor/sections/section-1", { method: "DELETE" }),
          ctx,
        ),
    ],
  ])("requires tables.edit for %s", async (_method, call) => {
    const response = await call();
    expect(response.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
  });

  it("blocks deleting a section that still holds active tables unless reassigned or allowUnassign is set", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: managerSession, error: null } as never);
    vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM floor_sections WHERE id = $1 AND location_id = $2")) {
        return { rows: [{ id: "section-1", name: "Main Hall" }] } as never;
      }
      if (sql.includes("COUNT(*)::int AS count FROM dining_tables")) {
        return { rows: [{ count: 3 }] } as never;
      }
      return { rows: [] } as never;
    });

    const blocked = await DELETE(
      new NextRequest("http://localhost/api/floor/sections/section-1", { method: "DELETE" }),
      ctx,
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "section_has_tables",
      tableCount: 3,
    });

    const allowed = await DELETE(
      new NextRequest("http://localhost/api/floor/sections/section-1?allowUnassign=true", {
        method: "DELETE",
      }),
      ctx,
    );
    expect(allowed.status).toBe(200);
  });

  it("locks the section FOR UPDATE and re-counts active tables inside one transaction so a concurrently added/moved table cannot be silently orphaned", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: managerSession, error: null } as never);
    vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);

    const executedSql: string[] = [];
    let sectionLocked = false;
    let concurrentTableCountAfterLock = 0;

    const txClient = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        executedSql.push(normalized);
        if (normalized.includes("FROM floor_sections WHERE id = $1 AND location_id = $2 FOR UPDATE")) {
          // Simulate a table moved into section-1 right before FOR UPDATE lock is acquired
          sectionLocked = true;
          concurrentTableCountAfterLock = 1;
          return { rows: [{ id: "section-1", name: "Patio" }] };
        }
        if (normalized.includes("COUNT(*)::int AS count FROM dining_tables")) {
          expect(sectionLocked).toBe(true);
          return { rows: [{ count: concurrentTableCountAfterLock }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValueOnce({
      connect: vi.fn(async () => txClient),
    } as never);

    const res = await DELETE(
      new NextRequest("http://localhost/api/floor/sections/section-1", { method: "DELETE" }),
      ctx,
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "section_has_tables",
      tableCount: 1,
    });
    expect(executedSql).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("COUNT(*)::int AS count FROM dining_tables"),
      "ROLLBACK",
    ]);
    expect(executedSql.some((s) => s.startsWith("DELETE FROM floor_sections"))).toBe(false);
  });

  it("runs BEGIN, FOR UPDATE lock, reassign UPDATE, re-count, DELETE, and COMMIT inside one transaction", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: managerSession, error: null } as never);
    vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);

    const txSteps: Array<{ sql: string; params: unknown[] }> = [];
    const txClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        txSteps.push({ sql: normalized, params });
        if (normalized.includes("FROM floor_sections WHERE id = $1 AND location_id = $2 FOR UPDATE")) {
          const sid = params[0];
          if (sid === "section-1" || sid === "section-2") {
            return { rows: [{ id: sid, name: String(sid) }] };
          }
          return { rows: [] };
        }
        if (normalized.includes("COUNT(*)::int AS count FROM dining_tables")) {
          return { rows: [{ count: 0 }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    vi.mocked(getPool).mockReturnValueOnce({
      connect: vi.fn(async () => txClient),
    } as never);

    const res = await DELETE(
      new NextRequest("http://localhost/api/floor/sections/section-1", {
        method: "DELETE",
        body: JSON.stringify({ reassignToSectionId: "section-2" }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(txSteps.map((s) => s.sql)).toEqual([
      "BEGIN",
      expect.stringContaining("SELECT id, name, color, assigned_waiter_id, sort_order FROM floor_sections WHERE id = $1 AND location_id = $2 FOR UPDATE"),
      expect.stringContaining("SELECT id FROM floor_sections WHERE id = $1 AND location_id = $2 FOR UPDATE"),
      expect.stringContaining("UPDATE dining_tables SET section_id = $1 WHERE section_id = $2 AND location_id = $3"),
      expect.stringContaining("SELECT COUNT(*)::int AS count FROM dining_tables WHERE section_id = $1 AND location_id = $2 AND is_active"),
      expect.stringContaining("DELETE FROM floor_sections WHERE id = $1 AND location_id = $2"),
      "COMMIT",
    ]);
  });
});
