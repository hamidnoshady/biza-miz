/**
 * The print endpoint's request contract — strict, and deliberately narrow
 * (issue #815: server-side loading of persisted documents + strict payload
 * validation).
 *
 * Two properties matter here and nowhere else, so they are pinned here:
 *
 *  - a caller may name a STORED document (an order, an item) and nothing else.
 *    A browser-built receipt, ticket or label is refused with
 *    `document_required` rather than trusted, ignored or half-read;
 *  - everything a caller does send is shaped: real uuids for ids, known
 *    document types, bounded strings. A malformed id never reaches Postgres as
 *    an `invalid input syntax for type uuid` 500 — it is a 400 here.
 */
import { describe, expect, it } from "vitest";
import {
  defaultDocumentTypeFor,
  documentTypesFor,
  parsePrintRequest,
  type ParsedPrintRequest,
  type PrintRequestFailure,
} from "./document-request";

const ORDER_ID = "1f3d5b70-2c94-4a1e-8f6d-0b2c4e6a8d10";
const ITEM_ID = "2a4e6c81-3d05-4b2f-9a7e-1c3d5f7b9e21";
const PRINTER_ID = "3b5f7d92-4e16-4c30-8b8f-2d4e6a8c0f32";
const TEMPLATE_ID = "4c608e03-5f27-4d41-9c90-3e5f7b9d1a43";

