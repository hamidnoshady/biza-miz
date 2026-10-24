import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as authorization from "@/lib/authorize";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return {
    ...actual,
    authorize: vi.fn().mockResolvedValue({ ok: true }),
    denialResponse: vi.fn(),
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const LOCATION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const ITEM_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const PURCHASE_ID = "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15";
const SESSION = { businessId: BUSINESS_ID, sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.query).mockReset();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(authorization.authorize).mockResolvedValue({ ok: true } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: LOCATION_ID } as never);
});

function getRequest(url: string) {
  return { url } as unknown as NextRequest;
}

describe("GET /api/stock/batches", () => {
  it("authorizes the branch and returns lot availability with purchase provenance", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ location_id: LOCATION_ID }] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: "batch-id",
            batch_number: "LOT-42",
            expiry_date: "2027-06-30",
            manufacture_date: "2026-06-30",
            quantity: "8.5",
            unit_cost: "1250000",
            supplier_reference: "SUP-REF-42",
            purchase_id: PURCHASE_ID,
            purchase_received_at: "2026-06-30T10:00:00.000Z",
            supplier_name: "Supplier A",
          },
        ],
      } as never);

    const response = await GET(
      getRequest(`https://example.test/api/stock/batches?item=${ITEM_ID}&branch=${LOCATION_ID}`),
    );

    expect(response.status).toBe(200);
    expect(authorization.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_ID });
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("l.business_id = $2"),
      [ITEM_ID, BUSINESS_ID],
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("prov.purchase_id"),
      [ITEM_ID, LOCATION_ID, BUSINESS_ID],
    );
    expect(await response.json()).toEqual({
      batches: [
        {
          id: "batch-id",
          batchNumber: "LOT-42",
          expiryDate: "2027-06-30",
          manufactureDate: "2026-06-30",
          quantity: "8.5",
          displayQuantity: "8.5",
          unitCost: 1250000,
          supplierReference: "SUP-REF-42",
          purchaseId: PURCHASE_ID,
          purchaseReceivedAt: "2026-06-30T10:00:00.000Z",
          supplierName: "Supplier A",
        },
      ],
    });
  });

  it("denies an unauthorized branch before reading item or batch data", async () => {
    const denial = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(authorization.authorize).mockResolvedValue({ ok: false, reason: "branch_forbidden" } as never);
    vi.mocked(authorization.denialResponse).mockReturnValue(denial);

    const response = await GET(
      getRequest(`https://example.test/api/stock/batches?item=${ITEM_ID}&branch=${LOCATION_ID}`),
    );

    expect(response).toBe(denial);
    expect(authorization.denialResponse).toHaveBeenCalledWith({ ok: false, reason: "branch_forbidden" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns 404 for an item outside the authorized business or branch", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never);

    const response = await GET(
      getRequest(`https://example.test/api/stock/batches?item=${ITEM_ID}&branch=${LOCATION_ID}`),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("keeps the established empty-list result for an item in another branch of the same tenant", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ location_id: "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a16" }] } as never);

    const response = await GET(
      getRequest(`https://example.test/api/stock/batches?item=${ITEM_ID}&branch=${LOCATION_ID}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ batches: [] });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed item and branch identifiers", async () => {
    const badItem = await GET(getRequest("https://example.test/api/stock/batches?item=bad"));
    expect(badItem.status).toBe(400);
    expect(await badItem.json()).toEqual({ error: "bad_request" });

    const badBranch = await GET(
      getRequest(`https://example.test/api/stock/batches?item=${ITEM_ID}&branch=bad`),
    );
    expect(badBranch.status).toBe(400);
    expect(await badBranch.json()).toEqual({ error: "bad_request" });
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns an empty lot list when no active branch is available", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);

    const response = await GET(getRequest(`https://example.test/api/stock/batches?item=${ITEM_ID}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ batches: [] });
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});
