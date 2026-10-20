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
});
