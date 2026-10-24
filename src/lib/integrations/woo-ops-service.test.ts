import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../db";
import {
  PRODUCT_UPDATE_FIELDS,
  enqueueOperation,
  productQueueStates,
  sanitizeOrderStatus,
  sanitizeProductPatch,
  sanitizeRefund,
  storeOrdersFor,
  WooOpsError,
} from "./woo-ops-service";

vi.mock("../db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  closeDatabasePool: vi.fn(),
  withTenant: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  rlsEffective: vi.fn(),
  assertRlsEffective: vi.fn(),
}));

vi.mock("./audit", () => ({ writeIntegrationAudit: vi.fn() }));
vi.mock("./sync-service", () => ({ parentRemoteIdFor: vi.fn() }));

beforeEach(() => {
  vi.mocked(query).mockReset();
});

/**
 * The shape of what this channel is willing to write to a live shopfront.
 * Everything else in the module needs a database; these rules are the part
 * that has to be right before anything is queued, and they are pure.
 */
describe("sanitizeProductPatch", () => {
  it("passes through the fields it allows", () => {
    expect(
      sanitizeProductPatch({
        name: "چای دم‌نوش",
        regular_price: "15000",
        sale_price: "12000",
        stock_quantity: 4,
        manage_stock: true,
        status: "publish",
      }),
    ).toEqual({
      name: "چای دم‌نوش",
      regular_price: "15000",
      sale_price: "12000",
      stock_quantity: 4,
      manage_stock: true,
      status: "publish",
    });
  });

  it("drops the fields that would restructure the catalogue", () => {
    // type / parent_id / sku / attributes / categories are all writable over
    // REST and all refused here: one mis-sent `type` orphans every variation.
    const patch = sanitizeProductPatch({
      name: "تی‌شرت",
      type: "variable",
      parent_id: 0,
      sku: "TS-BLK",
      attributes: [{ id: 1 }],
    });
    expect(patch).toEqual({ name: "تی‌شرت" });
    for (const blocked of ["type", "parent_id", "sku", "attributes"]) {
      expect(PRODUCT_UPDATE_FIELDS as readonly string[]).not.toContain(blocked);
    }
  });

  it("ignores unknown keys instead of rejecting the whole patch", () => {
    // The dashboard is allowed to send a fuller object; silently dropping
    // what we will not write is safer than losing a legitimate price change.
    expect(sanitizeProductPatch({ regular_price: "99000", something_else: "x" })).toEqual({
      regular_price: "99000",
    });
  });

  it("skips null and undefined rather than clearing a field by accident", () => {
    expect(sanitizeProductPatch({ name: "تی‌شرت", description: null, sale_price: undefined })).toEqual({
      name: "تی‌شرت",
    });
  });

  it("refuses an empty patch — there is nothing to send", () => {
    expect(() => sanitizeProductPatch({ type: "simple" })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({})).toThrow(WooOpsError);
  });

  it("refuses a fractional stock quantity instead of flooring it, and a negative or blank one outright", () => {
    // Issue #943: flooring 3.7 to 3 quietly sent a quantity nobody typed.
    expect(() => sanitizeProductPatch({ stock_quantity: 3.7 })).toThrow(/invalid_stock_quantity/);
    expect(() => sanitizeProductPatch({ stock_quantity: "3.5" })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ stock_quantity: -1 })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ stock_quantity: "many" })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ stock_quantity: "" })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ stock_quantity: true })).toThrow(WooOpsError);
    // A whole number in either JSON spelling still passes.
    expect(sanitizeProductPatch({ stock_quantity: 4 }).stock_quantity).toBe(4);
    expect(sanitizeProductPatch({ stock_quantity: "12" }).stock_quantity).toBe(12);
  });

  it("keeps prices as strings so a float cannot round an owner's amount", () => {
    // WooCommerce rejects a JSON number for price, and 15000.5 as a float
    // would move money the owner never typed.
    expect(sanitizeProductPatch({ regular_price: 15000 }).regular_price).toBe("15000");
    expect(sanitizeProductPatch({ sale_price: "0" }).sale_price).toBe("0");
    expect(() => sanitizeProductPatch({ regular_price: "15,000" })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ regular_price: "free" })).toThrow(WooOpsError);
  });

  it("accepts an empty sale price, which is how a sale is ended", () => {
    expect(sanitizeProductPatch({ sale_price: "" }).sale_price).toBe("");
  });

  it("restricts product status to WooCommerce's own four", () => {
    expect(sanitizeProductPatch({ status: "draft" }).status).toBe("draft");
    expect(() => sanitizeProductPatch({ status: "completed" })).toThrow(WooOpsError);
  });

  it("reads manage_stock by value, so the string 'false' is false — and refuses a guess", () => {
    // Issue #943: `Boolean("false")` is `true`, so a caller that sent the
    // string "false" to STOP tracking stock used to queue the exact opposite
    // against a live shopfront.
    expect(sanitizeProductPatch({ manage_stock: "false" }).manage_stock).toBe(false);
    expect(sanitizeProductPatch({ manage_stock: "true" }).manage_stock).toBe(true);
    expect(sanitizeProductPatch({ manage_stock: false }).manage_stock).toBe(false);
    expect(sanitizeProductPatch({ manage_stock: 0 }).manage_stock).toBe(false);
    expect(sanitizeProductPatch({ manage_stock: 1 }).manage_stock).toBe(true);
    expect(sanitizeProductPatch({ manage_stock: "0" }).manage_stock).toBe(false);
    expect(() => sanitizeProductPatch({ manage_stock: "yes" })).toThrow(/invalid_manage_stock/);
    expect(() => sanitizeProductPatch({ manage_stock: 2 })).toThrow(WooOpsError);
  });
});

