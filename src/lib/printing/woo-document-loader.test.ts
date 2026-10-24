import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPrintDocument } from "./document-loader";
import * as woo from "../integrations/woo-order-detail-service";
import * as sale from "../order-read-service";
import { BUSINESS, CONNECTION, LOCATION, REVISION, wooDetail } from "./__fixtures__/woo-order";

vi.mock("../integrations/woo-order-detail-service", () => ({ loadWooOrderDetail: vi.fn() }));
vi.mock("../order-read-service", () => ({ getOrderDetail: vi.fn() }));
vi.mock("./identity", () => ({ loadPrintIdentity: vi.fn(async () => ({ business: { name: "فروشگاه" }, currencyUnit: "toman" })) }));
const document = { kind: "woo-order-shipping-label" as const, connectionId: CONNECTION, remoteId: "1042", snapshotId: REVISION };
const input = { businessId: BUSINESS, locationId: LOCATION, documentType: "shipping_label" as const, document };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(woo.loadWooOrderDetail).mockResolvedValue({ ok: true, detail: wooDetail() }); });

describe("canonical remote document loader", () => {
  it("loads a stable source revision without a local accounting order", async () => {
    const loaded = await loadPrintDocument(input);
    expect(loaded.ok).toBe(true);
    expect(woo.loadWooOrderDetail).toHaveBeenCalledWith({ businessId: BUSINESS, locationId: LOCATION, connectionId: CONNECTION, remoteId: "1042", snapshotId: REVISION });
    expect(sale.getOrderDetail).not.toHaveBeenCalled();
    if (!loaded.ok) return;
    expect(loaded.document).toMatchObject({ source: "woo-order-shipping-label", entityId: `woo:${CONNECTION}:1042`, job: { type: "woo-order", data: { sourceRevision: { id: REVISION } } } });
  });
  it("blocks missing recipient information for shipping, never blocks the independent invoice", async () => {
    vi.mocked(woo.loadWooOrderDetail).mockResolvedValue({ ok: true, detail: wooDetail({ shipping: {} }) });
    expect(await loadPrintDocument(input)).toEqual({ ok: false, status: 409, error: "shipping_address_incomplete" });
    expect((await loadPrintDocument({ ...input, documentType: "woo_invoice", document: { ...document, kind: "woo-order-invoice" } })).ok).toBe(true);
  });
  it("requires an explicit shipment for a multi-tracking order", async () => {
    vi.mocked(woo.loadWooOrderDetail).mockResolvedValue({ ok: true, detail: wooDetail({ shipments: [{ tracking_number: "1111" }, { tracking_number: "2222" }] }) });
    expect(await loadPrintDocument(input)).toMatchObject({ error: "shipment_selection_required" });
    expect((await loadPrintDocument({ ...input, document: { ...document, shipmentIndex: 1, packageCount: 2, packageIndex: 2 } })).ok).toBe(true);
    expect(await loadPrintDocument({ ...input, document: { ...document, shipmentIndex: 2 } })).toMatchObject({ error: "shipment_selection_required" });
  });
  it("refuses using a Woo identity through POS invoice/receipt or inventory label rules", async () => {
    for (const documentType of ["receipt", "invoice", "label", "kitchen"] as const) {
      expect(await loadPrintDocument({ ...input, documentType })).toMatchObject({ ok: false, error: "document_type_mismatch" });
    }
    expect(woo.loadWooOrderDetail).not.toHaveBeenCalled();
  });
  it("propagates the authoritative authorization refusal without rendering", async () => {
    vi.mocked(woo.loadWooOrderDetail).mockResolvedValue({ ok: false, status: 404, error: "document_not_found" });
    expect(await loadPrintDocument(input)).toMatchObject({ ok: false, status: 404 });
    expect(sale.getOrderDetail).not.toHaveBeenCalled();
  });
});
