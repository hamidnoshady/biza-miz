import { describe, expect, it } from "vitest";
import { labelFieldsForTrade, type LabelItem } from "./label-template";
import { labelToPrintDocument } from "./printing/document-bridge";
import { builtInTemplate, renderPrintTemplate } from "./print-template";

const baseItem: LabelItem = { name: "کالای نمونه", price: 1_250_000 };

describe("labelFieldsForTrade", () => {
  it("cosmetics prints price, shade and expiry", () => {
    const fields = labelFieldsForTrade("cosmetics", {
      ...baseItem,
      shade: "قرمز آتشین",
      expiryDate: "2027-03-01",
    });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "رنگ", "انقضا"]);
    expect(fields[0].value).toBe("۱۲۵٬۰۰۰");
  });

  it("jewelry prints price, عیار and وزن", () => {
    const fields = labelFieldsForTrade("jewelry", { ...baseItem, purity: "۱۸", weight: "۱٫۲۳ گرم" });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "عیار", "وزن"]);
    expect(fields[2].value).toBe("۱٫۲۳ گرم");
  });

  it("watch prints price, model and serial", () => {
    const fields = labelFieldsForTrade("watch", { ...baseItem, model: "Seiko 5", serial: "S-1001" });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "مدل", "سریال"]);
  });

  it("accessories prints price and size", () => {
    const fields = labelFieldsForTrade("accessories", { ...baseItem, size: "سایز ۵۵" });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "سایز"]);
  });

  it("omits absent fields instead of printing empty rows", () => {
    const fields = labelFieldsForTrade("cosmetics", { name: "بدون ویژگی" });
    expect(fields).toEqual([]);
  });
});

describe("a label renders through the general template pipeline", () => {
  const label = builtInTemplate("label57x40-label")!;
  const labelHtml = () =>
    renderPrintTemplate(
      label,
      labelToPrintDocument({
        businessName: "فروشگاه نمونه",
        itemName: "رژ لب",
        code: "2000000000015", // minted internal code, valid check digit
        fields: labelFieldsForTrade("cosmetics", { ...baseItem, shade: "قرمز آتشین", expiryDate: "2027-03-01" }),
      }),
    );

  it("carries the branch, the item and the trade's own fields", () => {
    const html = labelHtml();
    expect(html).toContain("فروشگاه نمونه");
    expect(html).toContain("رژ لب");
    for (const field of labelFieldsForTrade("cosmetics", { ...baseItem, shade: "قرمز آتشین", expiryDate: "2027-03-01" })) {
      expect(html).toContain(field.label);
      expect(html).toContain(field.value);
    }
  });

  it("draws real scannable bars (SVG) for a valid EAN-13 code, digits included", () => {
    // Digits alone cannot be read by a laser/CCD scanner — the label must
    // carry actual bars or the scan-driven count never works.
    const html = labelHtml();
    expect(html).toContain("<svg");
    expect(html).toContain("2000000000015");
  });

  it("keeps the text-only block for codes in other shapes", () => {
    const html = renderPrintTemplate(
      label,
      labelToPrintDocument({ businessName: "انبار", itemName: "قلم", code: "ABC-001", fields: [] }),
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain("ABC-001");
  });

  it("escapes markup in an item name or a field value", () => {
    const html = renderPrintTemplate(
      label,
      labelToPrintDocument({
        businessName: "فروشگاه",
        itemName: "<script>alert(1)</script>",
        code: "2000000000015",
        fields: [{ label: "رنگ", value: '<img src="x">' }],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<img src="x">');
  });

  it("prints the label at the label roll's own width", () => {
    expect(labelHtml()).toContain("width: 57mm");
  });
});
