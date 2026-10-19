import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { PATCH, DELETE } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
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

  it("reassigns active tables to another section before deleting", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: managerSession, error: null } as never);
    vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
    vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM floor_sections WHERE id = $1 AND location_id = $2")) {
        const sid = params?.[0];
        if (sid === "section-1" || sid === "section-2") {
          return { rows: [{ id: sid, name: String(sid) }] } as never;
        }
        return { rows: [] } as never;
      }
      return { rows: [] } as never;
    });

    const res = await DELETE(
      new NextRequest("http://localhost/api/floor/sections/section-1", {
        method: "DELETE",
        body: JSON.stringify({ reassignToSectionId: "section-2" }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE dining_tables SET section_id = $1 WHERE section_id = $2"),
      ["section-2", "section-1", "loc-1"],
    );
  });
});
