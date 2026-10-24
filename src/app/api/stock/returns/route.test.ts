/**
 * Issue #918 — the returns API's wire contract: strict parsing, stable typed
 * errors with correct statuses, and the register's pagination shape. The
 * service is mocked; its transactional behavior is covered by
 * integration/retail-supplier-returns-918.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as authorize from "@/lib/authorize";
import * as retailStockService from "@/lib/retail-stock-service";
import { RetailReturnError } from "@/lib/retail-return-errors";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn(), getPool: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return { ...actual, actionableLocationIds: vi.fn() };
});

vi.mock("@/lib/retail-stock-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/retail-stock-service")>();
  return { ...actual, createItemSupplierReturn: vi.fn() };
});

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12" };
const LOCATION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const ITEM_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

function getRequest(url: string) {
  return { url } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: LOCATION_ID } as never);
  vi.mocked(authorize.actionableLocationIds).mockResolvedValue([LOCATION_ID]);
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  vi.mocked(db.getPool).mockReturnValue({ connect: async () => client } as never);
});

describe("POST /api/stock/returns", () => {
  const validBody = {
    purchaseId: null,
    supplierId: "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15",
    settlementMethod: "accounts_payable",
    reason: "کالای معیوب",
    idempotencyKey: "draft-1",
    lines: [{ itemId: ITEM_ID, quantity: "2" }],
  };

  it("posts a voucher and reports its split totals", async () => {
    vi.mocked(retailStockService.createItemSupplierReturn).mockResolvedValue({
      id: "return-1",
      value: "120000",
      supplierCredit: "100000",
      variance: "20000",
      returnNumber: 7,
      duplicate: false,
    } as never);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      id: "return-1",
      value: "120000",
      supplierCredit: "100000",
      variance: "20000",
      returnNumber: 7,
      duplicate: false,
    });
    expect(retailStockService.createItemSupplierReturn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        businessId: SESSION.businessId,
        locationId: LOCATION_ID,
        settlementMethod: "accounts_payable",
        idempotencyKey: "draft-1",
      }),
    );
  });

  it("requires an explicit settlement and a client idempotency key", async () => {
    const noSettlement = await POST(postRequest({ ...validBody, settlementMethod: undefined }));
    expect(noSettlement.status).toBe(400);
    expect(await noSettlement.json()).toMatchObject({ error: "settlement_required" });

    const noKey = await POST(postRequest({ ...validBody, idempotencyKey: "  " }));
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: "idempotency_key_required" });

    const noLines = await POST(postRequest({ ...validBody, lines: [] }));
    expect(noLines.status).toBe(400);
    expect(await noLines.json()).toMatchObject({ error: "lines_required" });

    expect(retailStockService.createItemSupplierReturn).not.toHaveBeenCalled();
  });

  it("maps weight-tracked item rejection through the API to a stable client error", async () => {
    vi.mocked(retailStockService.createItemSupplierReturn).mockRejectedValue(new RetailReturnError("weight_unsupported", 400));
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "weight_unsupported" });
  });

  it("answers domain refusals with their stable code and status, never Postgres text", async () => {
    vi.mocked(retailStockService.createItemSupplierReturn).mockRejectedValue(
      new RetailReturnError("idempotency_conflict", 409),
    );
    const conflict = await POST(postRequest(validBody));
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: string; message: string };
    expect(conflictBody.error).toBe("idempotency_conflict");
    expect(conflictBody.message).not.toContain("item_supplier_returns");

    vi.mocked(retailStockService.createItemSupplierReturn).mockRejectedValue(
      new RetailReturnError("purchase_not_found", 404),
    );
    const missing = await POST(postRequest(validBody));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "purchase_not_found" });
  });
});

describe("GET /api/stock/returns", () => {
  it("lists the register page with its writer flag", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ total: "2" }] } as never)
      .mockResolvedValueOnce({
        rows: [
          { id: "r1", return_number: "1", supplier_name: "Acme" },
          { id: "r2", return_number: "2", supplier_name: "Acme" },
        ],
      } as never);

    const res = await GET(getRequest("http://x/api/stock/returns?page=1&pageSize=20"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page: 1, pageSize: 20, total: 2, canWrite: true });
  });

  it("limits the register to the actor's assigned branches and hides foreign branch filters", async () => {
    vi.mocked(authorize.actionableLocationIds).mockResolvedValue([LOCATION_ID]);
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ total: "0" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const res = await GET(getRequest("http://x/api/stock/returns"));
    expect(res.status).toBe(200);
    const listCall = vi.mocked(db.query).mock.calls[0];
    expect(listCall[0]).toContain("r.location_id = ANY($2::uuid[])");
    expect(listCall[1]).toEqual([SESSION.businessId, [LOCATION_ID]]);

    const before = vi.mocked(db.query).mock.calls.length;
    const foreign = await GET(getRequest("http://x/api/stock/returns?locationId=ffffffff-ffff-4fff-8fff-ffffffffffff"));
    expect(foreign.status).toBe(404);
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(before);
  });

  it("requires inventory.view before reading the register", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const res = await GET(getRequest("http://x/api/stock/returns"));
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("reports read-only writers and refuses malformed filters", async () => {
    vi.mocked(auth.requirePermission)
      .mockResolvedValueOnce({ session: SESSION, error: null } as never)
      .mockResolvedValueOnce({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ total: "0" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const res = await GET(getRequest("http://x/api/stock/returns"));
    expect(await res.json()).toMatchObject({ canWrite: false });

    const bad = await GET(getRequest("http://x/api/stock/returns?locationId=nope"));
    expect(bad.status).toBe(400);
  });
});
