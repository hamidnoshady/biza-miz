import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import * as connections from "./connections-service";
import { loadWooOrderDetail, wooConnectionForPrint } from "./woo-order-detail-service";
import { BUSINESS, CONNECTION, LOCATION, REVISION, wooPayload } from "../printing/__fixtures__/woo-order";

vi.mock("../db", () => ({ query: vi.fn() }));
vi.mock("./connections-service", () => ({ getConnection: vi.fn() }));
const input = { businessId: BUSINESS, locationId: LOCATION, connectionId: CONNECTION, remoteId: "1042" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connections.getConnection).mockResolvedValue({ id: CONNECTION, business_id: BUSINESS, location_id: LOCATION, provider: "woocommerce", name: "فروشگاه", status: "paused" } as never);
  vi.mocked(db.query).mockImplementation((async (sql: string) => ({ rows: sql.includes("FROM integration_webhook_events") ? [{ id: REVISION, payload: wooPayload(), created_at: new Date("2026-10-20T10:00:00Z"), status: "pending", error: null, local_order_id: null, order_number: null }] : [] })) as never);
});

describe("authoritative stored Woo detail", () => {
  it("loads a remote-only pending order, including paused connections, without creating/importing anything", async () => {
    const result = await loadWooOrderDetail({ ...input, snapshotId: REVISION });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail).toMatchObject({ snapshotId: REVISION, revision: REVISION, localOrderId: null, ingestStatus: "pending", order: { total: "24.45", paid: "0" } });
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("w.business_id = $1");
    expect(sql).toContain("w.connection_id = $2");
    expect(sql).toContain("o.location_id = $4");
    expect(params).toEqual([BUSINESS, CONNECTION, "1042", LOCATION, REVISION]);
    for (const [statement] of vi.mocked(db.query).mock.calls) expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
  it.each([
    { business_id: "another-tenant" }, { location_id: "another-branch" }, { location_id: null }, { provider: "holoo" },
  ])("denies guessed connection ids and unassigned/foreign stores: %j", async changes => {
    vi.mocked(connections.getConnection).mockResolvedValue({ business_id: BUSINESS, location_id: LOCATION, provider: "woocommerce", ...changes } as never);
    expect(await loadWooOrderDetail(input)).toMatchObject({ ok: false, status: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
  it("authorizes the connection before querying any order or returning recipient PII", async () => {
    vi.mocked(connections.getConnection).mockResolvedValue(null);
    expect(await wooConnectionForPrint(BUSINESS, LOCATION, CONNECTION)).toBeNull();
    expect(await loadWooOrderDetail(input)).toMatchObject({ ok: false, status: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each([{ remoteId: "';DROP TABLE orders" }, { remoteId: "9007199254740992" }, { connectionId: "invalid" }, { snapshotId: "invalid" }])("rejects malformed identities before DB access: %j", async changes => {
    expect(await loadWooOrderDetail({ ...input, ...changes })).toMatchObject({ ok: false, status: 404 });
    expect(connections.getConnection).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
  it("does not manufacture data for an unknown order or an incomplete legacy snapshot", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never);
    expect(await loadWooOrderDetail(input)).toMatchObject({ ok: false, status: 404 });
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ payload: { id: 1042, total: "1" } }] } as never);
    expect(await loadWooOrderDetail(input)).toMatchObject({ ok: false, status: 409, error: "woo_snapshot_invalid" });
  });
});
