/**
 * The mapping and validation engine.
 *
 * Pure, so it is unit-tested directly rather than only through a route: these
 * are the rules that decide what a spreadsheet cell becomes, and getting one
 * of them wrong is how a phone number ends up in a name column three thousand
 * times.
 */
import { describe, expect, it } from "vitest";
import {
  applyTransform,
  coerceValue,
  missingRequiredFields,
  parseDateText,
  parseNumeric,
  sheetFromRows,
  suggestMapping,
  unmappedColumns,
  validateSheet,
  validateValue,
} from "./mapping";
import { requireEntity } from "./registry";
import type { EntityDefinition, EntityField, ParsedSheet } from "./types";

const customers = requireEntity("crm.customers");
const products = requireEntity("pos.products");

function field(key: string, entity: EntityDefinition = customers): EntityField {
  return entity.fields.find((candidate) => candidate.key === key)!;
}

describe("sheetFromRows", () => {
  it("splits the header from the body and pads short rows", () => {
    // A ragged CSV is the norm, not the exception: trailing empty cells are
    // routinely omitted by whatever wrote the file.
    expect(sheetFromRows([["a", "b", "c"], ["1"], ["1", "2", "3"]])).toEqual({
      columns: ["a", "b", "c"],
      rows: [
        ["1", "", ""],
        ["1", "2", "3"],
      ],
    });
  });

  it("trims header cells, which Excel pads constantly", () => {
    expect(sheetFromRows([[" نام ", "تلفن"]]).columns).toEqual(["نام", "تلفن"]);
  });
});

