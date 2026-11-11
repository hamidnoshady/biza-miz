import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { DELETE, GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  query: vi.fn(),
  resolveActiveLocation: vi.fn(),
  broadcast: vi.fn(),
  recordFloorAudit: vi.fn(),
  getTableQrState: vi.fn(),
  ensureTableQrToken: vi.fn(),
  revokeTableQrToken: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.resolveActiveLocation }));
vi.mock("@/lib/realtime", () => ({ broadcast: mocks.broadcast }));
vi.mock("@/lib/floor", () => ({ recordFloorAudit: mocks.recordFloorAudit }));
vi.mock("@/lib/table-qr-service", () => {
  class TableQrError extends Error {
    constructor(
      readonly reason: string,
      readonly status: number,
    ) {
      super(reason);
    }
  }
  return {
    TableQrError,
    getTableQrState: mocks.getTableQrState,
    ensureTableQrToken: mocks.ensureTableQrToken,
    revokeTableQrToken: mocks.revokeTableQrToken,
  };
});

const tableId = "00000000-0000-0000-0000-0000000000a1";
const locationId = "11111111-1111-1111-1111-111111111111";
const session = { businessId: "22222222-2222-2222-2222-222222222222", sub: "user-1", role: "manager" };
const ctx = { params: Promise.resolve({ id: tableId }) };
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

const maskedState = {
  prefix: "tqr_ab12cd",
  siteConnected: true,
  menuUrl: "https://cafe.example/menu",
  createdAt: "2026-11-10T09:00:00.000Z",
  createdBy: "user-1",
  rotatedFromPrefix: null,
};

function request(method: string, path = `/api/tables/${tableId}/qr`): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockImplementation(async (permission: string) =>
    permission === PERMISSIONS.tablesManage || permission === PERMISSIONS.tablesEdit
      ? ({ session, error: null } as never)
      : ({ session: null, error: forbidden() } as never),
  );
  mocks.resolveActiveLocation.mockResolvedValue({ id: locationId });
  mocks.query.mockResolvedValue({ rows: [{ id: tableId }] });
  mocks.recordFloorAudit.mockResolvedValue(undefined);
  mocks.getTableQrState.mockResolvedValue(maskedState);
  mocks.ensureTableQrToken.mockResolvedValue({ created: true, state: maskedState });
  mocks.revokeTableQrToken.mockResolvedValue(true);
});

describe("GET /api/tables/[id]/qr", () => {
  it("returns only the masked state — never a token or a table uuid", async () => {
    const response = (await GET(request("GET"), ctx)) as Response;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ qr: maskedState });
    expect(JSON.stringify(body)).not.toContain(tableId);
    expect(JSON.stringify(body)).not.toMatch(/tqr_[A-Za-z0-9_-]{32}/);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesManage);
  });

  it("answers null for a table that was never printed", async () => {
    mocks.getTableQrState.mockResolvedValue(null);
    const response = (await GET(request("GET"), ctx)) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ qr: null });
  });

  it("refuses a member without tables.manage", async () => {
    mocks.requirePermission.mockResolvedValue({ session: null, error: forbidden() } as never);
    const response = (await GET(request("GET"), ctx)) as Response;
    expect(response.status).toBe(403);
    expect(mocks.getTableQrState).not.toHaveBeenCalled();
  });

  it("refuses a table that belongs to another branch", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = (await GET(request("GET"), ctx)) as Response;
    expect(response.status).toBe(404);
    expect(mocks.getTableQrState).not.toHaveBeenCalled();
  });
});

describe("POST /api/tables/[id]/qr", () => {
  it("generates with tables.edit, audits the prefix only and returns no token", async () => {
    const response = (await POST(request("POST"), ctx)) as Response;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created).toBe(true);
    expect(JSON.stringify(body)).not.toContain(tableId);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
    expect(mocks.ensureTableQrToken).toHaveBeenCalledWith({
      businessId: session.businessId,
      locationId,
      tableId,
      userId: session.sub,
    });
    expect(mocks.recordFloorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "table.qr_generated",
        entity: "dining_table",
        entityId: tableId,
        payload: { prefix: maskedState.prefix, created: true },
      }),
    );
    expect(mocks.broadcast).toHaveBeenCalledWith(
      locationId,
      expect.objectContaining({ type: "floor.updated" }),
    );
  });

  it("is idempotent — an existing print is returned, not replaced", async () => {
    mocks.ensureTableQrToken.mockResolvedValue({ created: false, state: maskedState });
    const response = (await POST(request("POST"), ctx)) as Response;
    expect(response.status).toBe(200);
    expect((await response.json()).created).toBe(false);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("refuses a waiter without tables.edit", async () => {
    mocks.requirePermission.mockImplementation(async (permission: string) =>
      permission === PERMISSIONS.tablesEdit
        ? ({ session: null, error: forbidden() } as never)
        : ({ session, error: null } as never),
    );
    const response = (await POST(request("POST"), ctx)) as Response;
    expect(response.status).toBe(403);
    expect(mocks.ensureTableQrToken).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tables/[id]/qr", () => {
  it("revokes the live print and audits it", async () => {
    const response = (await DELETE(request("DELETE"), ctx)) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, revoked: true });
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.tablesEdit);
    expect(mocks.recordFloorAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "table.qr_revoked" }),
    );
  });

  it("does not audit or broadcast when there was nothing to revoke", async () => {
    mocks.revokeTableQrToken.mockResolvedValue(false);
    const response = (await DELETE(request("DELETE"), ctx)) as Response;
    expect(await response.json()).toEqual({ ok: true, revoked: false });
    expect(mocks.recordFloorAudit).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
