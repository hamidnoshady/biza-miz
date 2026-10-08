import { describe, expect, it } from "vitest";
import {
  buildProductsCsv,
  isVariantParent,
  normalizeListSearch,
  pageWindow,
  productKpis,
  productStatus,
  variantMatchesNeedle,
  variantMatchesStatusFilter,
  variantSearchNeedles,
  type ProductListRow,
} from "./product-list";

const row: ProductListRow = {
  name: "انگشتر استیل آبی",
  parentName: "انگشتر استیل",
  sku: "1014",
  barcode: "62600101401",
  unit: "عدد",
  kind: "variant_child",
  quantity: "5.000000000",
  unitPrice: 530000,
  unitCost: 250000,
  isSellable: true,
};

const family: ProductListRow = {
  ...row,
  name: "انگشتر استیل",
  parentName: null,
  barcode: null,
  unit: null,
  kind: "variant_parent",
  quantity: "0.000000000",
  unitPrice: null,
  unitCost: null,
};

/** A sellable variant with nothing on the shelf. */
const outOfStock: ProductListRow = {
  ...row,
  name: "انگشتر استیل قرمز",
  sku: "1015",
  quantity: "0.000000000",
};

/** A variant flagged out of the catalogue's sale, whatever its shelf says. */
const nonSellable: ProductListRow = {
  ...row,
  name: "انگشتر استیل طلایی",
  sku: "1016",
  quantity: "3.000000000",
  isSellable: false,
};

describe("normalizeListSearch", () => {
  it("folds Persian and Arabic-Indic digits to ASCII", () => {
    expect(normalizeListSearch("۱۰۱۴")).toBe("1014");
    expect(normalizeListSearch("١٠١٤")).toBe("1014");
  });

  it("lowercases and trims", () => {
    expect(normalizeListSearch("  ABC ")).toBe("abc");
  });
});

describe("variant search", () => {
  const needles = variantSearchNeedles(row);

  it("matches a SKU typed with Persian digits", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("۱۰۱"))).toBe(true);
  });

  it("matches a Latin prefix of the barcode", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("62600"))).toBe(true);
  });

  it("matches the family name", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("استیل"))).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("ساعت"))).toBe(false);
  });

  it("drops empty fields so an all-empty haystack never matches", () => {
    const empty: ProductListRow = { ...row, name: "", parentName: null, sku: null, barcode: null };
    expect(variantMatchesNeedle(variantSearchNeedles(empty), normalizeListSearch("x"))).toBe(false);
  });
});

describe("productStatus", () => {
  it("marks a variant_parent as a family, never as out of stock", () => {
    expect(productStatus(family)).toBe("family");
    // Even a family row with a nonsensical non-sellable flag stays a family:
    // the flag belongs to its variants, not to the grouping row.
    expect(productStatus({ ...family, isSellable: false, quantity: "0" })).toBe("family");
  });

  it("splits sellable variants by their shelf quantity", () => {
    expect(productStatus(row)).toBe("in_stock");
    expect(productStatus(outOfStock)).toBe("out_of_stock");
    expect(productStatus({ ...row, quantity: "-2" })).toBe("out_of_stock");
    expect(productStatus({ ...row, quantity: "2.5" })).toBe("in_stock");
  });

  it("treats an unreadable quantity as out of stock rather than crashing", () => {
    expect(productStatus({ ...row, quantity: "n/a" })).toBe("out_of_stock");
  });

  it("puts a non-sellable variant out of the sale statuses even with stock", () => {
    expect(productStatus(nonSellable)).toBe("non_sellable");
  });
});

describe("variantMatchesStatusFilter", () => {
  const catalogue = [family, row, outOfStock, nonSellable];

  it("keeps every row under «همه وضعیت‌ها»", () => {
    expect(catalogue.filter((entry) => variantMatchesStatusFilter(entry, "all"))).toHaveLength(4);
  });

  it("keeps only sellable variants with stock under «موجود»", () => {
    const kept = catalogue.filter((entry) => variantMatchesStatusFilter(entry, "in_stock"));
    expect(kept).toEqual([row]);
  });

  it("keeps only sellable variants without stock under «ناموجود»", () => {
    const kept = catalogue.filter((entry) => variantMatchesStatusFilter(entry, "out_of_stock"));
    expect(kept).toEqual([outOfStock]);
  });

  it("keeps only non-sellable variants under «غیر قابل فروش»", () => {
    const kept = catalogue.filter((entry) => variantMatchesStatusFilter(entry, "non_sellable"));
    expect(kept).toEqual([nonSellable]);
  });

  it("never lets a family row into a stock filter (it is not a shelf SKU)", () => {
    for (const filter of ["in_stock", "out_of_stock", "non_sellable"] as const) {
      expect(variantMatchesStatusFilter(family, filter)).toBe(false);
    }
  });

  it("combines with search the way the list does (Gliss + موجود)", () => {
    const glissInStock: ProductListRow = { ...row, name: "شامپو Gliss Repair", parentName: "Gliss", quantity: "8" };
    const glissOut: ProductListRow = { ...glissInStock, name: "شامپو Gliss Color", sku: "1017", quantity: "0" };
    const catalogue = [glissInStock, glissOut, family];
    const needle = normalizeListSearch("Gliss");
    const kept = catalogue.filter(
      (entry) => variantMatchesNeedle(variantSearchNeedles(entry), needle) && variantMatchesStatusFilter(entry, "in_stock"),
    );
    expect(kept).toEqual([glissInStock]);
  });
});