function ok(body: unknown): ParsedPrintRequest {
  const parsed = parsePrintRequest(body);
  if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.error}`);
  return parsed;
}

function failure(body: unknown): PrintRequestFailure {
  const parsed = parsePrintRequest(body);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed;
}

describe("stored documents are named, not shipped", () => {
  it("parses a sale reference with the printer, template and document type the caller chose", () => {
    const parsed = ok({
      printerId: PRINTER_ID,
      templateId: TEMPLATE_ID,
      printRequestId: "receipt:1f3d5b70",
      documentType: "invoice",
      document: { kind: "order-receipt", orderId: ORDER_ID },
    });
    expect(parsed).toEqual({
      ok: true,
      printerId: PRINTER_ID,
      templateId: TEMPLATE_ID,
      printRequestId: "receipt:1f3d5b70",
      documentType: "invoice",
      source: { kind: "document", document: { kind: "order-receipt", orderId: ORDER_ID } },
    });
  });

  it("parses a kitchen ticket and an item label, with and without a pinned code", () => {
    expect(ok({ document: { kind: "kitchen-ticket", orderId: ORDER_ID } }).source).toEqual({
      kind: "document",
      document: { kind: "kitchen-ticket", orderId: ORDER_ID },
    });
    expect(ok({ document: { kind: "item-label", itemId: ITEM_ID } }).source).toEqual({
      kind: "document",
      document: { kind: "item-label", itemId: ITEM_ID },
    });
    expect(ok({ document: { kind: "item-label", itemId: ITEM_ID, code: "2000000000015" } }).source).toEqual({
      kind: "document",
      document: { kind: "item-label", itemId: ITEM_ID, code: "2000000000015" },
    });
  });

  it("leaves the document type unset when the caller does not name one — the kind decides", () => {
    const parsed = ok({ document: { kind: "kitchen-ticket", orderId: ORDER_ID } });
    expect(parsed.documentType).toBeNull();
    expect(defaultDocumentTypeFor({ kind: "kitchen-ticket", orderId: ORDER_ID })).toBe("kitchen");
    expect(defaultDocumentTypeFor({ kind: "item-label", itemId: ITEM_ID })).toBe("label");
    expect(defaultDocumentTypeFor({ kind: "order-receipt", orderId: ORDER_ID })).toBe("receipt");
  });

  it("maps each document kind to the document types it may be printed as", () => {
    // One sale, two formal shapes — the two named actions in the invoice modal.
    expect(documentTypesFor({ kind: "order-receipt", orderId: ORDER_ID })).toEqual(["receipt", "invoice"]);
    expect(documentTypesFor({ kind: "kitchen-ticket", orderId: ORDER_ID })).toEqual(["kitchen"]);
    expect(documentTypesFor({ kind: "item-label", itemId: ITEM_ID })).toEqual(["label"]);
  });

  it("refuses a browser-built receipt, ticket or label instead of trusting it", () => {
    for (const job of [
      { type: "receipt", receipt: { business: { name: "کافه" } } },
      { type: "kitchen-ticket", ticket: { label: "میز ۱", lines: [] } },
      { type: "label", label: { itemName: "کالا", code: "123", fields: [] } },
    ]) {
      const refusal = failure({ job });
      expect(refusal.status, JSON.stringify(job)).toBe(400);
      expect(refusal.error, JSON.stringify(job)).toBe("document_required");
    }
  });
});

describe("sample jobs are the only payload left", () => {
  it("accepts a test print of a known document type", () => {
    for (const kind of ["receipt", "invoice", "kitchen", "label"] as const) {
      expect(ok({ job: { type: "test", kind } }).source).toEqual({ kind: "sample", job: { type: "test", kind } });
    }
    expect(ok({ job: { type: "test", kind: "receipt" } }).source).toEqual({
      kind: "sample",
      job: { type: "test", kind: "receipt" },
    });
    expect(ok({ job: { type: "drawer-kick" } }).source).toEqual({
      kind: "sample",
      job: { type: "drawer-kick" },
    });
  });

  it("refuses a test print with no (or an unknown) document type", () => {
    expect(failure({ job: { type: "test" } }).error).toBe("bad_request");
    expect(failure({ job: { type: "test", kind: "poster" } }).error).toBe("bad_request");
    expect(failure({ job: {} }).error).toBe("bad_request");
    expect(failure({}).error).toBe("bad_request");
  });

  it("refuses a body that asks for a stored document AND a sample at once", () => {
    expect(
      failure({ document: { kind: "order-receipt", orderId: ORDER_ID }, job: { type: "drawer-kick" } }).status,
    ).toBe(400);
  });
});

describe("strict shapes", () => {
  it("refuses anything that is not an object", () => {
    for (const body of [null, undefined, "receipt", 42, [], true]) {
      expect(failure(body).error, String(body)).toBe("bad_request");
    }
  });

  it("requires a real uuid for every document reference", () => {
    for (const document of [
      { kind: "order-receipt" },
      { kind: "order-receipt", orderId: "order-1" },
      { kind: "order-receipt", orderId: `${ORDER_ID} ` },
      { kind: "order-receipt", orderId: "'; DROP TABLE orders; --" },
      { kind: "kitchen-ticket", orderId: 42 },
      { kind: "item-label", itemId: "item-1" },
      { kind: "item-label", itemId: ITEM_ID, code: "" },
      { kind: "item-label", itemId: ITEM_ID, code: "not a barcode" },
      { kind: "item-label", itemId: ITEM_ID, code: "x".repeat(65) },
      { kind: "invoice", orderId: ORDER_ID },
      { kind: "" },
    ]) {
      expect(failure({ document }).error, JSON.stringify(document)).toBe("bad_request");
    }
  });

  it("requires uuid printer and template ids (they are resolved against a branch, not parsed)", () => {
    const base = { document: { kind: "order-receipt", orderId: ORDER_ID } };
    expect(failure({ ...base, printerId: "printer-1" }).error).toBe("bad_request");
    expect(failure({ ...base, templateId: "saved-1" }).error).toBe("bad_request");
    expect(failure({ ...base, printerId: "" }).error).toBe("bad_request");
    expect(ok({ ...base, printerId: null, templateId: null }).printerId).toBeNull();
  });

  it("requires a known document type", () => {
    const base = { document: { kind: "order-receipt", orderId: ORDER_ID } };
    for (const documentType of ["poster", "Receipt", "", 3, {}]) {
      expect(failure({ ...base, documentType }).error, String(documentType)).toBe("bad_request");
    }
    for (const documentType of ["receipt", "invoice", "kitchen", "label"]) {
      expect(ok({ ...base, documentType }).documentType).toBe(documentType);
    }
  });

  it("bounds the caller's correlation id", () => {
    const base = { document: { kind: "order-receipt", orderId: ORDER_ID } };
    expect(ok({ ...base, printRequestId: "reprint:invoice:abc-123" }).printRequestId).toBe("reprint:invoice:abc-123");
    expect(failure({ ...base, printRequestId: "" }).error).toBe("bad_request");
    expect(failure({ ...base, printRequestId: "x".repeat(121) }).error).toBe("bad_request");
    expect(failure({ ...base, printRequestId: "سند" }).error).toBe("bad_request");
    expect(failure({ ...base, printRequestId: 42 }).error).toBe("bad_request");
  });
});
