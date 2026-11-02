import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionRow } from "./connections-service";
import type { WooCommerceClient } from "./woocommerce-client";
import { query } from "../db";
import { acknowledgeProductPublication, applyProductPublication, previewProductPublication, queueProductPublication } from "./product-publication-service";
const mocks = vi.hoisted(() => ({ getConnection: vi.fn(), price: vi.fn(), attributes: vi.fn() }));
vi.mock("../db", () => ({ query: vi.fn(), withTenantTransaction: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock("./connections-service", () => ({ getConnection: mocks.getConnection }));
vi.mock("./woo-price-source-service", () => ({ resolveMappedWooPrice: mocks.price }));
vi.mock("./product-attribute-mappings-service", () => ({ buildMappedWooAttributes: mocks.attributes }));
const connection = { id: "store", business_id: "tenant", location_id: "branch", provider: "woocommerce", status: "active", link_mode: "rest_api", currency_unit: "IRR", name: "Store" } as unknown as ConnectionRow;
const parent = { id: "parent", name: "Family", sku: "family", kind: "variant_parent", parent_item_id: null, publish_status: "published", is_sellable: true, is_active: true };
const child = { ...parent, id: "child", name: "Blue", sku: "blue", kind: "variant_child", parent_item_id: "parent" };
beforeEach(() => { vi.clearAllMocks(); mocks.getConnection.mockResolvedValue(connection); mocks.price.mockResolvedValue(123n); mocks.attributes.mockResolvedValue([]); vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never); });
describe("publication gateway", () => {
  it("queues only the parent; child creation waits until a validated successful ACK", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [parent, child] } as never).mockResolvedValueOnce({ rows: [] } as never);
    const preview = await previewProductPublication("tenant", "branch", "store", "parent");
    expect(preview.action).toBe("create");
    expect(preview.payload.__children).toHaveLength(1);
    await queueProductPublication("tenant", preview);
    const insert = vi.mocked(query).mock.calls.filter(([sql]) => sql.includes("INSERT INTO integration_outbox_events"));
    expect(insert).toHaveLength(1);
    expect(insert[0][1]?.[3]).toBe("parent");
    expect(vi.mocked(query).mock.calls.some(([sql]) => sql.includes("INSERT INTO integration_mappings"))).toBe(false);
  });
  it("rejects cross-branch publication before reading local or remote data", async () => {
    await expect(previewProductPublication("tenant", "other", "store", "parent")).rejects.toThrow("connection_unavailable");
    expect(query).not.toHaveBeenCalled();
  });
  it("restricts an unassigned connection to its effective primary branch", async () => {
    mocks.getConnection.mockResolvedValue({ ...connection, location_id: null });
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: "primary" }] } as never);
    await expect(previewProductPublication("tenant", "secondary", "store", "parent")).rejects.toThrow("connection_unavailable");
  });
  it("refuses missing selected sale price instead of publishing purchase cost", async () => {
    mocks.price.mockResolvedValue(null);
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ ...child, parent_item_id: null, kind: "simple" }] } as never).mockResolvedValueOnce({ rows: [] } as never);
    await expect(previewProductPublication("tenant", "branch", "store", "child")).rejects.toThrow("sale_price_missing");
  });
  it("does not record identity on a failed remote request or an invalid ACK", async () => {
    const event = { remote_id: "operation", payload: { sku: "sku", __operationId: "op", __localId: "parent" } };
    const client = { listProducts: vi.fn().mockResolvedValue([]), createProduct: vi.fn().mockRejectedValue(new Error("timeout")) } as unknown as WooCommerceClient;
    await expect(applyProductPublication(connection, client, event)).rejects.toThrow("timeout");
    expect(query).not.toHaveBeenCalled();
    await expect(acknowledgeProductPublication(connection, event)).rejects.toThrow("invalid_remote_ack");
    expect(vi.mocked(query).mock.calls.some(([sql]) => sql.includes("INSERT INTO integration_mappings"))).toBe(false);
  });
  it("ACK maps the parent before queuing children with its real remote identity", async () => {
    const payload = { __ackRemoteId: "99", __localId: "parent", __wooType: "variable", __operationId: "op", __children: [{ __localId: "child", sku: "blue" }] };
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ payload }] } as never);
    await acknowledgeProductPublication(connection, { remote_id: "op", payload });
    const calls = vi.mocked(query).mock.calls;
    const mappingIndex = calls.findIndex(([sql]) => sql.includes("INSERT INTO integration_mappings"));
    const childIndex = calls.findIndex(([sql]) => sql.includes("INSERT INTO integration_outbox_events"));
    expect(mappingIndex).toBeGreaterThan(0);
    expect(childIndex).toBeGreaterThan(mappingIndex);
    expect(JSON.parse(String(calls[childIndex][1]?.[4])).__parentRemoteId).toBe("99");
  });
});
