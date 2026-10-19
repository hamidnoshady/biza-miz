import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as db from "@/lib/db";
import { GET } from "./route";

/**
 * Issue #915 — the retail purchase detail view: a malformed or foreign id is
 * a uniform 404 (no existence oracle, no raw cast error), the branch
 * predicate scopes both queries, and money stays the exact decimal text the
 * database produced — a total past 2^53 must survive the trip.
 */

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const LOCATION = { id: "loc-1" };
const PURCHASE_ID = "7d4f8a3e-1b2c-4d5e-8f90-123456789abc";
const HUGE = "9007199254740993";

const request = {} as NextRequest;
const call = (id: string) => GET(request, { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(LOCATION as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
});

describe("GET /api/stock/purchases/[id] (issue #915)", () => {
  it("404s a malformed id before touching the database, identically to an unknown one", async () => {
    const res = await call("not-a-uuid");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("404s a purchase outside this branch — the location predicate is in the query itself", async () => {
    const res = await call(PURCHASE_ID);
    expect(res.status).toBe(404);
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("p.location_id = $2");
    expect(params).toEqual([PURCHASE_ID, LOCATION.id]);
  });

  it("returns header and lines with money as exact decimal text", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [
          {
            id: PURCHASE_ID, status: "received", total: HUGE, vat_amount: "45000", note: null,
            received_at: "2026-01-05T08:00:00Z", settlement_method: "bank", supplier_invoice_number: "F-1",
            supplier_invoice_date: "2026-01-04", payment_terms_days: 30, payment_due_date: "2026-02-03",
            supplier_id: "sup-1", supplier_name: "Acme", created_by_name: "Owner",
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: "l1", item_id: "i1", item_name: "ساعت", sku: null, tracking: "serial",
            quantity: "1", unit_cost: HUGE, batch_number: null, internal_batch_number: false,
            manufacture_date: null, expiry_date: null, supplier_reference: null, serial_number: "SN-1",
          },
        ],
      } as never);

    const res = await call(PURCHASE_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchase).toMatchObject({
      id: PURCHASE_ID,
      total: HUGE,
      vatAmount: "45000",
      settlementMethod: "bank",
      supplierInvoiceNumber: "F-1",
      paymentTermsDays: 30,
      createdByName: "Owner",
    });
    expect(body.lines).toEqual([
      expect.objectContaining({ id: "l1", unitCost: HUGE, quantity: "1", serialNumber: "SN-1", tracking: "serial" }),
    ]);
  });
});
