/**
 * Issue #918 — the return voucher's input contract: strict parsing and the
 * idempotency fingerprint. Pure (no database), so these run in the unit
 * suite; the transactional behavior they guard is covered by
 * integration/retail-supplier-returns-918.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { RetailReturnError } from "./retail-return-errors";
import {
  MAX_RETURN_LINES,
  parseSupplierReturnBody,
  returnRequestFingerprint,
} from "./retail-return-validation";

const ITEM = "11111111-1111-4111-8111-111111111111";
const PURCHASE = "22222222-2222-4222-8222-222222222222";
const SUPPLIER = "33333333-3333-4333-8333-333333333333";
const BATCH = "44444444-4444-4444-8444-444444444444";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    purchaseId: PURCHASE,
    supplierId: null,
    settlementMethod: "accounts_payable",
    reason: "کالای معیوب",
    idempotencyKey: "draft-1",
    lines: [{ itemId: ITEM, quantity: "2" }],
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RetailReturnError);
    return (err as RetailReturnError).code;
  }
  throw new Error("expected a RetailReturnError");
}

describe("parseSupplierReturnBody", () => {
  it("accepts a minimal valid voucher", () => {
    const parsed = parseSupplierReturnBody(validBody());
    expect(parsed).toEqual({
      purchaseId: PURCHASE,
      supplierId: null,
      settlementMethod: "accounts_payable",
      reason: "کالای معیوب",
      idempotencyKey: "draft-1",
      lines: [
        { itemId: ITEM, quantity: "2", batchId: null, serialId: null, serialNumber: null, purchaseItemId: null },
      ],
    });
  });

  it("requires an explicit settlement — no silent accounts_payable default", () => {
    expect(codeOf(() => parseSupplierReturnBody(validBody({ settlementMethod: undefined })))).toBe(
      "settlement_required",
    );
    expect(codeOf(() => parseSupplierReturnBody(validBody({ settlementMethod: "" })))).toBe(
      "settlement_required",
    );
    expect(codeOf(() => parseSupplierReturnBody(validBody({ settlementMethod: "barter" })))).toBe(
      "settlement_invalid",
    );
  });

  it("requires a stable client idempotency key", () => {
    expect(codeOf(() => parseSupplierReturnBody(validBody({ idempotencyKey: undefined })))).toBe(
      "idempotency_key_required",
    );
    expect(codeOf(() => parseSupplierReturnBody(validBody({ idempotencyKey: "   " })))).toBe(
      "idempotency_key_required",
    );
  });

  it("requires a trimmed, bounded reason", () => {
    expect(codeOf(() => parseSupplierReturnBody(validBody({ reason: "   " })))).toBe("reason_required");
    expect(codeOf(() => parseSupplierReturnBody(validBody({ reason: "x".repeat(501) })))).toBe(
      "reason_too_long",
    );
    expect(parseSupplierReturnBody(validBody({ reason: "  معیوب  " })).reason).toBe("معیوب");
  });

  it("bounds the lines array", () => {
    expect(codeOf(() => parseSupplierReturnBody(validBody({ lines: [] })))).toBe("lines_required");
    expect(codeOf(() => parseSupplierReturnBody(validBody({ lines: "nope" })))).toBe("lines_required");
    expect(
      codeOf(() =>
        parseSupplierReturnBody(
          validBody({ lines: Array.from({ length: MAX_RETURN_LINES + 1 }, () => ({ itemId: ITEM, quantity: "1" })) }),
        ),
      ),
    ).toBe("too_many_lines");
  });

  it("canonicalizes quantities and enforces scale", () => {
    expect(parseSupplierReturnBody(validBody({ lines: [{ itemId: ITEM, quantity: "2.50" }] })).lines[0].quantity).toBe(
      "2.5",
    );
    expect(codeOf(() => parseSupplierReturnBody(validBody({ lines: [{ itemId: ITEM, quantity: "0" }] })))).toBe(
      "quantity_invalid",
    );
    expect(codeOf(() => parseSupplierReturnBody(validBody({ lines: [{ itemId: ITEM, quantity: "-1" }] })))).toBe(
      "quantity_invalid",
    );
    expect(codeOf(() => parseSupplierReturnBody(validBody({ lines: [{ itemId: ITEM, quantity: "۱" }] })))).toBe(
      "quantity_invalid",
    );
    expect(
      codeOf(() => parseSupplierReturnBody(validBody({ lines: [{ itemId: ITEM, quantity: "1.1234567899" }] }))),
    ).toBe("quantity_precision_exceeded");
  });

  it("validates uuids and one tracking path per line", () => {
    expect(codeOf(() => parseSupplierReturnBody(validBody({ purchaseId: "nope" })))).toBe("purchase_not_found");
    expect(codeOf(() => parseSupplierReturnBody(validBody({ lines: [{ itemId: "nope", quantity: "1" }] })))).toBe(
      "invalid_line",
    );
    expect(
      codeOf(() =>
        parseSupplierReturnBody(
          validBody({ lines: [{ itemId: ITEM, quantity: "1", batchId: BATCH, serialNumber: "SN-1" }] }),
        ),
      ),
    ).toBe("invalid_line");
  });

  it("carries HTTP statuses on the error", () => {
    try {
      parseSupplierReturnBody(validBody({ purchaseId: "nope" }));
      expect.unreachable();
    } catch (err) {
      expect((err as RetailReturnError).status).toBe(400);
    }
    expect(new RetailReturnError("idempotency_conflict", 409).status).toBe(409);
    expect(new RetailReturnError("purchase_not_found", 404).message).toContain("خرید");
  });
});

describe("returnRequestFingerprint", () => {
  const base = {
    businessId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    locationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    purchaseId: PURCHASE,
    supplierId: null as string | null,
    settlementMethod: "accounts_payable",
    reason: "کالای معیوب",
    lines: [
      { itemId: ITEM, quantity: "2", batchId: null, serialId: null, serialNumber: null, purchaseItemId: null },
    ],
  };

  it("is stable for identical payloads regardless of line order", () => {
    const secondItem = "55555555-5555-4555-8555-555555555555";
    const a = returnRequestFingerprint({
      ...base,
      lines: [
        { itemId: ITEM, quantity: "2", batchId: null, serialId: null, serialNumber: null, purchaseItemId: null },
        { itemId: secondItem, quantity: "1", batchId: BATCH, serialId: null, serialNumber: null, purchaseItemId: null },
      ],
    });
    const b = returnRequestFingerprint({
      ...base,
      lines: [
        { itemId: secondItem, quantity: "1", batchId: BATCH, serialId: null, serialNumber: null, purchaseItemId: null },
        { itemId: ITEM, quantity: "2", batchId: null, serialId: null, serialNumber: null, purchaseItemId: null },
      ],
    });
    expect(a).toBe(b);
  });

  it("changes when any bound field changes", () => {
    const original = returnRequestFingerprint(base);
    expect(returnRequestFingerprint({ ...base, reason: "علت دیگر" })).not.toBe(original);
    expect(returnRequestFingerprint({ ...base, settlementMethod: "cash" })).not.toBe(original);
    expect(returnRequestFingerprint({ ...base, supplierId: SUPPLIER })).not.toBe(original);
    expect(returnRequestFingerprint({ ...base, purchaseId: null })).not.toBe(original);
    expect(
      returnRequestFingerprint({
        ...base,
        lines: [
          { itemId: ITEM, quantity: "3", batchId: null, serialId: null, serialNumber: null, purchaseItemId: null },
        ],
      }),
    ).not.toBe(original);
  });
});
