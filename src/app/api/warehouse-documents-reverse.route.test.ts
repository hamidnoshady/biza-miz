/**
 * The two reversal routes' request contract (#922 P2).
 *
 * A reversal is answered by the service with *typed* refusals, and the route's
 * only job on the way in is the strict request schema: an invalid
 * `Idempotency-Key` is a 400 before anything is read or written, and the note
 * and reason are type-checked. The classification half is pinned separately —
 * both routes map `WarehouseDocumentError` codes and statuses rather than
 * matching message text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as authorizeModule from "@/lib/authorize";
import { POST as retailReverse } from "@/app/api/stock/warehouse-documents/[id]/reverse/route";
import { POST as inventoryReverse } from "@/app/api/inventory/warehouse-documents/[id]/reverse/route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

const queryMock = vi.fn();
const clientQueryMock = vi.fn(async () => ({ rows: [] }));
const releaseMock = vi.fn();

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    query: (...args: unknown[]) => queryMock(...args),
    getPool: () => ({
      connect: async () => ({ query: clientQueryMock, release: releaseMock }),
    }),
  };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return {
    ...actual,
    authorize: vi.fn().mockResolvedValue({ ok: true }),
    denialResponse: vi.fn(() => NextResponse.json({ error: "forbidden" }, { status: 403 })),
  };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const USER_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12";
const DOC_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const LOCATION_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

const SESSION = { businessId: BUSINESS_ID, sub: USER_ID, role: "manager" };

function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const context = { params: Promise.resolve({ id: DOC_ID }) };

const routes = [
  ["/api/stock/warehouse-documents", retailReverse],
  ["/api/inventory/warehouse-documents", inventoryReverse],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(authorizeModule.authorize).mockResolvedValue({ ok: true } as never);
  queryMock.mockReset();
});

describe.each(routes)("POST %s/[id]/reverse — strict request schema", (_name, handler) => {
  it("answers 400 for a malformed Idempotency-Key header without touching the database", async () => {
    const response = await handler(request({}, { "idempotency-key": "not-a-uuid" }), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "idempotency_key_invalid" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed Idempotency-Key in the body", async () => {
    const response = await handler(request({ idempotencyKey: "12345" }), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "idempotency_key_invalid" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a non-uuid document id", async () => {
    const response = await handler(request({}), { params: Promise.resolve({ id: "nope" }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("answers 400 when the note or reason is not a string", async () => {
    for (const body of [{ note: 5 }, { reason: 5 }, [{ note: "x" }]]) {
      const response = await handler(request(body), context);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad_request" });
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("classifies a period-closed refusal by its typed code, not its message", async () => {
    const { FiscalPeriodClosedError } = await import("@/lib/warehouse-document-errors");
    const closed = new FiscalPeriodClosedError("fiscal_period_locked");

    // Row lookups succeed so the request reaches the service; the service is
    // then made to refuse the way a locked period does.
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT id, kind")) {
        return {
          rows: [
            {
              id: DOC_ID,
              kind: "receipt",
              location_id: LOCATION_ID,
              document_number: "D-1",
              internal_voucher_number: "V-1",
              reversed_of: null,
              is_reversal: false,
              supplier_id: null,
            },
          ],
        };
      }
      if (sql.includes("reversed_of=$1")) return { rows: [] };
      // Both line shapes: the retail route reads `item_id`/lot columns, the
      // inventory route reads `inventory_item_id`.
      return {
        rows: [
          {
            item_id: "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15",
            inventory_item_id: "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15",
            quantity: "1",
            unit_cost: "100",
            lot_number: null,
            expiry_date: null,
          },
        ],
      };
    });

    const retail = await import("@/lib/retail-warehouse-document-service");
    const inventory = await import("@/lib/warehouse-document-service");
    const retailSpy = vi
      .spyOn(retail, "createRetailWarehouseDocumentInTransaction")
      .mockRejectedValue(closed);
    const inventorySpy = vi
      .spyOn(inventory, "createWarehouseDocumentInTransaction")
      .mockRejectedValue(closed);

    try {
      const response = await handler(request({}), context);
      // A message-matching route would answer 500 here.
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "fiscal_period_locked" });
    } finally {
      retailSpy.mockRestore();
      inventorySpy.mockRestore();
    }
  });
});