describe("sanitizeOrderStatus", () => {
  it("accepts each of WooCommerce's canonical statuses", () => {
    for (const status of ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]) {
      expect(sanitizeOrderStatus(status)).toBe(status);
    }
  });

  it("rejects anything else, including a plausible invention", () => {
    expect(() => sanitizeOrderStatus("shipped")).toThrow(WooOpsError);
    expect(() => sanitizeOrderStatus("Completed")).toThrow(WooOpsError);
    expect(() => sanitizeOrderStatus("")).toThrow(WooOpsError);
  });
});

describe("sanitizeRefund", () => {
  it("normalises the amount and the optional reason", () => {
    expect(sanitizeRefund({ amount: " 25000 ", reason: "  مرجوعی مشتری  " })).toEqual({
      amount: "25000",
      reason: "مرجوعی مشتری",
      api_refund: false,
    });
    // The WP Manager is Persian-first: a numeric keypad may produce Persian or
    // Arabic-Indic digits, and copied WooCommerce totals often include grouping.
    expect(sanitizeRefund({ amount: "۱٬۲۵۰٫۵" }).amount).toBe("1250.5");
    expect(sanitizeRefund({ amount: "١,٢٥٠.٥" }).amount).toBe("1250.5");
  });

  it("never asks the gateway to move money", () => {
    // Forced false even when a caller begs: refunding on a card is
    // irreversible and happens on someone else's money.
    expect(sanitizeRefund({ amount: "1", api_refund: true as never }).api_refund).toBe(false);
  });

  it("rejects an amount that is not a positive decimal", () => {
    for (const amount of ["", "0", "-500", "abc", undefined]) {
      expect(() => sanitizeRefund({ amount } as Record<string, unknown>)).toThrow(WooOpsError);
    }
    expect(sanitizeRefund({ amount: "1,000" }).amount).toBe("1000");
    expect(sanitizeRefund({ amount: "0.5" }).amount).toBe("0.5");
  });

  it("caps a runaway reason so the payload stays writable", () => {
    const reason = "ب".repeat(900);
    expect(sanitizeRefund({ amount: "1", reason }).reason).toHaveLength(500);
  });
});

describe("enqueueOperation", () => {
  it("does not collapse separate refunds for the same order", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    await enqueueOperation("biz", "conn", "refund_create", "7001", { amount: "10", reason: "first" });
    await enqueueOperation("biz", "conn", "refund_create", "7001", { amount: "11", reason: "second" });

    expect(query).toHaveBeenCalledTimes(2);
    const firstParams = vi.mocked(query).mock.calls[0][1] as unknown[];
    const secondParams = vi.mocked(query).mock.calls[1][1] as unknown[];
    expect(firstParams[3]).toMatch(/^7001:woo-refund:conn:7001:/);
    expect(secondParams[3]).toMatch(/^7001:woo-refund:conn:7001:/);
    expect(secondParams[3]).not.toBe(firstParams[3]);
    expect(JSON.parse(String(firstParams[4]))).toMatchObject({ amount: "10", __orderRemoteId: "7001" });
    expect(JSON.parse(String(secondParams[4]))).toMatchObject({ amount: "11", __orderRemoteId: "7001" });
  });

  it("merges an undelivered product edit instead of overwriting it — a price-only then a stock-only queue keeps BOTH", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    // The reproduction from issue #943: queue a price-only change, then a
    // stock-only change before the worker delivers. The old
    // `payload = EXCLUDED.payload` discarded the price; the upsert now
    // merges field-by-field while the event is still undelivered.
    await enqueueOperation("biz", "conn", "product_update", "55", { regular_price: "15000" });
    await enqueueOperation("biz", "conn", "product_update", "55", { stock_quantity: 7 });

    const [sql] = vi.mocked(query).mock.calls[1] as unknown as [string, unknown[]];
    // The merge is a SQL-level rule: the existing payload keeps the fields
    // the new patch does not mention, the new patch wins per field.
    expect(sql).toContain("integration_outbox_events.payload || EXCLUDED.payload");
    expect(sql).toContain("WHEN integration_outbox_events.entity_type = 'product_update'");
    expect(sql).toContain("'pending', 'deferred', 'failed', 'processing'");
    // A delivered or given-up event (sent/dead/needs_review) starts over
    // with exactly the new patch — the CASE's ELSE branch.
    expect(sql).toContain("ELSE EXCLUDED.payload");
    expect(sql).toContain("status = 'pending', attempts = 0");
  });
});

