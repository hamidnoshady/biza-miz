import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as floor from "@/lib/floor";
import * as setup from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/floor", () => ({ resolveSectionId: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));

const session = { businessId: "business-1", sub: "waiter-1", role: "waiter" };
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockImplementation(async (permission) =>
    permission === PERMISSIONS.tablesManage
      ? ({ session, error: null } as never)
      : ({ session: null, error: forbidden() } as never),
  );
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "location-1" } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [{ id: "table-1", name: "۱" }] } as never);
  vi.mocked(floor.resolveSectionId).mockResolvedValue(null as never);
});

describe("/api/tables structural vs operational access", () => {
  it("keeps table reads available to a waiter with tables.manage", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesManage);
    expect(db.query).toHaveBeenCalledOnce();
  });

  it("requires tables.edit to create a table", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tables", {
        method: "POST",
        body: JSON.stringify({ name: "New table" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
    expect(db.query).not.toHaveBeenCalled();
  });
});
