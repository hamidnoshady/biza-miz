import { describe, expect, it } from "vitest";
import { parseRetailPurchase, parseRetailReturn, requestKey, retailQuantity, retailRial } from "./retail-purchase-input";
import { purchaseHistoryInput } from "./purchase-history-input";
import { canonicalRequestJson } from "./retail-stock-request";
import { parseToRialText } from "./money";

const id = "00000000-0000-4000-8000-000000000001";
const line = { itemId: id, quantity: "1.25", unitCost: "9007199254740993" };

describe("retail purchase boundary (#915)", () => {
  it("retains exact Rial strings above 2^53 and canonical positive quantities", () => {
    expect(parseRetailPurchase({ lines: [line] }).lines[0]).toMatchObject(line);
    expect(retailQuantity("1.250000000")).toBe("1.25");
    expect(retailRial("9223372036854775807")).toBe("9223372036854775807");
    expect(() => retailRial("9223372036854775808")).toThrow("rial_out_of_range");
    expect(() => retailRial(9007199254740993)).toThrow("invalid_rial");
  });
  it.each([null, [], "purchase", 1, {}, { lines: [null] }, { lines: {} }])("rejects malformed request %j", value => {
    expect(() => parseRetailPurchase(value)).toThrow();
  });
  it.each(["0", "-1", "1e3", "Infinity", "0.0000000001", "1000000000000000"])("rejects quantity %s before SQL", quantity => {
    expect(() => parseRetailPurchase({ lines: [{ ...line, quantity }] })).toThrow();
  });
  it("checks line and aggregate bigint limits without rounding cost inputs", () => {
    expect(() => parseRetailPurchase({ lines: [{ ...line, quantity: "2", unitCost: "9223372036854775807" }] })).toThrow("rial_out_of_range");
    expect(() => parseRetailPurchase({ lines: [1, 2].map(() => ({ ...line, quantity: "1", unitCost: "5000000000000000000" })) })).toThrow("rial_out_of_range");
    expect(() => retailRial("1.5")).toThrow("invalid_rial");
    expect(parseRetailPurchase({ lines: [{ ...line, unitCost: "0" }] }).lines[0].unitCost).toBe("0");
  });
  it("validates UUIDs, real Gregorian dates, serial shape and duplicate serials across invoice lines", () => {
    expect(() => parseRetailPurchase({ supplierId: "foreign", lines: [line] })).toThrow("invalid_uuid");
    expect(() => parseRetailPurchase({ lines: [{ ...line, expiryDate: "2026-02-30" }] })).toThrow("invalid_date");
    expect(() => parseRetailPurchase({ lines: [{ ...line, serials: {} }] })).toThrow("invalid_serials");
    expect(() => parseRetailPurchase({ lines: [1, 2].map(() => ({ ...line, serials: [{ serialNumber: " S1 " }] })) })).toThrow("duplicate_serial");
    expect(() => parseRetailReturn({ reason: "broken", purchaseId: "bad", lines: [line] })).toThrow("invalid_uuid");
    expect(() => parseRetailReturn({ reason: "broken", settlementMethod: "other", lines: [line] })).toThrow("invalid_settlement_method");
  });
  it("requires a stable bounded request key and canonicalizes object key order only", () => {
    expect(() => requestKey(undefined)).toThrow("invalid_idempotency_key");
    expect(() => requestKey(" ")).toThrow("invalid_idempotency_key");
    expect(() => requestKey("x".repeat(201))).toThrow("invalid_idempotency_key");
    expect(canonicalRequestJson({ b: 2, a: [{ y: 1, x: "2" }] })).toBe(canonicalRequestJson({ a: [{ x: "2", y: 1 }], b: 2 }));
    expect(canonicalRequestJson([1, 2])).not.toBe(canonicalRequestJson([2, 1]));
  });
  it("converts Toman/Rial by bigint without silently accepting fractional monetary input", () => {
    expect(parseToRialText("۹۰۰۷۱۹۹۲۵۴۷۴۰۹۹۳", "rial")).toBe("9007199254740993");
    expect(parseToRialText("9007199254740993", "toman")).toBe("90071992547409930");
    expect(() => parseToRialText("1.5", "toman")).toThrow();
  });
  it("validates paginated history filters before date/UUID casts", () => {
    const filters = (query: string) => purchaseHistoryInput(new URLSearchParams(query), ["draft", "received"]);
    expect(filters("page=3&dateFrom=2026-10-01")).toMatchObject({ page: 3, offset: 50, dateFrom: "2026-10-01" });
    for (const query of ["page=0", "page=1e2", "page=1000000", "supplierId=bad", "dateFrom=2026-02-30", "dateFrom=2026-10-02&dateTo=2026-10-01", "status=unknown"]) {
      expect(() => filters(query)).toThrow();
    }
  });
});
