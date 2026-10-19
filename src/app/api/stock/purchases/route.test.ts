import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { receiveItemPurchase } from "@/lib/retail-stock-service";
import { enqueueHolooPurchase } from "@/lib/integrations/holoo/outbox-producer";
import { RetailRequestConflict } from "@/lib/retail-stock-request";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn(), withTenantScope: (handler: unknown) => handler }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn(async () => ({ id: "00000000-0000-4000-8000-000000000002" })) }));
vi.mock("@/lib/db", () => ({ getPool: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/retail-stock-service", () => ({ receiveItemPurchase: vi.fn(), RetailStockError: class extends Error {} }));
vi.mock("@/lib/integrations/holoo/outbox-producer", () => ({ enqueueHolooPurchase: vi.fn() }));
const id = "00000000-0000-4000-8000-000000000001";
const input = { supplierId: id, idempotencyKey: "stable-receipt", lines: [{ itemId: id, quantity: "1", unitCost: "9007199254740993" }] };
const request = (body: unknown) => new NextRequest("http://localhost/api/stock/purchases", { method: "POST", body: JSON.stringify(body) });
const client = { query: vi.fn(), release: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  client.query.mockReset().mockResolvedValue({ rows: [] });
  vi.mocked(requirePermission).mockResolvedValue({ session: { businessId: id, sub: id }, error: null } as never);
  vi.mocked(getPool).mockReturnValue({ connect: async () => client } as never);
  vi.mocked(receiveItemPurchase).mockResolvedValue({ id, total: "9007199254740993" } as never);
});

describe("#915 retail receipt route", () => {
  it("forwards a stable identity and exact money; outbox and receipt commit together", async () => {
    const res = await POST(request(input));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, purchase: { id, total: "9007199254740993" } });
    expect(receiveItemPurchase).toHaveBeenCalledWith(client, expect.objectContaining({ idempotencyKey: input.idempotencyKey, lines: [expect.objectContaining(input.lines[0])] }));
    expect(enqueueHolooPurchase).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map(c => c[0])).toEqual(["BEGIN", "COMMIT"]);
  });
  it("does not reset an already exported Holoo outbox document on a lost-response retry", async () => {
    vi.mocked(receiveItemPurchase).mockResolvedValue({ id, total: "9007199254740993", duplicate: true } as never);
    expect((await POST(request(input))).status).toBe(200);
    expect(enqueueHolooPurchase).not.toHaveBeenCalled();
  });
  it.each([null, [], { ...input, idempotencyKey: undefined }, { ...input, supplierId: "foreign" }, { ...input, lines: [null] }])("rejects malformed input before connecting: %j", async value => {
    expect((await POST(request(value))).status).toBe(400);
    expect(getPool).not.toHaveBeenCalled();
  });
  it("rejects a new unattributed credit liability but accepts cash without a supplier", async () => {
    expect((await POST(request({ ...input, supplierId: null }))).status).toBe(400);
    expect((await POST(request({ ...input, supplierId: null, settlementMethod: "cash" }))).status).toBe(200);
  });
  it("rejects a stale form after the active branch changes", async () => {
    expect((await POST(request({ ...input, locationId: id }))).status).toBe(409);
    expect(getPool).not.toHaveBeenCalled();
  });
  it("returns deterministic 409 on key/payload conflict and rolls back", async () => {
    vi.mocked(receiveItemPurchase).mockRejectedValue(new RetailRequestConflict());
    const res = await POST(request(input));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "idempotency_conflict" });
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
  it("keeps an uncertain COMMIT outcome retryable instead of issuing a resolved 400", async () => {
    client.query.mockImplementation(async sql => { if (sql === "COMMIT") throw new Error("connection lost after commit"); return { rows: [] }; });
    const res = await POST(request(input));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("connection lost");
    expect(client.release).toHaveBeenCalled();
  });
  it("enforces effective write permission independently from read access", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await POST(request(input))).status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith("purchases.manage");
    expect(getPool).not.toHaveBeenCalled();
  });
  it("lists exact totals and paginates older history with validated filters", async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => ({ rows: sql.includes("COALESCE(sum")
      ? [{ count: "60", total: "90071992547409930" }]
      : sql.includes("SELECT p.id") ? [{ id, total: "9007199254740993", line_count: "1", received_at: "2026-10-01", supplier_name: "supplier" }]
      : [{ id, name: "supplier" }] }) as never);
    const res = await GET(new NextRequest("http://localhost/api/stock/purchases?page=3&q=SKU"));
    expect(await res.json()).toMatchObject({ purchases: [{ total: "9007199254740993" }], page: 3, pageSize: 25, count: 60, total: "90071992547409930" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("OFFSET"), expect.arrayContaining([25, 50]));
    expect((await GET(new NextRequest("http://localhost/api/stock/purchases?dateFrom=2026-02-30"))).status).toBe(400);
  });
});