describe("suggestMapping", () => {
  it("matches a field by its own label", () => {
    const sheet: ParsedSheet = { columns: ["نام", "تلفن"], rows: [] };
    const mapping = suggestMapping(customers, sheet);
    expect(mapping.columns).toContainEqual({ field: "name", column: 0, transform: "none" });
    expect(mapping.columns).toContainEqual({ field: "phone", column: 1, transform: "none" });
  });

  it("matches an alias, in either language", () => {
    const sheet: ParsedSheet = { columns: ["Full Name", "موبایل", "e-mail"], rows: [] };
    const mapping = suggestMapping(customers, sheet);
    const byField = new Map(mapping.columns.map((column) => [column.field, column.column]));
    expect(byField.get("name")).toBe(0);
    expect(byField.get("phone")).toBe(1);
    expect(byField.get("email")).toBe(2);
  });

  it("claims each column at most once", () => {
    // «نام» and «نام کوچک» are both name-ish; the stronger (exact) match wins
    // the column and the weaker field is left unmapped rather than doubled up.
    const sheet: ParsedSheet = { columns: ["نام"], rows: [] };
    const mapping = suggestMapping(customers, sheet);
    const columns = mapping.columns.map((column) => column.column);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it("finds a field inside a longer header", () => {
    const sheet: ParsedSheet = { columns: ["شماره تماس مشتری"], rows: [] };
    const mapping = suggestMapping(customers, sheet);
    expect(mapping.columns.some((column) => column.field === "phone")).toBe(true);
  });

  it("never maps a read-only field", () => {
    const sheet: ParsedSheet = { columns: ["شناسه", "نام"], rows: [] };
    const mapping = suggestMapping(customers, sheet);
    expect(mapping.columns.some((column) => column.field === "id")).toBe(false);
  });

  it("leaves a column unmapped rather than guessing", () => {
    const sheet: ParsedSheet = { columns: ["نام", "یک ستون بی‌ربط"], rows: [] };
    const mapping = suggestMapping(customers, sheet);
    expect(unmappedColumns(sheet, mapping)).toEqual(["یک ستون بی‌ربط"]);
  });
});

describe("missingRequiredFields", () => {
  it("names a required field with no column", () => {
    expect(missingRequiredFields(products, { columns: [] })).toEqual(
      expect.arrayContaining(["نام آیتم", "دسته", "قیمت"]),
    );
  });

  it("accepts a constant in place of a column", () => {
    // "every row in this file is in the 'نوشیدنی' category" is a real and
    // common intention, and a constant expresses it without editing the file.
    const missing = missingRequiredFields(products, {
      columns: [
        { field: "name", column: 0 },
        { field: "categoryName", column: -1, constant: "نوشیدنی" },
        { field: "price", column: 1 },
      ],
    });
    expect(missing).toEqual([]);
  });

  it("does not count a blank constant as filled", () => {
    const missing = missingRequiredFields(products, {
      columns: [{ field: "name", column: -1, constant: "   " }],
    });
    expect(missing).toContain("نام آیتم");
  });
});

describe("applyTransform", () => {
  it("normalises digits both ways", () => {
    expect(applyTransform("۰۹۱۲", "digits")).toBe("0912");
    expect(applyTransform("0912", "persian_digits")).toBe("۰۹۱۲");
  });

  it("converts money units", () => {
    expect(applyTransform("8500", "toman_to_rial")).toBe("85000");
    expect(applyTransform("85000", "rial_to_toman")).toBe("8500");
  });

  it("leaves a non-numeric cell alone rather than producing NaN", () => {
    expect(applyTransform("ندارد", "toman_to_rial")).toBe("ندارد");
  });

  it("converts a percentage to a fraction", () => {
    expect(applyTransform("۹٪", "percent_to_fraction")).toBe("0.09");
  });

  it("reads Persian yes/no", () => {
    expect(applyTransform("بله", "boolean_yes_no")).toBe("true");
    expect(applyTransform("خیر", "boolean_yes_no")).toBe("false");
  });

  it("strips spaces, including the zero-width non-joiner", () => {
    expect(applyTransform("۰۹۱۲ ۱۱۱ ۲۲۳۳", "strip_spaces")).toBe("۰۹۱۲۱۱۱۲۲۳۳");
  });
});

describe("parseNumeric", () => {
  it("reads Persian digits and thousands separators", () => {
    expect(parseNumeric("۱۲۰٬۰۰۰")).toBe(120_000);
    expect(parseNumeric("1,200,000")).toBe(1_200_000);
  });

  it("reads a decimal written with the Arabic decimal separator", () => {
    expect(parseNumeric("۱٫۵")).toBe(1.5);
  });

  it("answers null rather than NaN for junk", () => {
    // The distinction that matters: null forces the caller to produce a
    // message; NaN would reach the database.
    expect(parseNumeric("ندارد")).toBeNull();
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("-")).toBeNull();
  });
});

describe("parseDateText", () => {
  it("reads a Shamsi date, which is what a Persian spreadsheet holds", () => {
    expect(parseDateText("1403/05/12")).toBe("2024-08-02");
    expect(parseDateText("۱۴۰۳/۰۵/۱۲")).toBe("2024-08-02");
    expect(parseDateText("1403-05-12")).toBe("2024-08-02");
  });

  it("reads a Gregorian date, told apart by its four-digit year", () => {
    expect(parseDateText("2024-08-02")).toBe("2024-08-02");
  });

  it("rejects an impossible date rather than rolling it over", () => {
    expect(parseDateText("1403/13/01")).toBeNull();
    expect(parseDateText("2024-02-31")).toBeNull();
  });

  it("answers null for text that is not a date", () => {
    expect(parseDateText("به‌زودی")).toBeNull();
    expect(parseDateText("")).toBeNull();
  });
});

describe("coerceValue", () => {
  const options = { moneyUnit: "toman" as const };

  it("treats an empty cell as absent, not as an error", () => {
    expect(coerceValue(field("email"), "  ", options)).toEqual({ value: null, message: null });
  });

  it("converts money into integer Rial using the file's unit", () => {
    const money = field("price", products);
    expect(coerceValue(money, "8500", { moneyUnit: "toman" }).value).toBe(85_000);
    expect(coerceValue(money, "85000", { moneyUnit: "rial" }).value).toBe(85_000);
  });

  it("refuses negative money", () => {
    const result = coerceValue(field("price", products), "-5", options);
    expect(result.value).toBeNull();
    expect(result.message?.severity).toBe("error");
  });

  /*
   * `validation.integral` is the engine's opt-out from its own rounding. A price
   * list may legitimately arrive as ۱۵۰/۷ تومان and be stored as a whole Rial; a
   * ledger row may not, because ۱۵۰/۵ rounded to ۱۵۰۸ is a posting that
   * reconciles with no document. The expense entity turns it on for `amount` and
   * `vatAmount`, so the refusal is per column and named in that column's words.
   */
  it("refuses a fraction where the field stores exact Rial, and rounds where it does not", () => {
    const expenses = requireEntity("accounting.expenses");
    const amount = expenses.fields.find((f) => f.key === "amount")!;
    const price = field("price", products);
    expect(amount.validation?.integral).toBe(true);

    // ۱۵۰/۷۵ تومان → 1507.5 rial: unrepresentable, so the row says so.
    const fraction = coerceValue(amount, "150.75", { moneyUnit: "toman" });
    expect(fraction.value).toBeNull();
    expect(fraction.message?.message).toContain("صحیح ریال");

    // The same cell on an ordinary money field keeps the old, deliberate rounding.
    expect(coerceValue(price, "150.75", { moneyUnit: "toman" }).value).toBe(1508);
  });

  it("accepts the float residue of a Toman conversion as the whole Rial it is", () => {
    const amount = requireEntity("accounting.expenses").fields.find((f) => f.key === "amount")!;
    // ۱۵۰/۷ تومان really is 1507 rial; ×10 only makes the binary representation
    // untidy. Refusing that would refuse arithmetic, not money.
    expect(coerceValue(amount, "150.7", { moneyUnit: "toman" }).value).toBe(1507);
    expect(coerceValue(amount, "1507", { moneyUnit: "rial" }).value).toBe(1507);
  });

  it("keeps VAT in whole Rial too, and lets an empty cell mean no VAT", () => {
    const vat = requireEntity("accounting.expenses").fields.find((f) => f.key === "vatAmount")!;
    expect(vat.validation?.integral).toBe(true);
    expect(coerceValue(vat, "", { moneyUnit: "rial" })).toEqual({ value: null, message: null });
    expect(coerceValue(vat, "21000", { moneyUnit: "rial" }).value).toBe(21000);
    expect(coerceValue(vat, "2100.5", { moneyUnit: "rial" }).message?.severity).toBe("error");
  });

  it("validates an email and lower-cases it", () => {
    expect(coerceValue(field("email"), " Ali@Example.COM ", options).value).toBe(
      "ali@example.com",
    );
    expect(coerceValue(field("email"), "not-an-email", options).message).toBeTruthy();
  });

  it("normalises a phone number's digits and punctuation", () => {
    expect(coerceValue(field("phone"), "۰۹۱۲ ۱۱۱-۲۲۳۳", options).value).toBe("09121112233");
    expect(coerceValue(field("phone"), "abc", options).message).toBeTruthy();
  });

  it("matches an enum by value or by Persian label", () => {
    const status = requireEntity("workspace.projects").fields.find((f) => f.key === "status")!;
    expect(coerceValue(status, "active", options).value).toBe("active");
    expect(coerceValue(status, "در حال اجرا", options).value).toBe("active");
    const bad = coerceValue(status, "چیز دیگری", options);
    expect(bad.message?.message).toContain("یکی از این مقادیر");
  });

  it("splits tags on any of the separators a person might use", () => {
    const tags = field("tags");
    expect(coerceValue(tags, "وفادار، جدید; VIP", options).value).toEqual([
      "وفادار",
      "جدید",
      "VIP",
    ]);
  });

  it("reads a boolean written in Persian", () => {
    const active = field("isActive");
    expect(coerceValue(active, "بله", options).value).toBe(true);
    expect(coerceValue(active, "خیر", options).value).toBe(false);
    expect(coerceValue(active, "شاید", options).message).toBeTruthy();
  });
});

describe("validateValue", () => {
  it("enforces a pattern with its own Persian message", () => {
    const nationalId = field("nationalId");
    expect(validateValue(nationalId, "1234567890")).toEqual([]);
    const messages = validateValue(nationalId, "123");
    expect(messages[0].message).toContain("۱۰ رقم");
  });

  it("enforces a numeric range", () => {
    const probability = requireEntity("crm.deals").fields.find((f) => f.key === "probability")!;
    expect(validateValue(probability, 50)).toEqual([]);
    expect(validateValue(probability, 150)).toHaveLength(1);
  });

  it("enforces a maximum length", () => {
    expect(validateValue(field("name"), "x".repeat(201))).toHaveLength(1);
  });
});

describe("validateSheet", () => {
  const mapping = {
    columns: [
      { field: "name", column: 0 },
      { field: "phone", column: 1 },
    ],
  };

  it("marks a complete row valid with no messages", () => {
    const sheet = sheetFromRows([
      ["نام", "تلفن"],
      ["علی رضایی", "09121112233"],
    ]);
    const [row] = validateSheet(customers, sheet, mapping);
    expect(row.valid).toBe(true);
    expect(row.messages).toEqual([]);
    expect(row.values).toEqual({ name: "علی رضایی", phone: "09121112233" });
  });

  it("numbers rows the way the spreadsheet does, header included", () => {
    const sheet = sheetFromRows([
      ["نام", "تلفن"],
      ["علی", "09121112233"],
      ["مریم", "09121112244"],
    ]);
    expect(validateSheet(customers, sheet, mapping).map((row) => row.rowNumber)).toEqual([2, 3]);
  });

  it("reports a missing required value as an error", () => {
    const sheet = sheetFromRows([
      ["نام", "تلفن"],
      ["", "09121112233"],
    ]);
    const [row] = validateSheet(customers, sheet, mapping);
    expect(row.valid).toBe(false);
    expect(row.messages[0].message).toContain("الزامی");
  });

  it("catches a duplicate inside the file and names the earlier row", () => {
    const sheet = sheetFromRows([
      ["نام", "تلفن"],
      ["علی", "09121112233"],
      ["علی رضایی", "09121112233"],
    ]);
    const rows = validateSheet(customers, sheet, mapping, { duplicateRule: "phone" });
    expect(rows[0].valid).toBe(true);
    expect(rows[1].valid).toBe(false);
    expect(rows[1].messages[0].message).toContain("سطر 2");
  });

  it("keeps the operator's raw cells for the error report", () => {
    const sheet = sheetFromRows([
      ["نام", "تلفن"],
      ["علی", "نامعتبر"],
    ]);
    const [row] = validateSheet(customers, sheet, mapping);
    // Their text, not our interpretation of it — that is what makes the
    // failed-row CSV something they can fix and re-upload.
    expect(row.raw).toEqual({ نام: "علی", تلفن: "نامعتبر" });
  });

  it("applies a per-column transform before coercing", () => {
    const sheet = sheetFromRows([
      ["نام", "تلفن"],
      ["علی", "۰۹۱۲ ۱۱۱ ۲۲۳۳"],
    ]);
    const [row] = validateSheet(customers, sheet, {
      columns: [
        { field: "name", column: 0 },
        { field: "phone", column: 1, transform: "strip_spaces" },
      ],
    });
    expect(row.values.phone).toBe("09121112233");
  });

  it("fills a field from a constant on every row", () => {
    const sheet = sheetFromRows([
      ["نام"],
      ["اسپرسو"],
      ["لاته"],
    ]);
    const rows = validateSheet(products, sheet, {
      columns: [
        { field: "name", column: 0 },
        { field: "categoryName", column: -1, constant: "نوشیدنی گرم" },
        { field: "price", column: -1, constant: "0" },
      ],
    });
    expect(rows.every((row) => row.values.categoryName === "نوشیدنی گرم")).toBe(true);
  });

  it("ignores a column mapped to a read-only field", () => {
    const sheet = sheetFromRows([
      ["شناسه", "نام"],
      ["999", "علی"],
    ]);
    const [row] = validateSheet(customers, sheet, {
      columns: [
        { field: "id", column: 0 },
        { field: "name", column: 1 },
      ],
    });
    expect(row.values.id).toBeUndefined();
  });
});
