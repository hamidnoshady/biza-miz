import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as authorize from "@/lib/authorize";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});
vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return { ...actual, canActInLocation: vi.fn() };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const PURCHASE_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const LOCATION_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const SESSION = { businessId: BUSINESS_ID, sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12" };
/** A bigint Rial amount past 2^53 — it must arrive as text, never via `Number()`. */
const HUGE = "9007199254740993";
const PURCHASE = {
  id: PURCHASE_ID, supplier_id: null, supplier_name: null, status: "received",
  location_id: LOCATION_ID, location_name: "شعبه مجاز", note: null, total: "100", received_at: "2026-10-20",
};
function request() { return { url: "http://x/api/stock/purchases" } as unknown as NextRequest; }
function context(id = PURCHASE_ID) { return { params: Promise.resolve({ id }) }; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, membership: { userId: SESSION.sub }, error: null } as never);
  vi.mocked(authorize.canActInLocation).mockResolvedValue(true);
});

describe("GET /api/stock/purchases/[id]", () => {
  it("requires inventory.view", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({
      session: null, membership: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const response = await GET(request(), context());
    expect(response.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("404s a malformed id before touching the database, identically to an unknown one", async () => {
    const response = await GET(request(), context("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "purchase_not_found" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not reveal a foreign tenant purchase id", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never);
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "purchase_not_found" });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("p.business_id = $1"), [BUSINESS_ID, PURCHASE_ID]);
  });

  it("hides a purchase in a branch outside a restricted user's scope", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [PURCHASE] } as never);
    vi.mocked(authorize.canActInLocation).mockResolvedValue(false);
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(authorize.canActInLocation).toHaveBeenCalledWith(expect.anything(), LOCATION_ID);
  });

  it("serves receipt lines only after tenant and branch authorization", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [PURCHASE] } as never)
      .mockResolvedValueOnce({ rows: [{ purchase_item_id: "line-1", quantity_received: "2", quantity_returned: "0" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ purchase: PURCHASE, lines: [{ purchase_item_id: "line-1" }], availableSerials: [] });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  // Issue #915's reader shares this endpoint with #918's voucher editor, so the
  // history detail's fields and its exact-decimal money must survive alongside
  // the voucher's own namings.
  it("serves the purchase-history detail with money as exact decimal text", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [
          {
            ...PURCHASE, total: HUGE, vat_amount: "45000", settlement_method: "bank",
            supplier_invoice_number: "F-1", supplier_invoice_date: "2026-01-04",
            payment_terms_days: 30, payment_due_date: "2026-02-03",
            supplier_id: "sup-1", supplier_name: "Acme", created_by_name: "Owner",
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            purchase_item_id: "l1", item_id: "i1", item_name: "ساعت", sku: null, tracking: "serial",
            quantity_received: "1", unit_cost: HUGE, batch_number: null, internal_batch_number: false,
            manufacture_date: null, expiry_date: null, supplier_reference: null, serial_number: "SN-1",
            quantity_returned: "0",
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.purchase).toMatchObject({
      id: PURCHASE_ID,
      total: HUGE,
      vatAmount: "45000",
      settlementMethod: "bank",
      supplierInvoiceNumber: "F-1",
      paymentTermsDays: 30,
      createdByName: "Owner",
      // The voucher editor's naming for the same row is still there.
      supplier_name: "Acme",
      received_at: "2026-10-20",
    });
    expect(body.lines).toEqual([
      expect.objectContaining({
        id: "l1", purchase_item_id: "l1", unitCost: HUGE, quantity: "1",
        serialNumber: "SN-1", tracking: "serial", internalBatchNumber: false,
        quantity_returned: "0",
      }),
    ]);
  });
});
