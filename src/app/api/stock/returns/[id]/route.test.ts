import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as authorize from "@/lib/authorize";
import * as stockService from "@/lib/retail-stock-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn(), getPool: vi.fn() };
});
vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return { ...actual, canActInLocation: vi.fn() };
});
vi.mock("@/lib/retail-stock-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/retail-stock-service")>();
  return { ...actual, reverseItemSupplierReturn: vi.fn() };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const RETURN_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const LOCATION_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const SESSION = { businessId: BUSINESS_ID, sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12" };
const DOC = {
  id: RETURN_ID, return_number: "1", purchase_id: null, purchase_note: null, purchase_received_at: null,
  supplier_id: null, supplier_name: null, location_id: LOCATION_ID, location_name: "شعبه مجاز",
  settlement_method: "cash", total_value_rial: "100", supplier_credit_rial: "100", variance_rial: "0",
  reason: "معیوب", status: "posted", created_at: "2026-10-20", created_by_name: null,
  reversal_entry_id: null, reversal_reason: null, reversed_at: null, reversed_by: null, reversed_by_name: null,
};
function request(body?: unknown) {
  return {
    url: "http://x/api/stock/returns",
    json: async () => body,
  } as unknown as NextRequest;
}
function context(id = RETURN_ID) { return { params: Promise.resolve({ id }) }; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, membership: { userId: SESSION.sub, permissions: new Set(["media.view", "media.manage", "inventory.adjust"]) }, error: null } as never);
  vi.mocked(authorize.canActInLocation).mockResolvedValue(true);
  vi.mocked(db.getPool).mockReturnValue({
    connect: async () => ({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
  } as never);
});

describe("GET /api/stock/returns/[id]", () => {
  it("requires inventory.view", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({ session: null, membership: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    const response = await GET(request(), context());
    expect(response.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not reveal foreign-tenant vouchers", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never);
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("r.business_id = $1"), [BUSINESS_ID, RETURN_ID]);
  });

  it("hides vouchers in branches the member cannot access", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [DOC] } as never);
    vi.mocked(authorize.canActInLocation).mockResolvedValue(false);
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("returns source and reversal journals, correction history, and supporting files", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ ...DOC, status: "reversed", reversal_entry_id: "entry-r", reversal_reason: "اشتباه", reversed_by_name: "مدیر" }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "line-1", item_id: "item-1" }] } as never)
      .mockResolvedValueOnce({ rows: [
        { id: "entry-1", entry_date: "2026-10-20", memo: "return", posting_kind: "retail_supplier_return" },
        { id: "entry-r", entry_date: "2026-10-21", memo: "reversal", posting_kind: "item_supplier_return_reversal" },
      ] } as never)
      .mockResolvedValueOnce({ rows: [{ account_code: "2100", account_name: "AP", debit: "100", credit: "0" }] } as never)
      .mockResolvedValueOnce({ rows: [{ account_code: "2100", account_name: "AP", debit: "0", credit: "100" }] } as never)
      .mockResolvedValueOnce({ rows: [{
        media_asset_id: "media-1", file_name: "invoice.pdf", mime_type: "application/pdf",
        created_at: "2026-10-20", created_by_name: "مدیر", available: true,
      }] } as never);
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(vi.mocked(db.query).mock.calls[2][0]).toContain("je.posted_at");
    expect(await response.json()).toMatchObject({
      document: { ...DOC, status: "reversed", reversal_entry_id: "entry-r", reversal_reason: "اشتباه", reversed_by_name: "مدیر" },
      journal: { id: "entry-1" },
      reversalJournal: { id: "entry-r" },
      attachments: [{ media_asset_id: "media-1", file_name: "invoice.pdf", available: true }],
      canViewAttachments: true,
      canManageAttachments: true,
      correctionHistory: [{ kind: "reversal", reason: "اشتباه", entryId: "entry-r", reversedByName: "مدیر", journalEntryId: "entry-r" }],
    });
  });
});

describe("POST /api/stock/returns/[id] reversal", () => {
  it("requires inventory.adjust before touching the source voucher", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({ session: null, membership: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    const response = await POST(request({ reason: "wrong", idempotencyKey: "k1" }), context());
    expect(response.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses a branch-restricted actor and posts the idempotent audited reversal when authorized", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ location_id: LOCATION_ID }] } as never);
    vi.mocked(authorize.canActInLocation).mockResolvedValueOnce(false);
    const denied = await POST(request({ reason: "return wrong", idempotencyKey: "reverse-1" }), context());
    expect(denied.status).toBe(404);
    expect(stockService.reverseItemSupplierReturn).not.toHaveBeenCalled();

    vi.mocked(authorize.canActInLocation).mockResolvedValue(true);
    vi.mocked(stockService.reverseItemSupplierReturn).mockResolvedValue({ id: RETURN_ID, reversalEntryId: "entry-r", duplicate: false } as never);
    const response = await POST(request({ reason: "اشتباه ثبت شد", idempotencyKey: "reverse-1" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, id: RETURN_ID, reversalEntryId: "entry-r", duplicate: false });
    expect(stockService.reverseItemSupplierReturn).toHaveBeenCalledWith(expect.anything(), {
      businessId: BUSINESS_ID, returnId: RETURN_ID, reason: "اشتباه ثبت شد", idempotencyKey: "reverse-1", actorId: SESSION.sub,
    });
  });
});