describe("productQueueStates", () => {
  it("aggregates the outbox into one honest state per product", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        {
          remote_id: "10",
          entity_type: "product_update",
          status: "pending",
          payload: { regular_price: "15000", __parentRemoteId: "9" },
          last_error: null,
          updated_at: "2026-10-12T10:00:00Z",
          sent_at: null,
        },
        {
          remote_id: "10",
          entity_type: "price",
          status: "sent",
          payload: { regular_price: "14000" },
          last_error: null,
          updated_at: "2026-10-11T09:00:00Z",
          sent_at: "2026-10-11T09:01:00Z",
        },
        {
          remote_id: "11",
          entity_type: "stock",
          status: "dead",
          payload: { stock_quantity: 3 },
          last_error: "404 Not Found",
          updated_at: "2026-10-12T08:00:00Z",
          sent_at: null,
        },
      ],
    } as never);

    const states = await productQueueStates("biz", "conn", ["10", "11", "12"]);

    // Reserved `__` routing keys never surface as part of the pending patch.
    expect(states["10"]).toEqual({
      state: "queued",
      kinds: ["product_update"],
      pendingPatch: { regular_price: "15000" },
      lastError: null,
      updatedAt: "2026-10-12T10:00:00Z",
      lastSentAt: "2026-10-11T09:01:00Z",
    });
    // A dead-lettered push is "failed" and carries its error to the row.
    expect(states["11"]).toMatchObject({ state: "failed", kinds: ["stock"], lastError: "404 Not Found" });
    // A product with no events at all is absent — the caller reads that as idle.
    expect(states["12"]).toBeUndefined();
  });

  it("lets a failure outrank a still-queued sibling event", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        {
          remote_id: "10",
          entity_type: "product_update",
          status: "pending",
          payload: { name: "x" },
          last_error: null,
          updated_at: "2026-10-12T10:00:00Z",
          sent_at: null,
        },
        {
          remote_id: "10",
          entity_type: "stock",
          status: "failed",
          payload: { stock_quantity: 1 },
          last_error: "timeout",
          updated_at: "2026-10-12T09:00:00Z",
          sent_at: null,
        },
      ],
    } as never);

    const states = await productQueueStates("biz", "conn", ["10"]);
    expect(states["10"].state).toBe("failed");
    expect(states["10"].kinds.sort()).toEqual(["product_update", "stock"]);
  });

  it("does not query at all for an empty page", async () => {
    await expect(productQueueStates("biz", "conn", [])).resolves.toEqual({});
    expect(query).not.toHaveBeenCalled();
  });
});

describe("storeOrdersFor", () => {
  it("reads orders from the inbox as well as imported mappings", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        {
          remote_id: "7001",
          local_order_id: null,
          order_number: null,
          event_topic: "order.updated",
          payload: {
            id: 7001,
            number: "A-7001",
            status: "pending",
            total: "1250.50",
            currency: "IRT",
            date_created: "2026-09-18T10:15:00+03:30",
            payment_method: "cod",
            billing: { first_name: "لیلا", last_name: "رضایی" },
            line_items: [{ id: 1 }, { id: 2 }],
          },
          ingest_status: "processed",
          ingest_error: null,
          created_at: "2026-09-18T10:16:00Z",
          outbox_operations: [
            {
              type: "order_status",
              status: "pending",
              targetStatus: "processing",
              amount: null,
              reason: null,
              error: null,
            },
          ],
        },
      ],
    } as never);

    const rows = await storeOrdersFor("biz", "conn", 500);

    expect(rows).toEqual([
      {
        remoteId: "7001",
        localOrderId: null,
        localOrderNumber: null,
        number: "A-7001",
        status: "pending",
        total: "1250.50",
        currency: "IRT",
        dateCreated: "2026-09-18T10:15:00+03:30",
        customer: "لیلا رضایی",
        paymentMethod: "cod",
        ingestStatus: "processed",
        ingestError: null,
        lineCount: 2,
        operations: [
          {
            type: "order_status",
            status: "pending",
            targetStatus: "processing",
            amount: null,
            reason: null,
            error: null,
          },
        ],
      },
    ]);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(String(sql)).toContain("latest_events");
    expect(String(sql)).toContain("integration_webhook_events w");
    expect(params).toEqual(["biz", "conn", 200, 0]);
  });
});
