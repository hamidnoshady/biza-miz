/**
 * A shelf label, loaded server-side from the barcode it prints (issue #815:
 * server-side loading of persisted documents; F8: labels in the unified
 * pipeline).
 *
 * The database is mocked and the SQL is inspected, because what matters here
 * is exactly what the label is a function of:
 *
 *  - the item is looked up IN THE BRANCH, so another branch's item is not
 *    found (and neither is a code that belongs to someone else's item);
 *  - the code is the branch's own barcode row — the bars on the paper are the
 *    bars the scanner will read back;
 *  - the field set is the trade's (`labelFieldsForTrade`), formatted in the
 *    business's money unit, or the item's unit for an inventory row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import * as identity from "./identity";
import { getLabelPrintData } from "./label-print-data";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, query: vi.fn() };
});
vi.mock("./identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity")>();
  return { ...actual, loadPrintIdentity: vi.fn() };
});

const ITEM_ID = "2a4e6c81-3d05-4b2f-9a7e-1c3d5f7b9e21";
const BARCODE_ID = "6e82a025-7b49-4f63-9eb2-50719d1f3c65";

interface Answer {
  match: RegExp;
  rows: Record<string, unknown>[];
}

/** A tiny fake query layer: match by SQL shape, answer in order of appearance. */
function dbAnswers(answers: Answer[]) {
  vi.mocked(db.query).mockImplementation((async (sql: string) => {
    const found = answers.find((answer) => answer.match.test(String(sql)));
    return { rows: found?.rows ?? [], rowCount: found?.rows.length ?? 0 };
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(identity.loadPrintIdentity).mockResolvedValue({
    business: { name: "فروشگاه نمونه", address: null, phone: null, footerMessage: null },
    currencyUnit: "toman",
  } as never);
});

describe("an inventory item's label", () => {
  beforeEach(() => {
    dbAnswers([
      // The item lookup is one UNION over both catalogues; which row comes back
      // is what tells the loader which barcode table (and which field set) applies.
      { match: /UNION ALL/, rows: [{ source: "inventory", id: ITEM_ID, name: "آرد", unit: "کیلوگرم", unit_price: null }] },
      { match: /FROM inventory_item_barcodes/, rows: [{ id: BARCODE_ID, code: "2000000000015" }] },
      { match: /FROM businesses/, rows: [{ industry: "food_service" }] },
    ]);
  });

  it("prints the branch's own code with the item's unit", async () => {
    const result = await getLabelPrintData({ businessId: "biz-1", locationId: "loc-1", itemId: ITEM_ID });
    expect(result).toEqual({
      label: {
        businessName: "فروشگاه نمونه",
        itemName: "آرد",
        code: "2000000000015",
        fields: [{ label: "واحد", value: "کیلوگرم" }],
      },
      entityId: BARCODE_ID,
    });
  });

  it("scopes the item lookup to the caller's branch", async () => {
    await getLabelPrintData({ businessId: "biz-1", locationId: "loc-1", itemId: ITEM_ID });
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("i.location_id = $2");
    expect(params).toEqual([ITEM_ID, "loc-1"]);
  });

  it("pins the named code inside the same branch, and refuses a code that is not that item's", async () => {
    dbAnswers([
      { match: /UNION ALL/, rows: [{ source: "inventory", id: ITEM_ID, name: "آرد", unit: "کیلوگرم", unit_price: null }] },
      { match: /FROM inventory_item_barcodes/, rows: [] },
    ]);
    const result = await getLabelPrintData({
      businessId: "biz-1",
      locationId: "loc-1",
      itemId: ITEM_ID,
      code: "2000000000015",
    });
    expect(result).toBeNull();
    const [sql, params] = vi.mocked(db.query).mock.calls[1] as [string, unknown[]];
    expect(String(sql)).toContain("location_id = $1 AND inventory_item_id = $2 AND ($3::text IS NULL OR code = $3)");
    expect(params).toEqual(["loc-1", ITEM_ID, "2000000000015"]);
  });

  it("does not answer for an item of another branch", async () => {
    dbAnswers([{ match: /UNION ALL/, rows: [] }]);
    const result = await getLabelPrintData({ businessId: "biz-1", locationId: "loc-1", itemId: ITEM_ID });
    expect(result).toBeNull();
    // Only the item lookup ran: nothing else is queried once the item is not
    // in this branch.
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe("a retail item's label", () => {
  function retailItem(industry: string) {
    dbAnswers([
      {
        match: /UNION ALL/,
        rows: [{ source: "item", id: ITEM_ID, name: "رژ لب", unit: null, unit_price: "1500000" }],
      },
      { match: /FROM item_barcodes/, rows: [{ id: BARCODE_ID, code: "2000000000015" }] },
      { match: /FROM item_stock/, rows: [{ unit_price: "1500000" }] },
      { match: /FROM item_variant_attributes/, rows: [{ name: "رنگ", value: "قرمز" }] },
      { match: /FROM item_batches/, rows: [{ expiry_date: "2027-03-01" }] },
      { match: /FROM businesses/, rows: [{ industry }] },
    ]);
  }

  it("prints the trade's fields from the item's own stock, attributes and batches", async () => {
    retailItem("cosmetics");
    const result = await getLabelPrintData({ businessId: "biz-1", locationId: "loc-1", itemId: ITEM_ID, code: "2000000000015" });
    expect(result?.label.itemName).toBe("رژ لب");
    expect(result?.label.code).toBe("2000000000015");
    expect(result?.label.fields).toEqual([
      { label: "قیمت", value: "۱۵۰٬۰۰۰" },
      { label: "رنگ", value: "قرمز" },
      { label: "انقضا", value: "۱۴۰۵/۱۲/۱۰" },
    ]);
  });

  it("prints the price in the business's own money unit", async () => {
    retailItem("cosmetics");
    vi.mocked(identity.loadPrintIdentity).mockResolvedValue({
      business: { name: "فروشگاه", address: null, phone: null, footerMessage: null },
      currencyUnit: "rial",
    } as never);
    const result = await getLabelPrintData({ businessId: "biz-1", locationId: "loc-1", itemId: ITEM_ID });
    expect(result?.label.fields?.[0]).toEqual({ label: "قیمت", value: "۱٬۵۰۰٬۰۰۰" });
  });

  it("prints the price alone for an industry with no label vocabulary", async () => {
    retailItem("accessories");
    const result = await getLabelPrintData({ businessId: "biz-1", locationId: "loc-1", itemId: ITEM_ID });
    expect(result?.label.fields).toEqual([{ label: "قیمت", value: "۱۵۰٬۰۰۰" }]);
  });

  it("looks the code up in the retail barcode table, scoped to the branch — never the inventory one", async () => {
    retailItem("cosmetics");
    await getLabelPrintData({ businessId: "biz-1", locationId: "loc-1", itemId: ITEM_ID });
    const barcodeCall = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("FROM item_barcodes"));
    expect(barcodeCall).toBeDefined();
    expect(String(barcodeCall![0])).toContain("location_id = $1 AND item_id = $2");
  });
});
