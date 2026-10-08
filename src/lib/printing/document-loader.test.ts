/**
 * `loadPrintDocument` — where a print request becomes a document, and where the
 * branch boundary is enforced (issue #815: server-side loading and
 * authorization of persisted operational documents; tenant/branch isolation).
 *
 * The three document readers are mocked (their own behaviour is pinned in
 * order-print-data.test.ts, label-print-data.test.ts and the retail invoice's
 * print-data.test.ts). What is pinned HERE is the dispatch and its two rules:
 *
 *  - every reader is called with the CALLER's active branch and business, so a
 *    reference to another branch's sale can only come back empty (404) — the
 *    loaders are branch-scoped queries, and this is the one place that decides
 *    which branch they are scoped to;
 *  - a sale is one document with the sale's own builder: a retail sale prints
 *    through the retail invoice's canonical builder, everything else through
 *    the generic one, and a document type that does not belong to the document
 *    kind is refused before a reader runs at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as orderRead from "../order-read-service";
import * as retailPrint from "../retail-invoice/print-data";
import * as labelPrint from "./label-print-data";
import * as identity from "./identity";
import { loadPrintDocument } from "./document-loader";
import type { OrderDetail } from "../order-read-service";

vi.mock("../order-read-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../order-read-service")>();
  return { ...actual, getOrderDetail: vi.fn() };
});
vi.mock("../retail-invoice/print-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../retail-invoice/print-data")>();
  return { ...actual, getRetailInvoicePrintData: vi.fn() };
});
vi.mock("./label-print-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./label-print-data")>();
  return { ...actual, getLabelPrintData: vi.fn() };
});
vi.mock("./identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity")>();
  return { ...actual, loadPrintIdentity: vi.fn() };
});

const ORDER_ID = "1f3d5b70-2c94-4a1e-8f6d-0b2c4e6a8d10";
const ITEM_ID = "2a4e6c81-3d05-4b2f-9a7e-1c3d5f7b9e21";
const BARCODE_ID = "6e82a025-7b49-4f63-9eb2-50719d1f3c65";

const BUSINESS = { name: "کافه نمونه", address: "تهران", phone: "021", footerMessage: null };

function detail(overrides: Partial<OrderDetail["order"]> = {}): OrderDetail {
  return {
    order: {
      id: ORDER_ID,
      location_id: "loc-1",
      order_number: "12",
      type: "dine_in",
      status: "completed",
      table_id: null,
      table_name: "میز ۳",
      customer_id: null,
      customer_name: null,
      customer_phone: null,
      guest_count: null,
      subtotal: "100000",
      discount: "0",
      discount_type: null,
      discount_value: null,
      service_charge: "0",
      tax: "9000",
      total: "109000",
      tip_amount: "0",
      note: null,
      opened_by: null,
      closed_by: null,
      opened_at: new Date("2026-02-01T18:30:00.000Z"),
      closed_at: new Date("2026-02-01T20:15:00.000Z"),
      voided_reason: null,
      ...overrides,
    },
    items: [
      {
        id: "item-1",
        menu_item_id: null,
        name_snapshot: "چای",
        unit_price: "100000",
        quantity: 1,
        status: "served",
        note: null,
        void_reason: null,
        created_at: new Date("2026-02-01T18:31:00.000Z"),
      },
    ],
    modifiers: [],
    payments: [],
  };
}

const input = { businessId: "biz-1", locationId: "loc-1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orderRead.getOrderDetail).mockResolvedValue(detail() as never);
  vi.mocked(identity.loadPrintIdentity).mockResolvedValue({ business: BUSINESS, currencyUnit: "toman" } as never);
  vi.mocked(retailPrint.getRetailInvoicePrintData).mockResolvedValue(null as never);
  vi.mocked(labelPrint.getLabelPrintData).mockResolvedValue(null as never);
});

describe("a sale's receipt", () => {
  it("loads the order in the caller's own branch and builds the receipt from its rows", async () => {
    const result = await loadPrintDocument({
      ...input,
      document: { kind: "order-receipt", orderId: ORDER_ID },
      documentType: "receipt",
    });

    expect(orderRead.getOrderDetail).toHaveBeenCalledWith("loc-1", ORDER_ID);
    expect(identity.loadPrintIdentity).toHaveBeenCalledWith("biz-1", "loc-1");
    expect(result).toEqual({
      ok: true,
      document: {
        job: {
          type: "receipt",
          receipt: expect.objectContaining({ orderLabel: "#12", total: 109_000, unit: "toman" }),
        },
        entityId: ORDER_ID,
        source: "order-receipt",
      },
    });
  });

  it("prints a retail sale through the retail invoice's canonical builder", async () => {
    const receipt = { business: BUSINESS, orderLabel: "فاکتور ۹", orderTypeLabel: "فاکتور فروش", issuedAt: "2026-01-01T00:00:00.000Z", lines: [], subtotal: 0, discount: 0, tax: 0, total: 0 };
    vi.mocked(orderRead.getOrderDetail).mockResolvedValue(detail({ type: "retail" }) as never);
    vi.mocked(retailPrint.getRetailInvoicePrintData).mockResolvedValue({ receipt, meta: { legacy: false } } as never);

    const result = await loadPrintDocument({
      ...input,
      document: { kind: "order-receipt", orderId: ORDER_ID },
      documentType: "invoice",
    });

    expect(retailPrint.getRetailInvoicePrintData).toHaveBeenCalledWith("biz-1", "loc-1", ORDER_ID);
    // The invoice builder's document is used verbatim — no second construction.
    expect(result).toMatchObject({ ok: true, document: { job: { type: "receipt", receipt }, entityId: ORDER_ID } });
    expect(identity.loadPrintIdentity).not.toHaveBeenCalled();
  });

  it("still prints a retail order the invoice builder cannot describe (a pre-retail row)", async () => {
    vi.mocked(orderRead.getOrderDetail).mockResolvedValue(detail({ type: "retail" }) as never);
    vi.mocked(retailPrint.getRetailInvoicePrintData).mockResolvedValue(null as never);

    const result = await loadPrintDocument({
      ...input,
      document: { kind: "order-receipt", orderId: ORDER_ID },
      documentType: "receipt",
    });

    expect(result).toMatchObject({ ok: true, document: { entityId: ORDER_ID } });
    expect(identity.loadPrintIdentity).toHaveBeenCalledWith("biz-1", "loc-1");
  });

  it("answers 404 for a sale that is not in the caller's branch — and builds nothing", async () => {
    vi.mocked(orderRead.getOrderDetail).mockResolvedValue(null as never);
    const result = await loadPrintDocument({
      ...input,
      document: { kind: "order-receipt", orderId: ORDER_ID },
      documentType: "receipt",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "document_not_found" });
    expect(identity.loadPrintIdentity).not.toHaveBeenCalled();
    expect(retailPrint.getRetailInvoicePrintData).not.toHaveBeenCalled();
  });
});

describe("a kitchen ticket", () => {
  it("loads the sale and builds the ticket from its lines", async () => {
    const result = await loadPrintDocument({
      ...input,
      document: { kind: "kitchen-ticket", orderId: ORDER_ID },
      documentType: "kitchen",
    });
    expect(orderRead.getOrderDetail).toHaveBeenCalledWith("loc-1", ORDER_ID);
    expect(result).toEqual({
      ok: true,
      document: {
        job: { type: "kitchen-ticket", ticket: expect.objectContaining({ label: "میز ۳" }) },
        entityId: ORDER_ID,
        source: "kitchen-ticket",
      },
    });
  });

  it("answers 404 for another branch's sale", async () => {
    vi.mocked(orderRead.getOrderDetail).mockResolvedValue(null as never);
    const result = await loadPrintDocument({
      ...input,
      document: { kind: "kitchen-ticket", orderId: ORDER_ID },
      documentType: "kitchen",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "document_not_found" });
  });
});

describe("an item label", () => {
  it("loads the label for the caller's branch and records the barcode row", async () => {
    vi.mocked(labelPrint.getLabelPrintData).mockResolvedValue({
      label: { businessName: "کافه نمونه", itemName: "قهوه", code: "2000000000015", fields: [] },
      entityId: BARCODE_ID,
    } as never);

    const result = await loadPrintDocument({
      ...input,
      document: { kind: "item-label", itemId: ITEM_ID, code: "2000000000015" },
      documentType: "label",
    });

    expect(labelPrint.getLabelPrintData).toHaveBeenCalledWith({
      businessId: "biz-1",
      locationId: "loc-1",
      itemId: ITEM_ID,
      code: "2000000000015",
    });
    expect(result).toEqual({
      ok: true,
      document: {
        job: {
          type: "label",
          label: { businessName: "کافه نمونه", itemName: "قهوه", code: "2000000000015", fields: [] },
        },
        entityId: BARCODE_ID,
        source: "item-label",
      },
    });
  });

  it("answers 404 when the item — or a code for it — is not in this branch", async () => {
    const result = await loadPrintDocument({
      ...input,
      document: { kind: "item-label", itemId: ITEM_ID },
      documentType: "label",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "document_not_found" });
  });
});

describe("document type discipline", () => {
  it("refuses a document printed as the wrong kind of document, without touching any reader", async () => {
    for (const [document, documentType] of [
      [{ kind: "kitchen-ticket", orderId: ORDER_ID }, "receipt"],
      [{ kind: "item-label", itemId: ITEM_ID }, "invoice"],
      [{ kind: "order-receipt", orderId: ORDER_ID }, "kitchen"],
      [{ kind: "order-receipt", orderId: ORDER_ID }, "label"],
    ] as const) {
      const result = await loadPrintDocument({ ...input, document, documentType });
      expect(result, `${document.kind} as ${documentType}`).toEqual({
        ok: false,
        status: 409,
        error: "document_type_mismatch",
      });
    }
    expect(orderRead.getOrderDetail).not.toHaveBeenCalled();
    expect(labelPrint.getLabelPrintData).not.toHaveBeenCalled();
  });

  it("prints one sale as both of its formal shapes", async () => {
    for (const documentType of ["receipt", "invoice"] as const) {
      const result = await loadPrintDocument({
        ...input,
        document: { kind: "order-receipt", orderId: ORDER_ID },
        documentType,
      });
      expect(result.ok, documentType).toBe(true);
    }
  });
});