describe("productKpis", () => {
  it("counts the catalogue the KPI row shows it", () => {
    const kpis = productKpis([family, row, outOfStock, nonSellable, { ...row, sku: "1018" }]);
    expect(kpis).toEqual({ total: 5, inStock: 2, outOfStock: 1, nonSellable: 1 });
  });

  it("does not count family rows as out of stock", () => {
    const kpis = productKpis([family, { ...family, name: "ساعت دیواری" }]);
    expect(kpis).toEqual({ total: 2, inStock: 0, outOfStock: 0, nonSellable: 0 });
  });

  it("counts an empty catalogue as zero everywhere", () => {
    expect(productKpis([])).toEqual({ total: 0, inStock: 0, outOfStock: 0, nonSellable: 0 });
  });
});

describe("pageWindow", () => {
  it("draws nothing when there is no page to draw", () => {
    expect(pageWindow(1, 0)).toEqual([]);
    expect(pageWindow(1, -3)).toEqual([]);
  });

  it("draws every page while they fit in the window", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("anchors the window at the start around the first pages", () => {
    expect(pageWindow(1, 13)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(2, 13)).toEqual([1, 2, 3, 4, 5]);
  });

  it("centres the window around a middle page", () => {
    expect(pageWindow(7, 13)).toEqual([5, 6, 7, 8, 9]);
  });

  it("anchors the window at the end around the last pages", () => {
    expect(pageWindow(13, 13)).toEqual([9, 10, 11, 12, 13]);
    expect(pageWindow(12, 13)).toEqual([9, 10, 11, 12, 13]);
  });

  it("clamps an out-of-range current page instead of drawing past the end", () => {
    expect(pageWindow(0, 13)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(99, 13)).toEqual([9, 10, 11, 12, 13]);
  });

  it("never draws more buttons than the visible maximum", () => {
    for (let page = 1; page <= 40; page++) {
      expect(pageWindow(page, 40).length).toBeLessThanOrEqual(5);
    }
  });
});

describe("buildProductsCsv", () => {
  const csv = buildProductsCsv([family, row]);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");

  it("starts with a UTF-8 BOM and a quoted header", () => {
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(lines[0]).toBe('"نام","خانواده","کد کالا","بارکد","واحد","موجودی","قیمت فروش (ریال)","قیمت خرید (ریال)"');
  });

  it("emits a data row with Latin digits: trimmed quantity and raw integer Rial prices", () => {
    expect(lines[2]).toBe('"انگشتر استیل آبی","انگشتر استیل","1014","62600101401","عدد","5","530000","250000"');
  });

  it("leaves a family row's stock and price cells empty instead of exporting fake zeros", () => {
    expect(lines[1]).toBe('"انگشتر استیل","","1014","","","","",""');
  });

  it("never Persian-formats any digit in the file (display is not data)", () => {
    expect(csv).not.toMatch(/[۰-۹٠-٩]/);
  });

  it("doubles embedded quotes", () => {
    const quoted = buildProductsCsv([{ ...row, name: 'حلقه "ویژه"' }]);
    expect(quoted).toContain('"حلقه ""ویژه"""');
  });

  it("speaks the business's selected unit and says so in the header", () => {
    const toman = buildProductsCsv([family, row], "toman").replace(/^﻿/, "").split("\r\n");
    expect(toman[0]).toBe('"نام","خانواده","کد کالا","بارکد","واحد","موجودی","قیمت فروش (تومان)","قیمت خرید (تومان)"');
    expect(toman[2]).toBe('"انگشتر استیل آبی","انگشتر استیل","1014","62600101401","عدد","5","53000","25000"');
  });

  it("neutralises a formula-looking name so Excel does not execute it", () => {
    const csv = buildProductsCsv([{ ...row, name: "=HYPERLINK(\"http://x\")", sku: "+1" }]);
    expect(csv).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(csv).toContain('"\'+1"');
  });

  it("is not fooled into treating a variant child as the family row", () => {
    expect(isVariantParent(row)).toBe(false);
    expect(isVariantParent(family)).toBe(true);
  });
});
